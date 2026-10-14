import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { createLiftbayClient, LiftbayApiError } from "@liftbay/sdk";
import pc from "picocolors";
import { cancelled } from "./link.ts";
import { apiUrl, clearCredentials, client, cmd, CONFIG_DIR, dashboardUrl, fail, isInteractive, isTransient, readCredentials, saveCredentials, unwrap } from "../context.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // No browser available (SSH, CI): the URL is printed anyway.
  }
}

type PendingLogin = { apiUrl: string; dashboardUrl: string; deviceCode: string; userCode: string; url: string; expiresAt: string; interval: number };
const PENDING = join(CONFIG_DIR, "pending-login.json");

function readPending(api: string): PendingLogin | null {
  try {
    const pending = JSON.parse(readFileSync(PENDING, "utf8")) as PendingLogin;
    return pending.apiUrl === api && Date.parse(pending.expiresAt) > Date.now() + 5000 ? pending : null;
  } catch {
    return null;
  }
}

const clearPending = () => rmSync(PENDING, { force: true });

/**
 * Device authorization flow: approve in the browser, the CLI gets its own session token. `--no-wait` starts
 * the request and exits (for agents, whose commands can't block for minutes); the next `liftbay login`
 * picks up that same request and waits for the approval.
 */
type LoginOptions = { apiUrl?: string; dashboardUrl?: string; open?: boolean; wait?: boolean; email?: string; code?: string };

/**
 * Signing in with a code sent by email, all in the terminal: the way for agents, and for anyone without a
 * browser at hand. `--email` sends the code; with `--code` too, it signs in (creating the account the first
 * time). In a terminal, one `--email` run asks for the code itself.
 */
async function loginWithEmail(opts: LoginOptions, api: string, dashboard: string) {
  const anon = createLiftbayClient({ baseUrl: api });
  const email = opts.email!.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(`"${email}" isn't an email address`);
  let code: string | undefined = opts.code?.replace(/\s/g, "");
  if (!code) {
    await unwrap(anon.POST("/v1/auth/email/start", { body: { email } }));
    if (!isInteractive()) {
      p.log.info(`Sent a 6-digit sign-in code to ${pc.bold(email)}.`);
      return {
        status: "code_sent",
        email,
        next: `Ask the person for the 6-digit code from the email, then run: liftbay login --email ${email} --code <code>`,
      };
    }
    p.log.info(`Sent a 6-digit code to ${pc.bold(email)}. ${pc.dim("New to Liftbay? Signing in creates your account.")}`);
    code = cancelled(await p.text({ message: "Code from the email", validate: (v) => (/^\d{6}$/.test((v ?? "").replace(/\s/g, "")) ? undefined : "Enter the 6-digit code") })).replace(/\s/g, "");
  }
  const res = await unwrap(anon.POST("/v1/auth/email/token", { body: { email, code: code! } }));
  clearPending();
  saveCredentials({ apiUrl: api, dashboardUrl: dashboard, token: res.token, email: res.user.email });
  p.log.success(`Signed in as ${pc.bold(res.user.email)}`);
  return { status: "signed_in", user: res.user };
}

export async function login(opts: LoginOptions) {
  const api = opts.apiUrl ?? apiUrl();
  const dashboard = opts.dashboardUrl ?? dashboardUrl();
  if (opts.code && !opts.email) fail("Pass --email with --code");
  if (opts.email) return loginWithEmail(opts, api, dashboard);
  // A person at a terminal picks: the browser (Google, GitHub or email there) or a code by email right here.
  if (isInteractive() && !readPending(api)) {
    const how = cancelled(
      await p.select({
        message: "How do you want to sign in?",
        options: [
          { value: "browser", label: "In the browser", hint: "Google, GitHub or email" },
          { value: "email", label: "With a code sent to my email", hint: "all in this terminal" },
        ],
      }),
    );
    if (how === "email") {
      const email = cancelled(await p.text({ message: "Email", validate: (v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((v ?? "").trim()) ? undefined : "Enter your email address") }));
      return loginWithEmail({ ...opts, email }, api, dashboard);
    }
  }
  const anon = createLiftbayClient({ baseUrl: api });

  let pending = readPending(api);
  if (!pending) {
    const start = await unwrap(anon.POST("/v1/auth/device", { body: { clientName: `Liftbay CLI on ${process.platform}` } }));
    pending = {
      apiUrl: api,
      dashboardUrl: dashboard,
      deviceCode: start.deviceCode,
      userCode: start.userCode,
      url: start.verificationUriComplete,
      expiresAt: new Date(Date.now() + start.expiresIn * 1000).toISOString(),
      interval: start.interval,
    };
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(PENDING, JSON.stringify(pending), { mode: 0o600 });
    if (opts.open !== false) openBrowser(pending.url);
  }

  p.note(`${pc.bold(pending.userCode)}\n\n${pc.dim("Confirm this code in your browser:")}\n${pending.url}`, "Sign in");
  if (opts.wait === false) {
    p.log.info(`Approve it in the browser, then run ${pc.cyan(cmd("liftbay login"))} again to finish.`);
    return { status: "pending", userCode: pending.userCode, url: pending.url, expiresAt: pending.expiresAt, next: "Approve in the browser, then run `liftbay login` to finish signing in" };
  }

  const spin = p.spinner();
  spin.start("Waiting for approval in the browser");
  while (Date.now() < Date.parse(pending.expiresAt)) {
    try {
      const res = await unwrap(anon.POST("/v1/auth/device/token", { body: { deviceCode: pending.deviceCode } }));
      clearPending();
      saveCredentials({ apiUrl: api, dashboardUrl: pending.dashboardUrl, token: res.token, email: res.user.email });
      spin.stop(`Signed in as ${pc.bold(res.user.email)}`);
      return { status: "signed_in", user: res.user };
    } catch (e) {
      if ((e instanceof LiftbayApiError && e.code === "authorization_pending") || isTransient(e)) {
        await sleep(pending.interval * 1000);
        continue;
      }
      clearPending();
      spin.stop("Sign-in failed");
      throw e;
    }
  }
  clearPending();
  spin.stop("Timed out");
  fail("Sign-in request expired. Run `liftbay login` again.");
}

export async function logout() {
  const creds = readCredentials();
  if (!creds) {
    p.log.info("Not signed in.");
    return { signedOut: null };
  }
  await client().POST("/v1/auth/logout").catch(() => undefined);
  clearCredentials();
  p.log.success(`Signed out ${creds.email}`);
  return { signedOut: creds.email };
}

export async function whoami() {
  if (process.env.LIFTBAY_TOKEN?.startsWith("lbt_")) {
    const orgs = await unwrap(client().GET("/v1/orgs"));
    console.log(`Organization API token for ${orgs.map((o) => o.slug).join(", ")}`);
    return { kind: "org_token", orgs: orgs.map((o) => ({ slug: o.slug, name: o.name })) };
  }
  const me = await unwrap(client().GET("/v1/auth/me"));
  console.log(`${pc.bold(me.user.email)}${me.user.name ? ` (${me.user.name})` : ""}`);
  for (const m of me.memberships) console.log(`  ${m.orgSlug.padEnd(24)} ${pc.dim(m.role)}`);
  return { kind: "user", user: me.user, memberships: me.memberships };
}

/** Signs in first if there's no usable token (used by the init wizards). */
export async function ensureSignedIn(opts: { apiUrl?: string; dashboardUrl?: string }) {
  if (process.env.LIFTBAY_TOKEN || readCredentials()) {
    try {
      if (process.env.LIFTBAY_TOKEN) return;
      const me = await unwrap(client().GET("/v1/auth/me"));
      p.log.success(`Signed in as ${pc.bold(me.user.email)}`);
      return;
    } catch (e) {
      if (!(e instanceof LiftbayApiError && e.status === 401)) throw e;
    }
  }
  // Nobody to approve it here: an agent signs in with `login --no-wait`, then `login`, before running this again.
  if (!isInteractive()) {
    fail("Not signed in. Sign in with an email code: `liftbay login --email <address>`, then `liftbay login --email <address> --code <code>` (or approve in the browser: `liftbay login --no-wait`, then `liftbay login`; or set LIFTBAY_TOKEN). Then run this again.");
  }
  await login(opts);
}
