import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { currentWorkflow, WORKFLOW_PATH } from "../workflow.ts";
import { CliError, client, cmd, dashboardUrl, disablePrompts, fail, isInteractive, unwrap } from "../context.ts";
import { answersToOptions, initQuestions, readAnswers } from "./answers.ts";
import { checkboxes } from "../prompts.ts";
import { ensureGithub, type GithubCheck } from "./github.ts";
import { detectApp, output, readAppJson, runQuiet, writeAppJson, writeConfig, type BuildProfile, type DetectedApp, type IosEngine, type LiftbayConfig } from "../project.ts";
import { ensureSignedIn } from "./auth.ts";
import { ensureEnvironment, envImport, importVariables, printImport, readEasProfiles, type ImportResult } from "./env.ts";
import { cancelled, ensureLinked, type LinkOptions } from "./link.ts";

export type UpdatesClient = "expo-updates" | "codepush" | "hot-updater";
export type SetupOptions = LinkOptions & { platforms?: string; iosEngine?: string; runtimePolicy?: "appVersion" | "fingerprint"; apiUrl?: string; dashboardUrl?: string; eas?: boolean; client?: UpdatesClient };

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
            await checkboxes({
              message: "Platforms to build",
              options: [
                { value: "ios" as const, label: "iOS", hint: "on GitHub Actions macOS runners or your Xcode Cloud" },
                { value: "android" as const, label: "Android", hint: "on GitHub Actions Linux runners" },
              ],
              initialValues: ["ios", "android"] as ("ios" | "android")[],
            }),
          );
  }

  // Where iOS store builds run by default: a project setting, so builds started from the CLI, an agent or a
  // git push all follow it. Both use the customer's own minutes or hours; Xcode Cloud needs a one-time setup.
  let iosEngine: IosEngine | undefined = opts.iosEngine as IosEngine | undefined;
  if (iosEngine && iosEngine !== "github-actions" && iosEngine !== "xcode-cloud") fail("--ios-engine must be github-actions or xcode-cloud");
  if (platforms.includes("ios") && !iosEngine) {
    const current = (await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}", { params: { path: { org: config.org, project: config.project } } }))).iosEngine;
    iosEngine =
      opts.yes || !isInteractive()
        ? (current ?? "github-actions")
        : cancelled(
            await p.select({
              message: "Where should iOS store builds run? (you can pick for each build too)",
              options: [
                { value: "github-actions" as const, label: "GitHub Actions", hint: "macOS runners on your GitHub minutes; ready now" },
                { value: "xcode-cloud" as const, label: "Xcode Cloud", hint: "store builds, 25 free hours a month with the Apple Developer Program; one-time setup after iOS signing" },
              ],
              initialValue: current ?? ("github-actions" as const),
            }),
          );
  }

  if (platforms.includes("ios") && !app.bundleId) p.log.warn(`No iOS bundle identifier found. Set ${pc.cyan("expo.ios.bundleIdentifier")} in app.json before the first iOS build.`);
  if (platforms.includes("android") && !app.androidPackage) p.log.warn(`No Android package found. Set ${pc.cyan("expo.android.package")} in app.json before the first Android build.`);

  // Keep the project's identifiers and repo in sync with the app.
  const path = { org: config.org, project: config.project };
  const repo = await githubRepo();
  if (!repo) p.log.warn(`No GitHub remote found. Builds run on GitHub Actions: push this app to GitHub, then run ${pc.cyan(cmd("liftbay ci init"))} again.`);
  await unwrap(
    lb.PATCH("/v1/orgs/{org}/projects/{project}", {
      params: { path },
      body: { framework: app.framework, bundleId: app.bundleId, androidPackage: app.androidPackage, ...(repo ? { repo: `github:${repo}` } : {}) },
    }),
  );
  await writeWorkflow(opts);

  // Coming from EAS: eas.json's build profiles, channels and env become Liftbay's (env goes into environments).
  const eas = opts.eas === false ? null : readEasProfiles();
  let fromEas = false;
  if (eas?.length) {
    fromEas =
      opts.yes ||
      !isInteractive() ||
      cancelled(await p.confirm({ message: `Found eas.json (profiles ${eas.map((e) => e.name).join(", ")}). Use its build profiles, channels and env variables?`, initialValue: true }));
  }
  const base: Record<string, Omit<BuildProfile, "platforms">> = fromEas
    ? Object.fromEntries(eas!.map((e) => [e.name, { environment: e.slug, channel: e.channel, distribution: e.distribution }]))
    : DEFAULT_PROFILES;

  const envs = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/environments", { params: { path } }));
  for (const profile of Object.values(base)) {
    if (await ensureEnvironment(lb, path, profile.environment, envs)) envs.push({ slug: profile.environment } as (typeof envs)[number]);
  }
  const imported: ImportResult[] = [];
  if (fromEas) {
    p.log.step("Importing env variables from eas.json");
    for (const e of eas!) {
      const vars = Object.entries(e.env).map(([key, value]) => ({ key, value }));
      if (!vars.length) continue;
      // Re-running init keeps values changed in Liftbay since; `liftbay env import eas.json` overwrites.
      const r = await importVariables(lb, path, e.slug, vars, { overwrite: false });
      printImport(r);
      imported.push(r);
    }
    p.log.info(pc.dim("EXPO_PUBLIC_* values are plain (they're in the app bundle); names like *_TOKEN or *_SECRET are secret; the rest sensitive."));
    p.log.info(pc.dim(`Variables kept on expo.dev (EAS environment variables) aren't in eas.json: ${pc.cyan("npx eas env:pull --environment production")}, then ${pc.cyan(cmd("liftbay env import .env.local --environment production"))}.`));
  }

  const profiles = Object.fromEntries(Object.entries(base).map(([name, prof]) => [name, { ...prof, platforms }]));
  // Triggers are opt-in (docs: /docs/builds/triggers); keep any the project already has.
  if (iosEngine) await unwrap(lb.PATCH("/v1/orgs/{org}/projects/{project}", { params: { path }, body: { iosEngine } }));
  const next: LiftbayConfig = { ...config, build: { profiles, triggers: config.build?.triggers ?? [] } };
  writeConfig(next);
  p.note(
    Object.entries(profiles)
      .map(([name, prof]) => `${pc.bold(name.padEnd(12))} env ${prof.environment.padEnd(12)} ${prof.distribution === "store" ? "store" : "internal"} · ${prof.platforms.join(", ")}`)
      .join("\n") + (iosEngine ? `\n\niOS store builds run on ${iosEngine === "xcode-cloud" ? "Xcode Cloud" : "GitHub Actions"} (project setting)` : ""),
    "Build profiles",
  );
  if (iosEngine === "xcode-cloud") {
    p.log.info(
      `Xcode Cloud makes iOS store builds (TestFlight); internal and simulator builds stay on GitHub Actions. It needs iOS signing first: ${pc.cyan(cmd("liftbay credentials ios"))}, then ${pc.cyan(cmd("liftbay xcode-cloud connect"))}.`,
    );
  }
  lastImport = imported;
  return next;
}

/**
 * Builds start through the Liftbay GitHub App with the workflow on the default branch. In a terminal this
 * walks through installing both now; a "no" (or an agent) just gets told what's left, and setup carries on.
 */
async function githubStep(): Promise<GithubCheck | { error: string }> {
  try {
    const s = await ensureGithub({ needWorkflow: false, soft: !isInteractive() });
    if (s.connected) p.log.success(`GitHub is ready: ${s.repo}`);
    else if (!isInteractive()) p.log.warn(`GitHub isn't ready yet${s.installUrl ? `: install the Liftbay GitHub App ${s.installUrl}` : ""}. ${cmd("liftbay github status")} shows what's left.`);
    return s;
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    p.log.warn(e.message);
    p.log.info(`Finish any time with ${pc.cyan(cmd("liftbay github connect"))}; ${cmd("liftbay build")} checks it too.`);
    return { error: e.message };
  }
}

/** What the last ciInit imported from eas.json, for the commands' JSON results. */
let lastImport: ImportResult[] = [];


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
  const wanted = await currentWorkflow();
  const current = existsSync(WORKFLOW_PATH) ? readFileSync(WORKFLOW_PATH, "utf8") : null;
  if (current === wanted) return;
  if (current !== null) {
    const replace = opts.yes || (isInteractive() && cancelled(await p.confirm({ message: `${WORKFLOW_PATH} differs from the current Liftbay workflow. Replace it?` })));
    if (!replace) return p.log.info(`Kept your ${WORKFLOW_PATH}.`);
  }
  mkdirSync(dirname(WORKFLOW_PATH), { recursive: true });
  writeFileSync(WORKFLOW_PATH, wanted);
  p.log.success(`Wrote ${pc.cyan(WORKFLOW_PATH)}. Commit and push it: Liftbay starts it for every build, on your GitHub Actions minutes.`);
  p.log.info(pc.dim("GitHub counts macOS minutes about 10× faster than Linux; on a private repo with GitHub Free that is roughly 10 iOS builds a month."));
}

// ── OTA setup ────────────────────────────────────────────────────────────

const pluginSpec = () => process.env.LIFTBAY_EXPO_PLUGIN_SPEC ?? "@liftbay/expo-plugin";

async function addDependency(app: DetectedApp, spec: string, label: string) {
  const args = { npm: ["install", spec], yarn: ["add", spec], pnpm: ["add", spec], bun: ["add", spec] }[app.packageManager];
  await runQuiet(label, app.packageManager, args);
}

/** The update library the app uses: what it already depends on, or (plain React Native) the person's pick. */
async function pickUpdatesClient(app: DetectedApp, config: LiftbayConfig, opts: SetupOptions): Promise<UpdatesClient> {
  if (opts.client) return opts.client;
  if (config.updates?.client) return config.updates.client;
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies?: Record<string, string> };
  const deps = pkg.dependencies ?? {};
  if (deps["@hot-updater/react-native"]) return "hot-updater";
  if (deps["@code-push-next/react-native-code-push"] || deps["react-native-code-push"] || deps["@revopush/react-native-code-push"]) return "codepush";
  if (app.hasExpoModules || app.framework === "expo" || opts.yes || !isInteractive()) return "expo-updates";
  return cancelled(
    await p.select({
      message: "Which update library should the app use?",
      options: [
        { value: "expo-updates" as const, label: "expo-updates", hint: "installs Expo Modules; recommended" },
        { value: "hot-updater" as const, label: "hot-updater", hint: "you add @hot-updater/react-native" },
        { value: "codepush" as const, label: "CodePush", hint: "you add @code-push-next/react-native-code-push" },
      ],
    }),
  );
}

/** One channel per build profile, bound to that profile's environment, serving the client's protocol. */
async function ensureChannels(config: LiftbayConfig, protocol: "expo" | "codepush" | "hot-updater") {
  const lb = client();
  const path = { org: config.org, project: config.project };
  const profiles = config.build?.profiles ?? Object.fromEntries(Object.entries(DEFAULT_PROFILES).map(([n, pr]) => [n, { ...pr, platforms: ["ios", "android"] as ("ios" | "android")[] }]));
  const envs = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/environments", { params: { path } }));
  const channels = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/channels", { params: { path } }));
  for (const prof of Object.values(profiles)) {
    const existing = channels.find((c) => c.name === prof.channel);
    const env = envs.find((e) => e.slug === prof.environment);
    if (!env) fail(`Environment ${prof.environment} not found; run \`liftbay ci init\` first`);
    if (!existing) {
      await unwrap(lb.POST("/v1/orgs/{org}/projects/{project}/channels", { params: { path }, body: { name: prof.channel, environmentId: env.id, protocols: [protocol] } }));
      p.log.success(`Created channel ${pc.bold(prof.channel)} → ${prof.environment}`);
    } else if (!existing.protocols.includes(protocol)) {
      await unwrap(
        lb.PATCH("/v1/orgs/{org}/projects/{project}/channels/{channel}", { params: { path: { ...path, channel: prof.channel } }, body: { protocols: [...existing.protocols, protocol] } }),
      );
      p.log.success(`Enabled ${protocol} on channel ${pc.bold(prof.channel)}`);
    }
  }
  return { profiles, channels: await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/channels", { params: { path } })) };
}

/**
 * CodePush and hot-updater: channels with their protocol, and the values to put in the native projects. The
 * client library itself stays the person's choice (and its version), so it isn't installed here.
 */
async function otaInitRn(config: LiftbayConfig, updatesClient: "codepush" | "hot-updater"): Promise<LiftbayConfig> {
  const { profiles, channels } = await ensureChannels(config, updatesClient);
  const production = channels.find((c) => c.name === profiles.production?.channel) ?? channels[0];
  if (updatesClient === "codepush") {
    const cp = production?.connect.codepush;
    if (!cp) fail("The server did not return CodePush settings for the channel");
    p.note(
      [
        `Server URL: ${cp.serverUrl}`,
        `iOS Info.plist:  CodePushServerURL = ${cp.serverUrl}`,
        `                 CodePushDeploymentKey = ${cp.deploymentKeys.ios}`,
        `Android strings: CodePushServerUrl = ${cp.serverUrl}`,
        `                 CodePushDeploymentKey = ${cp.deploymentKeys.android}`,
        "",
        `Those keys are the ${production!.name} channel's; each channel's are <channel id>.ios / .android`,
        `(see ${cmd("liftbay channels")}). Client: @code-push-next/react-native-code-push for React Native 0.76+.`,
      ].join("\n"),
      "Add to your native projects",
    );
  } else {
    const hu = production?.connect.hotUpdater;
    if (!hu) fail("The server did not return hot-updater settings for the channel");
    p.note(
      [
        `baseURL: ${hu.baseURL}`,
        `  hot-updater 1.x: HotUpdater.init({ baseURL: "${hu.baseURL}" })`,
        `  hot-updater 0.x: HotUpdater.wrap({ baseURL: "${hu.baseURL}", updateStrategy: "appVersion" })`,
        "Channel (the build's channel, e.g. production):",
        "  iOS Info.plist: HOT_UPDATER_CHANNEL",
        '  Android: <meta-data android:name="com.hotupdater.CHANNEL" android:value="…"/> in AndroidManifest.xml',
      ].join("\n"),
      "Add to your app",
    );
  }
  const next: LiftbayConfig = { ...config, updates: { client: updatesClient } };
  writeConfig(next);
  return next;
}

/** expo-updates, the Liftbay config plugin, channels per build profile and the runtime version policy. */
export async function otaInit(app: DetectedApp, config: LiftbayConfig, opts: SetupOptions): Promise<LiftbayConfig> {
  const updatesClient = await pickUpdatesClient(app, config, opts);
  if (updatesClient !== "expo-updates") return otaInitRn(config, updatesClient);
  const lb = client();
  const path = { org: config.org, project: config.project };

  if (!app.hasExpoModules) {
    const ok =
      opts.yes ||
      (isInteractive() &&
        cancelled(await p.confirm({ message: "OTA updates use expo-updates, which needs Expo Modules in a bare React Native app. Install them now (npx install-expo-modules)?" })));
    if (!ok) fail("OTA setup needs Expo Modules. Run `npx install-expo-modules@latest`, then `liftbay ota init`.");
    await runQuiet("Setting up Expo Modules", "npx", ["--yes", "install-expo-modules@latest"]);
  }
  if (!app.hasExpoUpdates) await runQuiet("Installing expo-updates", "npx", ["expo", "install", "expo-updates"]);
  await addDependency(app, pluginSpec(), "Installing the Liftbay config plugin (@liftbay/expo-plugin)");

  const existingPolicy = readAppJson()?.expo?.runtimeVersion?.policy;
  let policy = opts.runtimePolicy ?? (existingPolicy === "appVersion" || existingPolicy === "fingerprint" ? existingPolicy : undefined);
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

  const { profiles, channels } = await ensureChannels(config, "expo");
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
  const github = await githubStep();
  p.outro(`Builds are configured. Start one with ${pc.cyan(cmd("liftbay build"))}`);
  return { config: next, imported: lastImport, github };
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
  `OTA updates are configured.\n\n  1. Build a new binary once (the update URL and channel are baked in)\n  2. Ship JS changes with ${pc.cyan(cmd("liftbay update publish --channel production"))}`;

/** The wizard: sign in, link the project, set up builds, then OTA updates. */
export async function initCommand(opts: SetupOptions & { ota?: boolean; questions?: boolean; answers?: string }) {
  if (opts.questions) return initQuestions();
  // An agent's interview, all answered up front: no prompts for the rest of the run.
  let envFiles: Record<string, string[]> | undefined;
  if (opts.answers) {
    const answers = readAnswers(opts.answers);
    Object.assign(opts, answersToOptions(answers));
    envFiles = answers.envFiles;
    disablePrompts();
  }
  p.intro(pc.bgCyan(pc.black(" liftbay init ")));
  await ensureSignedIn(opts);
  const app = await detectApp();
  p.log.info(
    `${pc.bold(app.name)}: ${app.framework === "expo" ? "Expo" : "React Native"}${app.version ? ` ${app.version}` : ""}${app.bundleId ? ` · ${app.bundleId}` : ""}${app.androidPackage && app.androidPackage !== app.bundleId ? ` · ${app.androidPackage}` : ""}`,
  );
  let config = await ensureLinked(app, opts);

  p.log.step(pc.bold("1/3  Builds"));
  config = await ciInit(app, config, opts);

  p.log.step(pc.bold("2/3  OTA updates"));
  const wantOta = opts.ota ?? (opts.yes || !isInteractive() ? true : cancelled(await p.confirm({ message: "Set up over-the-air updates with expo-updates?", initialValue: true })));
  if (wantOta) config = await otaInit(await detectApp(), config, opts);
  else p.log.info(`Skipped. Run ${pc.cyan(cmd("liftbay ota init"))} any time.`);

  const imported = [];
  for (const [environment, files] of Object.entries(envFiles ?? {})) {
    if (files.length) imported.push(...(await envImport(files, { environment })).imported);
  }

  p.log.step(pc.bold("3/3  GitHub"));
  const github = await githubStep();

  p.outro(
    [
      `Done. ${pc.dim(`${dashboardUrl()}/${config.org}/${config.project}`)}`,
      "",
      "  Next:",
      `  1. Build:   ${pc.cyan(cmd("liftbay build"))} ${pc.dim("(offers to commit the setup and push this branch)")}`,
      ...(wantOta ? [`  2. Update:  ${pc.cyan(cmd("liftbay update publish --channel preview"))} ${pc.dim("(after a build from this setup is installed)")}`] : []),
      ...(cmd("liftbay") !== "liftbay" ? ["", pc.dim(`  Tip: ${pc.cyan("npm i -g liftbay")} to type ${pc.cyan("liftbay")} instead of ${pc.cyan("npx liftbay")}.`)] : []),
    ].join("\n"),
  );
  return {
    github,
    config,
    imported: [...lastImport, ...imported],
    url: `${dashboardUrl()}/${config.org}/${config.project}`,
    next: ["Commit liftbay.json, .github/workflows/liftbay.yml and app.json, and push", "liftbay build --profile preview", ...(wantOta ? ["liftbay update publish --channel production"] : [])],
  };
}
