import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { WORKFLOW_YAML } from "../generated/workflow.ts";
import { client, dashboardUrl, fail, isInteractive, unwrap } from "../context.ts";
import { detectApp, output, readAppJson, run, writeAppJson, writeConfig, type BuildProfile, type DetectedApp, type LiftbayConfig } from "../project.ts";
import { ensureSignedIn } from "./auth.ts";
import { cancelled, ensureLinked, type LinkOptions } from "./link.ts";

export type SetupOptions = LinkOptions & { platforms?: string; runtimePolicy?: "appVersion" | "fingerprint"; apiUrl?: string; dashboardUrl?: string };

const DEFAULT_PROFILES: Record<string, Omit<BuildProfile, "platforms">> = {
  development: { environment: "development", channel: "development", distribution: "internal" },
  preview: { environment: "preview", channel: "preview", distribution: "internal" },
  production: { environment: "production", channel: "production", distribution: "store" },
};

function parsePlatforms(v: string | undefined): ("ios" | "android")[] | null {
  if (!v) return null;
  const list = v === "all" ? ["ios", "android"] : v.split(",").map((s) => s.trim());
  if (!list.every((x) => x === "ios" || x === "android")) fail("--platforms must be ios, android or all");
  return list as ("ios" | "android")[];
}

// ── Build setup ──────────────────────────────────────────────────────────

/** Build profiles, environments and app identifiers. */
export async function ciInit(app: DetectedApp, config: LiftbayConfig, opts: SetupOptions): Promise<LiftbayConfig> {
  const lb = client();
  let platforms = parsePlatforms(opts.platforms);
  if (!platforms) {
    platforms =
      opts.yes || !isInteractive()
        ? ["ios", "android"]
        : cancelled(
            await p.multiselect({
              message: "Platforms to build",
              options: [
                { value: "ios" as const, label: "iOS", hint: "builds run on your GitHub Actions macOS runners" },
                { value: "android" as const, label: "Android", hint: "builds run on your GitHub Actions Linux runners" },
              ],
              initialValues: ["ios", "android"] as ("ios" | "android")[],
              required: true,
            }),
          );
  }

  if (platforms.includes("ios") && !app.bundleId) p.log.warn(`No iOS bundle identifier found. Set ${pc.cyan("expo.ios.bundleIdentifier")} in app.json before the first iOS build.`);
  if (platforms.includes("android") && !app.androidPackage) p.log.warn(`No Android package found. Set ${pc.cyan("expo.android.package")} in app.json before the first Android build.`);

  // Keep the project's identifiers and repo in sync with the app.
  const path = { org: config.org, project: config.project };
  const repo = await githubRepo();
  if (!repo) p.log.warn(`No GitHub remote found. Builds run on GitHub Actions: push this app to GitHub, then run ${pc.cyan("liftbay ci init")} again.`);
  await unwrap(
    lb.PATCH("/v1/orgs/{org}/projects/{project}", {
      params: { path },
      body: { framework: app.framework, bundleId: app.bundleId, androidPackage: app.androidPackage, ...(repo ? { repo: `github:${repo}` } : {}) },
    }),
  );
  await writeWorkflow(opts);

  const envs = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/environments", { params: { path } }));
  for (const profile of Object.values(DEFAULT_PROFILES)) {
    if (!envs.some((e) => e.slug === profile.environment)) {
      await unwrap(lb.POST("/v1/orgs/{org}/projects/{project}/environments", { params: { path }, body: { name: profile.environment, slug: profile.environment } }));
    }
  }

  const profiles = Object.fromEntries(Object.entries(DEFAULT_PROFILES).map(([name, prof]) => [name, { ...prof, platforms }]));
  // Triggers are opt-in (docs: /docs/builds/triggers); keep any the project already has.
  const next = { ...config, build: { profiles, triggers: config.build?.triggers ?? [] } };
  writeConfig(next);
  p.note(
    Object.entries(profiles)
      .map(([name, prof]) => `${pc.bold(name.padEnd(12))} env ${prof.environment.padEnd(12)} ${prof.distribution === "store" ? "store" : "internal"} · ${prof.platforms.join(", ")}`)
      .join("\n"),
    "Build profiles",
  );
  return next;
}

const WORKFLOW_PATH = ".github/workflows/liftbay.yml";

/** owner/name of the `origin` remote when it is on GitHub. */
async function githubRepo(): Promise<string | null> {
  try {
    const url = (await output("git", ["remote", "get-url", "origin"])).trim();
    return url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The workflow Liftbay starts for every build. It must be committed on the branches you build. */
async function writeWorkflow(opts: SetupOptions) {
  const current = existsSync(WORKFLOW_PATH) ? readFileSync(WORKFLOW_PATH, "utf8") : null;
  if (current === WORKFLOW_YAML) return;
  if (current !== null) {
    const replace = opts.yes || (isInteractive() && cancelled(await p.confirm({ message: `${WORKFLOW_PATH} differs from the current Liftbay workflow. Replace it?` })));
    if (!replace) return p.log.info(`Kept your ${WORKFLOW_PATH}.`);
  }
  mkdirSync(dirname(WORKFLOW_PATH), { recursive: true });
  writeFileSync(WORKFLOW_PATH, WORKFLOW_YAML);
  p.log.success(`Wrote ${pc.cyan(WORKFLOW_PATH)}. Commit and push it: Liftbay starts it for every build, on your GitHub Actions minutes.`);
  p.log.info(pc.dim("GitHub counts macOS minutes about 10× faster than Linux; on a private repo with GitHub Free that is roughly 10 iOS builds a month."));
}

// ── OTA setup ────────────────────────────────────────────────────────────

const pluginSpec = () => process.env.LIFTBAY_EXPO_PLUGIN_SPEC ?? "@liftbay/expo-plugin";

async function addDependency(app: DetectedApp, spec: string) {
  const args = { npm: ["install", spec], yarn: ["add", spec], pnpm: ["add", spec], bun: ["add", spec] }[app.packageManager];
  await run(app.packageManager, args);
}

/** expo-updates, the Liftbay config plugin, channels per build profile and the runtime version policy. */
export async function otaInit(app: DetectedApp, config: LiftbayConfig, opts: SetupOptions): Promise<LiftbayConfig> {
  const lb = client();
  const path = { org: config.org, project: config.project };

  if (!app.hasExpoModules) {
    const ok =
      opts.yes ||
      (isInteractive() &&
        cancelled(await p.confirm({ message: "OTA updates use expo-updates, which needs Expo Modules in a bare React Native app. Install them now (npx install-expo-modules)?" })));
    if (!ok) fail("OTA setup needs Expo Modules. Run `npx install-expo-modules@latest`, then `liftbay ota init`.");
    await run("npx", ["install-expo-modules@latest"]);
  }
  if (!app.hasExpoUpdates) {
    p.log.step("Installing expo-updates");
    await run("npx", ["expo", "install", "expo-updates"]);
  }
  p.log.step("Installing the Liftbay config plugin");
  await addDependency(app, pluginSpec());

  let policy = opts.runtimePolicy;
  if (!policy) {
    policy =
      opts.yes || !isInteractive()
        ? "appVersion"
        : cancelled(
            await p.select({
              message: "Which binaries can receive an update?",
              options: [
                { value: "appVersion" as const, label: "Same app version", hint: "recommended: bump the version when native code changes" },
                { value: "fingerprint" as const, label: "Same native fingerprint", hint: "automatic: computed from native code and config" },
              ],
            }),
          );
  }

  // One channel per build profile, bound to that profile's environment, serving expo-updates.
  const profiles = config.build?.profiles ?? Object.fromEntries(Object.entries(DEFAULT_PROFILES).map(([n, pr]) => [n, { ...pr, platforms: ["ios", "android"] as ("ios" | "android")[] }]));
  const envs = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/environments", { params: { path } }));
  let channels = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/channels", { params: { path } }));
  for (const prof of Object.values(profiles)) {
    const existing = channels.find((c) => c.name === prof.channel);
    const env = envs.find((e) => e.slug === prof.environment);
    if (!env) fail(`Environment ${prof.environment} not found; run \`liftbay ci init\` first`);
    if (!existing) {
      await unwrap(lb.POST("/v1/orgs/{org}/projects/{project}/channels", { params: { path }, body: { name: prof.channel, environmentId: env.id, protocols: ["expo"] } }));
      p.log.success(`Created channel ${pc.bold(prof.channel)} → ${prof.environment}`);
    } else if (!existing.protocols.includes("expo")) {
      await unwrap(
        lb.PATCH("/v1/orgs/{org}/projects/{project}/channels/{channel}", { params: { path: { ...path, channel: prof.channel } }, body: { protocols: [...existing.protocols, "expo"] } }),
      );
      p.log.success(`Enabled expo-updates on channel ${pc.bold(prof.channel)}`);
    }
  }
  channels = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/channels", { params: { path } }));
  const production = channels.find((c) => c.name === profiles.production?.channel) ?? channels[0];
  const updatesUrl = production?.connect.expo?.url;
  if (!updatesUrl) fail("The server did not return an expo-updates URL for the channel");

  // app.json: the plugin sets updates.url and the channel header at build time.
  const appJson = readAppJson();
  if (!appJson) {
    p.note(`plugins: [["@liftbay/expo-plugin", { "updatesUrl": "${updatesUrl}" }]]\nruntimeVersion: { "policy": "${policy}" }`, "Add to your app config");
  } else {
    const expo = (appJson.expo ??= {});
    const plugins: unknown[] = (expo.plugins ??= []);
    const entry = ["@liftbay/expo-plugin", { updatesUrl }];
    const at = plugins.findIndex((pl) => (Array.isArray(pl) ? pl[0] : pl) === "@liftbay/expo-plugin");
    if (at >= 0) plugins[at] = entry;
    else plugins.push(entry);
    expo.runtimeVersion = { policy };
    writeAppJson(appJson);
    p.log.success(`Updated ${pc.cyan("app.json")}: Liftbay plugin, runtimeVersion policy "${policy}"`);
  }

  const next: LiftbayConfig = { ...config, updates: { client: "expo-updates", runtimeVersion: { policy } } };
  writeConfig(next);
  return next;
}

// ── Commands ─────────────────────────────────────────────────────────────

export async function ciInitCommand(opts: SetupOptions) {
  p.intro(pc.bgCyan(pc.black(" liftbay ci init ")));
  await ensureSignedIn(opts);
  const app = await detectApp();
  const config = await ensureLinked(app, opts);
  const next = await ciInit(app, config, opts);
  p.outro(`Builds are configured. Start one with ${pc.cyan("liftbay build --profile preview")}`);
  return { config: next };
}

export async function otaInitCommand(opts: SetupOptions) {
  p.intro(pc.bgCyan(pc.black(" liftbay ota init ")));
  await ensureSignedIn(opts);
  const app = await detectApp();
  const config = await ensureLinked(app, opts);
  const next = await otaInit(app, config, opts);
  p.outro(nextStepsOta());
  return { config: next };
}

const nextStepsOta = () =>
  `OTA updates are configured.\n\n  1. Build a new binary once (the update URL and channel are baked in)\n  2. Ship JS changes with ${pc.cyan("liftbay update publish --channel production")}`;

/** The wizard: sign in, link the project, set up builds, then OTA updates. */
export async function initCommand(opts: SetupOptions & { ota?: boolean }) {
  p.intro(pc.bgCyan(pc.black(" liftbay init ")));
  await ensureSignedIn(opts);
  const app = await detectApp();
  p.log.info(
    `${pc.bold(app.name)}: ${app.framework === "expo" ? "Expo" : "React Native"}${app.version ? ` ${app.version}` : ""}${app.bundleId ? ` · ${app.bundleId}` : ""}${app.androidPackage && app.androidPackage !== app.bundleId ? ` · ${app.androidPackage}` : ""}`,
  );
  let config = await ensureLinked(app, opts);

  p.log.step(pc.bold("1/2  Builds"));
  config = await ciInit(app, config, opts);

  p.log.step(pc.bold("2/2  OTA updates"));
  const wantOta = opts.ota ?? (opts.yes || !isInteractive() ? true : cancelled(await p.confirm({ message: "Set up over-the-air updates with expo-updates?", initialValue: true })));
  if (wantOta) config = await otaInit(await detectApp(), config, opts);
  else p.log.info(`Skipped. Run ${pc.cyan("liftbay ota init")} any time.`);

  p.outro(
    `Done. ${pc.dim(`${dashboardUrl()}/${config.org}/${config.project}`)}\n\n  Build:  ${pc.cyan("liftbay build --profile preview")}${wantOta ? `\n  Update: ${pc.cyan("liftbay update publish --channel production")}` : ""}`,
  );
  return {
    config,
    url: `${dashboardUrl()}/${config.org}/${config.project}`,
    next: ["Commit liftbay.json, .github/workflows/liftbay.yml and app.json, and push", "liftbay build --profile preview", ...(wantOta ? ["liftbay update publish --channel production"] : [])],
  };
}
