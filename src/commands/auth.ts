import { spawn } from "node:child_process";
import * as p from "@clack/prompts";
import { createLiftbayClient, LiftbayApiError } from "@liftbay/sdk";
import pc from "picocolors";
import { apiUrl, clearCredentials, client, dashboardUrl, fail, readCredentials, saveCredentials, unwrap } from "../context.ts";

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

/** Device authorization flow: approve in the browser, the CLI gets its own session token. */
export async function login(opts: { apiUrl?: string; dashboardUrl?: string; open?: boolean }) {
  const api = opts.apiUrl ?? apiUrl();
  const dashboard = opts.dashboardUrl ?? dashboardUrl();
  const anon = createLiftbayClient({ baseUrl: api });
  const start = await unwrap(anon.POST("/v1/auth/device", { body: { clientName: `Liftbay CLI on ${process.platform}` } }));

  p.note(`${pc.bold(start.userCode)}\n\n${pc.dim("Confirm this code in your browser:")}\n${start.verificationUriComplete}`, "Sign in");
  if (opts.open !== false) openBrowser(start.verificationUriComplete);

  const spin = p.spinner();
  spin.start("Waiting for approval in the browser");
  const deadline = Date.now() + start.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(start.interval * 1000);
    try {
      const res = await unwrap(anon.POST("/v1/auth/device/token", { body: { deviceCode: start.deviceCode } }));
      saveCredentials({ apiUrl: api, dashboardUrl: dashboard, token: res.token, email: res.user.email });
      spin.stop(`Signed in as ${pc.bold(res.user.email)}`);
      return res.user;
    } catch (e) {
      if (e instanceof LiftbayApiError && e.code === "authorization_pending") continue;
      spin.stop("Sign-in failed");
      throw e;
    }
  }
  spin.stop("Timed out");
  fail("Sign-in request expired. Run `liftbay login` again.");
}

export async function logout() {
  const creds = readCredentials();
  if (!creds) return p.log.info("Not signed in.");
  await client().POST("/v1/auth/logout").catch(() => undefined);
  clearCredentials();
  p.log.success(`Signed out ${creds.email}`);
}

export async function whoami() {
  if (process.env.LIFTBAY_TOKEN?.startsWith("lbt_")) {
    const orgs = await unwrap(client().GET("/v1/orgs"));
    console.log(`Organization API token for ${orgs.map((o) => o.slug).join(", ")}`);
    return;
  }
  const me = await unwrap(client().GET("/v1/auth/me"));
  console.log(`${pc.bold(me.user.email)}${me.user.name ? ` (${me.user.name})` : ""}`);
  for (const m of me.memberships) console.log(`  ${m.orgSlug.padEnd(24)} ${pc.dim(m.role)}`);
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
  await login(opts);
}
