import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLiftbayClient, LiftbayApiError, unwrap, type LiftbayClient } from "@liftbay/sdk";
import pc from "picocolors";

export { unwrap };

export const CONFIG_DIR = process.env.LIFTBAY_CONFIG_DIR ?? join(homedir(), ".liftbay");
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
  throw new CliError(withCliName(message));
}

// ── JSON output (for scripts and AI agents) ─────────────────────────────

let json = false;
let writeStdout: ((chunk: string) => boolean) | null = null;

/**
 * `--json` (or LIFTBAY_JSON=1): stdout carries exactly one JSON document, the command's result or
 * `{ "error": … }`. Everything meant for people (progress, logs, notes) moves to stderr, and nothing prompts.
 */
export function enableJson() {
  if (json) return;
  json = true;
  writeStdout = process.stdout.write.bind(process.stdout) as (chunk: string) => boolean;
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
}

export const jsonMode = () => json;

/** Prints a command's result in JSON mode; people already saw it as text. */
export function emit(result: unknown) {
  if (json) writeStdout!(`${JSON.stringify(result ?? { ok: true }, null, 2)}\n`);
}

/** How this CLI was started: `npx liftbay` (not installed) or `liftbay`, so the commands we suggest work as typed. */
export const cliName = () =>
  process.env.LIFTBAY_CLI_NAME ?? (/[\\/]_npx[\\/]/.test(process.argv[1] ?? "") || process.env.npm_command === "exec" ? "npx liftbay" : "liftbay");

/** A suggested command, spelled the way this CLI was started: cmd("liftbay build") → "npx liftbay build". */
export const cmd = (command: string) => command.replace(/^liftbay\b/, cliName());

/** The same for commands quoted inside a message: `liftbay login` → `npx liftbay login`. */
export const withCliName = (text: string) => (cliName() === "liftbay" ? text : text.replace(/`liftbay /g, `\`${cliName()} `));

/** Turns API errors into one readable line; everything else is a bug and keeps its stack. */
export function reportError(e: unknown): never {
  if (json) {
    const error =
      e instanceof LiftbayApiError
        ? { code: e.code, message: e.message, status: e.status, fields: e.fields }
        : e instanceof CliError
          ? { code: "cli_error", message: e.message }
          : { code: "internal", message: e instanceof Error ? e.message : String(e) };
    writeStdout!(`${JSON.stringify({ error }, null, 2)}\n`);
    if (!(e instanceof CliError) && !(e instanceof LiftbayApiError)) console.error(e);
    process.exit(1);
  }
  if (e instanceof CliError) console.error(`${pc.red("✖")} ${e.message}`);
  else if (e instanceof LiftbayApiError) {
    console.error(`${pc.red("✖")} ${e.message}${e.status === 401 ? pc.dim("  (run `liftbay login`)") : ""}`);
    for (const [field, msg] of Object.entries(e.fields)) console.error(pc.dim(`  ${field}: ${msg}`));
  } else console.error(e);
  process.exit(1);
}

/** A person at a terminal. Agents, CI and `--json` never get prompts: missing input is an error naming the flag. */
export const isInteractive = () => !json && !!process.stdin.isTTY && !!process.stdout.isTTY && !process.env.CI;

/** Called where a prompt would be the only way forward: fails with what to pass instead when no one can answer. */
export function needInteractive(instead: string) {
  if (!isInteractive()) fail(instead);
}
