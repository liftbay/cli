import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./context.ts";

export const CONFIG_FILE = "liftbay.json";

export type IosEngine = "github-actions" | "xcode-cloud";

export type BuildProfile = {
  environment: string;
  channel: string;
  distribution: "internal" | "store";
  platforms: ("ios" | "android")[];
  /** Submit store builds when they succeed: TestFlight for iOS, `submitTrack` (default internal) on Google Play. */
  submit?: boolean;
  submitTrack?: "internal" | "alpha" | "beta" | "production";
};

/** Committed to the repository, so the project describes itself. */
export type LiftbayConfig = {
  $schema?: string;
  org: string;
  project: string;
  projectId: string;
  build?: {
    profiles: Record<string, BuildProfile>;
    /** Builds started by git events through the GitHub App. See https://liftbay.dev/docs/builds/triggers */
    triggers?: { on: "push" | "pull_request" | "tag"; branches?: string[]; tags?: string[]; profile: string; platforms?: ("ios" | "android")[]; submit?: boolean }[];
    /** Where iOS builds run unless `--engine` says otherwise: GitHub Actions macOS runners, or the team's Xcode Cloud. */
    iosEngine?: IosEngine;
  };
  updates?: { client: "expo-updates"; runtimeVersion: { policy: "appVersion" | "fingerprint" } };
};

export function readConfig(cwd = process.cwd()): LiftbayConfig | null {
  const path = join(cwd, CONFIG_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LiftbayConfig) : null;
}

export function requireConfig(cwd = process.cwd()): LiftbayConfig {
  return readConfig(cwd) ?? fail(`No ${CONFIG_FILE} here. Run \`liftbay init\` in your app's folder.`);
}

export function writeConfig(config: LiftbayConfig, cwd = process.cwd()) {
  writeFileSync(join(cwd, CONFIG_FILE), `${JSON.stringify({ $schema: "https://liftbay.dev/schema/liftbay.json", ...config }, null, 2)}\n`);
}

export type DetectedApp = {
  framework: "expo" | "react-native";
  name: string;
  slug: string;
  version: string | null;
  bundleId: string | null;
  androidPackage: string | null;
  hasExpoModules: boolean;
  hasExpoUpdates: boolean;
  packageManager: "npm" | "yarn" | "pnpm" | "bun";
  appJson: boolean;
};

function readJson(path: string): any {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

export function packageManager(cwd = process.cwd()): DetectedApp["packageManager"] {
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun";
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * Child processes always run asynchronously: a blocking call would freeze the event loop, and the
 * HTTP client would then reuse keep-alive connections the server has already closed.
 */
export async function output(cmd: string, args: string[], cwd = process.cwd()): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

/** The app's resolved public config, exactly as Expo sees it (app.json plus app.config.js). */
export async function expoConfig(cwd = process.cwd()): Promise<Record<string, any>> {
  return JSON.parse(await output("npx", ["expo", "config", "--json", "--type", "public"], cwd));
}

export async function detectApp(cwd = process.cwd()): Promise<DetectedApp> {
  const pkg = readJson(join(cwd, "package.json"));
  if (!pkg) fail("No package.json here. Run this in your React Native app's folder.");
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps["react-native"]) fail("This doesn't look like a React Native app (react-native is not a dependency).");
  const hasExpo = !!deps.expo;

  let name = pkg.name ?? "app";
  let slug = name;
  let version: string | null = pkg.version ?? null;
  let bundleId: string | null = null;
  let androidPackage: string | null = null;
  if (hasExpo) {
    const cfg = await expoConfig(cwd);
    name = cfg.name ?? name;
    slug = cfg.slug ?? slug;
    version = cfg.version ?? version;
    bundleId = cfg.ios?.bundleIdentifier ?? null;
    androidPackage = cfg.android?.package ?? null;
  } else {
    const gradle = join(cwd, "android/app/build.gradle");
    if (existsSync(gradle)) androidPackage = readFileSync(gradle, "utf8").match(/applicationId\s+["']([^"']+)["']/)?.[1] ?? null;
  }
  return {
    framework: hasExpo ? "expo" : "react-native",
    name,
    slug: String(slug).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "app",
    version,
    bundleId,
    androidPackage,
    hasExpoModules: hasExpo,
    hasExpoUpdates: !!deps["expo-updates"],
    packageManager: packageManager(cwd),
    appJson: existsSync(join(cwd, "app.json")),
  };
}

export async function run(cmd: string, args: string[], cwd = process.cwd(), env: Record<string, string> = {}) {
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) fail(`\`${cmd} ${args.join(" ")}\` failed (exit ${code})`);
}

/**
 * Runs a setup step (an install, a codemod) without flooding the terminal: its output is kept, and shown only
 * if it fails. npm's audit and funding notes are about the app's whole dependency tree, not this step.
 */
export async function runQuiet(label: string, cmd: string, args: string[], cwd = process.cwd()) {
  const p = await import("@clack/prompts");
  const spin = p.spinner();
  spin.start(label);
  const lines: string[] = [];
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" },
    });
    const keep = (chunk: Buffer) => lines.push(...chunk.toString().split(/\r?\n/).filter(Boolean));
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code === 0) return spin.stop(label.replace(/^Installing/, "Installed").replace(/^Setting up/, "Set up"));
  spin.error(`${label} failed`);
  console.error(lines.slice(-40).join("\n"));
  fail(`\`${cmd} ${args.join(" ")}\` failed (exit ${code})`);
}

export function readAppJson(cwd = process.cwd()): any {
  return readJson(join(cwd, "app.json"));
}

export function writeAppJson(data: unknown, cwd = process.cwd()) {
  writeFileSync(join(cwd, "app.json"), `${JSON.stringify(data, null, 2)}\n`);
}
