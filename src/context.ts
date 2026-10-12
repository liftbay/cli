import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLiftbayClient, LiftbayApiError, unwrap, type LiftbayClient } from "@liftbay/sdk";
import pc from "picocolors";

export { unwrap };

const CONFIG_DIR = process.env.LIFTBAY_CONFIG_DIR ?? join(homedir(), ".liftbay");
const CREDENTIALS = join(CONFIG_DIR, "credentials.json");

export const apiUrl = () => process.env.LIFTBAY_API_URL ?? readCredentials()?.apiUrl ?? "https://api.liftbay.dev";
export const dashboardUrl = () => process.env.LIFTBAY_DASHBOARD_URL ?? readCredentials()?.dashboardUrl ?? "https://liftbay.dev";

type Credentials = { apiUrl: string; dashboardUrl?: string; token: string; email: string };

export function readCredentials(): Credentials | null {
  try {
    return JSON.parse(readFileSync(CREDENTIALS, "utf8")) as Credentials;
  } catch {
    return null;
  }
}

/** Stored readable only by the current user. */
export function saveCredentials(c: Credentials) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CREDENTIALS, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  chmodSync(CREDENTIALS, 0o600);
}

export function clearCredentials() {
  if (existsSync(CREDENTIALS)) rmSync(CREDENTIALS);
}

/** LIFTBAY_TOKEN (CI: an organization API token) wins over the token saved by `liftbay login`. */
export function client(): LiftbayClient {
  const token = process.env.LIFTBAY_TOKEN ?? readCredentials()?.token;
  if (!token) fail("Not signed in. Run `liftbay login`, or set LIFTBAY_TOKEN in CI.");
  return createLiftbayClient({ baseUrl: apiUrl(), token, headers: { "User-Agent": "liftbay-cli" } });
}

export class CliError extends Error {}

export function fail(message: string): never {
  throw new CliError(message);
}

/** Turns API errors into one readable line; everything else is a bug and keeps its stack. */
export function reportError(e: unknown): never {
  if (e instanceof CliError) console.error(`${pc.red("✖")} ${e.message}`);
  else if (e instanceof LiftbayApiError) {
    console.error(`${pc.red("✖")} ${e.message}${e.status === 401 ? pc.dim("  (run `liftbay login`)") : ""}`);
    for (const [field, msg] of Object.entries(e.fields)) console.error(pc.dim(`  ${field}: ${msg}`));
  } else console.error(e);
  process.exit(1);
}

export const isInteractive = () => process.stdout.isTTY && !process.env.CI;
