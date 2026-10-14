import * as p from "@clack/prompts";
import pc from "picocolors";
import QRCode from "qrcode";
import { execFileSync } from "node:child_process";
import { client, cmd, dashboardUrl, fail, isInteractive, unwrap } from "../context.ts";
import { setUpIos } from "./credentials.ts";
import { cancelled } from "./link.ts";
import { requireConfig } from "../project.ts";
import { ensureGithub } from "./github.ts";
import type { components } from "@liftbay/sdk";

type Platform = "ios" | "android";
type Build = components["schemas"]["Build"];
type Engine = "auto" | "github-actions" | "xcode-cloud";
type BuildOptions = { platform?: string; profile?: string; ref?: string; message?: string; simulator?: boolean; wait?: boolean; submit?: boolean; track?: string; engine?: string };

const TRACKS = ["internal", "alpha", "beta", "production"] as const;

const FINISHED = new Set(["succeeded", "failed", "cancelled"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function currentBranch(): string | null {
  try {
    const ref = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return ref && ref !== "HEAD" ? ref : null;
  } catch {
    return null;
  }
}

/** Upstream state of the branch being built: builds use what's on GitHub, not this machine. */
function pushState(branch: string): { upstream: boolean; ahead: number } {
  try {
    execFileSync("git", ["rev-parse", "--abbrev-ref", `${branch}@{u}`], { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return { upstream: false, ahead: 0 };
  }
  try {
    const ahead = Number(execFileSync("git", ["rev-list", "--count", `${branch}@{u}..${branch}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    return { upstream: true, ahead: Number.isFinite(ahead) ? ahead : 0 };
  } catch {
    return { upstream: true, ahead: 0 };
  }
}

/** Files `liftbay init` writes or changes; uncommitted, they're the setup the build would be missing. */
const SETUP_FILES = ["liftbay.json", ".github/workflows/liftbay.yml", "app.json", "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"];

function git(args: string[]) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Runs git with the terminal attached, so a push can ask for credentials. */
function gitLoud(args: string[]) {
  try {
    execFileSync("git", args, { stdio: "inherit" });
  } catch {
    fail(`\`git ${args.join(" ")}\` failed. Fix that, then build again.`);
  }
}

/**
 * Makes sure what's built is what's here: the Liftbay setup committed, and the branch pushed. In a terminal it
 * offers to do both; otherwise it fails with the commands, so an agent can run them.
 */
async function readyToBuild(branch: string, interactive: boolean) {
  const changed = git(["status", "--porcelain", "--", ...SETUP_FILES])
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, ""));
  // Only liftbay.json and the workflow mark the setup as uncommitted; app.json and package files may hold unrelated edits.
  if (changed.some((f) => f === "liftbay.json" || f.startsWith(".github/"))) {
    const files = changed.filter((f) => f !== "" && SETUP_FILES.some((s) => f === s || f.startsWith(".github/")));
    const message = `The Liftbay setup isn't committed on ${branch}: ${files.join(", ")}.`;
    if (!interactive) fail(`${message} Commit it: git add ${files.join(" ")} && git commit -m "Set up Liftbay", then push.`);
    p.log.warn(message);
    if (!cancelled(await p.confirm({ message: `Commit ${files.length > 1 ? "these files" : "it"} on ${branch} now?`, initialValue: true }))) {
      fail(`Commit them first: git add ${files.join(" ")} && git commit -m "Set up Liftbay"`);
    }
    git(["add", "--", ...files]);
    gitLoud(["commit", "--quiet", "-m", "Set up Liftbay", "--", ...files]);
    p.log.success(`Committed "Set up Liftbay" on ${branch}`);
  }
  const other = git(["status", "--porcelain"]).split("\n").filter(Boolean).length;
  if (other) p.log.info(pc.dim(`${other} other uncommitted change${other > 1 ? "s" : ""} here won't be in the build: it uses what's on GitHub.`));

  const pushed = pushState(branch);
  if (!pushed.upstream || pushed.ahead > 0) {
    const what = !pushed.upstream ? `${branch} isn't on GitHub yet` : `${pushed.ahead} commit${pushed.ahead > 1 ? "s" : ""} on ${branch} ${pushed.ahead > 1 ? "aren't" : "isn't"} pushed`;
    const command = !pushed.upstream ? ["push", "-u", "origin", branch] : ["push"];
    if (!interactive) fail(`${what}. Builds use what's on GitHub: git ${command.join(" ")}`);
    const choice = cancelled(
      await p.select({
        message: `${what}. Builds use what's on GitHub.`,
        options: [
          { value: "push", label: `Push now`, hint: `git ${command.join(" ")}` },
          ...(pushed.upstream ? [{ value: "as-is", label: "Build what's on GitHub" }] : []),
          { value: "stop", label: "Stop" },
        ],
      }),
    );
    if (choice === "stop") fail(`Push when you're ready: git ${command.join(" ")}`);
    if (choice === "push") {
      gitLoud([command[0]!, "--quiet", ...command.slice(1)]);
      p.log.success(`Pushed ${branch}`);
    }
  }
}

/**
 * Queues one build per platform, then follows the logs until they finish. In a terminal, whatever isn't passed
 * as a flag is asked: profile, platform, and where iOS builds run. Before queuing, it checks the branch is
 * pushed and GitHub is ready, so a build never fails for setup reasons it could have caught here.
 */
export async function build(opts: BuildOptions) {
  const config = requireConfig();
  const lb = client();
  const interactive = isInteractive();
  const path = { org: config.org, project: config.project };
  const profiles = config.build?.profiles ?? fail("No build profiles in liftbay.json. Run `liftbay ci init`.");
  if (opts.engine && !["auto", "github-actions", "xcode-cloud"].includes(opts.engine)) fail("--engine must be auto, github-actions or xcode-cloud");

  p.intro(pc.bgCyan(pc.black(" liftbay build ")));

  // 1. Profile
  let profileName = opts.profile;
  if (!profileName) {
    const names = Object.keys(profiles);
    profileName =
      interactive && names.length > 1
        ? cancelled(
            await p.select({
              message: "Build profile",
              options: names.map((n) => ({
                value: n,
                label: n,
                hint: `${profiles[n]!.distribution === "store" ? "for TestFlight and Google Play" : "to install on test devices"} · env ${profiles[n]!.environment}`,
              })),
              initialValue: profiles.preview ? "preview" : names[0],
            }),
          )
        : profiles.production
          ? "production"
          : names[0]!;
  }
  const profile = profiles[profileName] ?? fail(`No build profile "${profileName}" in liftbay.json (${Object.keys(profiles).join(", ")}).`);

  // 2. Platforms
  let platforms: Platform[];
  if (opts.platform) {
    platforms = opts.platform === "all" ? profile.platforms : [opts.platform as Platform];
    if (!platforms.every((x) => x === "ios" || x === "android")) fail("--platform must be ios, android or all");
  } else if (interactive && profile.platforms.length > 1) {
    const choice = cancelled(
      await p.select({
        message: "Platform",
        options: [
          { value: "android", label: "Android" },
          { value: "ios", label: "iOS" },
          { value: "all", label: "Both" },
        ],
      }),
    );
    platforms = choice === "all" ? profile.platforms : [choice as Platform];
  } else platforms = profile.platforms;

  // 3. Where iOS builds run
  // Xcode Cloud makes iOS store builds only; internal (ad hoc) and simulator builds always run on GitHub Actions.
  const storeIos = platforms.includes("ios") && !opts.simulator && profile.distribution === "store";
  // `auto` lets the server follow the project's setting; a terminal asks for this build, defaulting to it.
  let iosEngine: Engine = (opts.engine as Engine | undefined) ?? "auto";
  if (!storeIos && iosEngine === "xcode-cloud") {
    fail(`Xcode Cloud makes iOS store builds only; profile "${profileName}" is ${opts.simulator ? "a simulator" : `an ${profile.distribution}`} build. Use a store profile, or --engine github-actions.`);
  }
  if (storeIos) {
    if (!opts.engine && interactive) {
      const setting = (await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}", { params: { path } }))).iosEngine ?? "github-actions";
      const label = (e: string) => (e === "xcode-cloud" ? "Xcode Cloud" : "GitHub Actions");
      iosEngine = cancelled(
        await p.select({
          message: "Where should this iOS build run?",
          options: (["github-actions", "xcode-cloud"] as const).map((e) => ({
            value: e,
            label: label(e),
            hint: [e === setting ? "project default" : "", e === "xcode-cloud" ? "25 free hours a month with the Apple Developer Program" : "macOS runners on your GitHub minutes"].filter(Boolean).join(" · "),
          })),
          initialValue: setting,
        }),
      );
      if (iosEngine !== setting) p.log.info(pc.dim(`Just this build. Change the project default in the dashboard's project settings, or with ${cmd("liftbay ci init --ios-engine " + iosEngine)}.`));
    }
    if (iosEngine === "xcode-cloud") {
      const xc = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/xcode-cloud", { params: { path } }));
      if (!xc.connected) {
        p.log.warn(`Xcode Cloud isn't connected yet: ${xc.message}`);
        const fallback =
          interactive &&
          cancelled(
            await p.select({
              message: "This iOS build",
              options: [
                { value: true, label: "Build it on GitHub Actions" },
                { value: false, label: "Stop, and set up Xcode Cloud first", hint: cmd("liftbay xcode-cloud connect") },
              ],
            }),
          );
        if (!fallback) fail(`Set up Xcode Cloud with \`liftbay xcode-cloud connect\`${xc.actionUrl ? ` (${xc.actionUrl})` : ""}, or build on GitHub Actions with --engine github-actions.`);
        iosEngine = "github-actions";
      }
    }
  }
  const engineFor = (platform: Platform): Engine => (platform === "ios" ? iosEngine : "github-actions");

  // 4. The branch must be on GitHub with the Liftbay setup in it: builds check out what's pushed there.
  const gitRef = opts.ref ?? currentBranch() ?? fail("This isn't a git branch (detached HEAD?). Check out a branch, or pass --ref <branch|tag|commit>.");
  if (!opts.ref) await readyToBuild(gitRef, interactive);

  // 5. The GitHub App (Xcode Cloud builds need it too). The workflow doesn't have to be on the default branch:
  //    Liftbay then runs it from this branch's commit through a temporary liftbay/build/* branch.
  await ensureGithub({ needWorkflow: false });

  // 6. Like EAS: the first signed iOS build offers to set up signing instead of quietly building for the simulator.
  if (platforms.includes("ios") && !opts.simulator) {
    const signing = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/signing", { params: { path } }));
    if (!signing.ios) {
      if (interactive && cancelled(await p.confirm({ message: "iOS signing isn't set up. Sign in with your Apple ID and set it up now?", initialValue: true }))) {
        await setUpIos({});
      } else {
        p.log.warn(`No iOS signing yet: this iOS build is a simulator build. Run ${pc.cyan(cmd("liftbay credentials ios"))} for signed builds.`);
      }
    }
  }
  const submit = !opts.simulator && (opts.submit ?? profile.submit ?? false);
  const submitTrack = (opts.track ?? profile.submitTrack) as (typeof TRACKS)[number] | undefined;
  if (submitTrack && !TRACKS.includes(submitTrack)) fail(`--track must be one of ${TRACKS.join(", ")}`);
  if (submit && profile.distribution !== "store") fail(`Profile "${profileName}" builds for ${profile.distribution} distribution; only store builds can be submitted`);
  const started: Build[] = [];
  for (const platform of platforms) {
    const distribution = opts.simulator ? "simulator" : profile.distribution;
    const b = await unwrap(
      lb.POST("/v1/orgs/{org}/projects/{project}/builds", {
        params: { path },
        body: { platform, profile: profileName, environment: profile.environment, gitRef, message: opts.message, engine: engineFor(platform), distribution, ...(submit ? { submit: true, submitTrack } : {}) },
      }),
    );
    p.log.step(
      `Build ${pc.bold(`#${b.number}`)} · ${platform} · ${profileName} · ${gitRef} · ${b.engine === "xcode-cloud" ? "Xcode Cloud" : "GitHub Actions"}${submit ? ` · then ${platform === "ios" ? "TestFlight" : `Play ${submitTrack ?? "internal"}`}` : ""} ${pc.dim(`${dashboardUrl()}/${config.org}/${config.project}/builds/${b.number}`)}`,
    );
    started.push(b);
  }
  const summary = (b: Build) => ({ number: b.number, platform: b.platform, status: b.status, engine: b.engine, url: `${dashboardUrl()}/${config.org}/${config.project}/builds/${b.number}` });
  if (opts.wait === false) {
    p.outro(`Queued. Follow along in the dashboard, or with ${pc.cyan(cmd("liftbay builds view <number>"))}.`);
    return { builds: started.map(summary) };
  }

  // Follow every build; with more than one, prefix lines with the platform.
  const prefix = started.length > 1;
  const results = await Promise.all(
    started.map(async (b) => {
      let after = 0;
      let phase: string | null = null;
      for (;;) {
        const page = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/builds/{number}/logs", { params: { path: { ...path, number: b.number }, query: { after } } }));
        for (const l of page.lines) {
          const tag = prefix ? pc.dim(`${b.platform.padEnd(8)}`) : "";
          if (l.phase && l.phase !== phase) {
            phase = l.phase;
            console.log(`${tag}${pc.cyan(`==> ${phase}`)}`);
          }
          console.log(`${tag}${l.stream === "stderr" ? pc.red(l.text) : l.stream === "system" ? pc.dim(l.text) : l.text}`);
        }
        after = page.nextSeq;
        if (page.complete) break;
        if (!page.lines.length) {
          const fresh = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/builds/{number}", { params: { path: { ...path, number: b.number } } }));
          if (FINISHED.has(fresh.status) && fresh.logLineCount <= after) break;
          await sleep(2000);
        }
      }
      return unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/builds/{number}", { params: { path: { ...path, number: b.number } } }));
    }),
  );

  const out = [];
  for (const r of results) {
    let installUrl: string | null = null;
    const mark = r.status === "succeeded" ? pc.green("✔") : r.status === "cancelled" ? pc.yellow("■") : pc.red("✖");
    p.log.message(`${mark} #${r.number} ${r.platform} ${r.status}${r.durationSec ? ` in ${Math.round(r.durationSec / 60)}m ${r.durationSec % 60}s` : ""}`);
    for (const a of r.artifacts.filter((a) => a.status === "ready")) {
      p.log.message(`  ${a.name} ${pc.dim(`(${(a.sizeBytes / 1024 / 1024).toFixed(1)} MB)`)}`);
    }
    // Internal (ad hoc) iOS builds: the page testers open on a registered iPhone to install it.
    if (r.status === "succeeded" && r.platform === "ios" && r.artifacts.some((a) => a.kind === "ipa" && a.status === "ready")) {
      const link = await lb.POST("/v1/orgs/{org}/projects/{project}/builds/{number}/install-link", { params: { path: { ...path, number: r.number } } });
      if (link.data) {
        installUrl = link.data.url;
        p.log.message(`  Install on a registered device: ${pc.cyan(link.data.url)}`);
        p.log.message((await QRCode.toString(link.data.url, { type: "terminal", small: true })).trimEnd());
      }
    }
    out.push({ ...summary(r), durationSec: r.durationSec, artifacts: r.artifacts, installUrl });
  }
  const failed = results.filter((r) => r.status !== "succeeded");
  p.outro(failed.length ? pc.red(`${failed.length} build${failed.length > 1 ? "s" : ""} did not succeed`) : "Done");
  if (failed.length) process.exitCode = 1;
  return { builds: out };
}
