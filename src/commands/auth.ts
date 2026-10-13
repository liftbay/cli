import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { createLiftbayClient, LiftbayApiError } from "@liftbay/sdk";
import pc from "picocolors";
import { apiUrl, CONFIG_DIR, clearCredentials, client, dashboardUrl, fail, isInteractive, readCredentials, saveCredentials, unwrap } from "../context.ts";

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
export async function login(opts: { apiUrl?: string; dashboardUrl?: string; open?: boolean; wait?: boolean }) {
  const api = opts.apiUrl ?? apiUrl();
  const dashboard = opts.dashboardUrl ?? dashboardUrl();
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
    p.log.info(`Approve it in the browser, then run ${pc.cyan("liftbay login")} again to finish.`);
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
      if (e instanceof LiftbayApiError && e.code === "authorization_pending") {
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
  if (!isInteractive()) fail("Not signed in. Run `liftbay login --no-wait`, approve in the browser, run `liftbay login`, then run this again (or set LIFTBAY_TOKEN).");
  await login(opts);
}
