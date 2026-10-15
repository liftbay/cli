import * as p from "@clack/prompts";
import pc from "picocolors";
import QRCode from "qrcode";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { currentWorkflow, WORKFLOW_PATH } from "../workflow.ts";
import { client, cmd, dashboardUrl, fail, isInteractive, poll, unwrap } from "../context.ts";
import { setUpIos } from "./credentials.ts";
import { cancelled } from "./link.ts";
import { requireConfig } from "../project.ts";
import { ensureGithub } from "./github.ts";
import { fit } from "../prompts.ts";
import { whyItFailed } from "../failure.ts";
import type { components } from "@liftbay/sdk";

type Platform = "ios" | "android";
type Build = components["schemas"]["Build"];
type Engine = "auto" | "github-actions" | "xcode-cloud";
type BuildOptions = { platform?: string; profile?: string; ref?: string; message?: string; simulator?: boolean; wait?: boolean; submit?: boolean; track?: string; engine?: string; logs?: boolean };
type Lb = ReturnType<typeof client>;
type ProjectPath = { org: string; project: string };

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

const minutes = (sec: number | null | undefined) => (sec ? (sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`) : "");

/** What a build is doing right now, in a few words. */
function activity(b: Build): string {
  if (b.status === "queued") return b.engine === "xcode-cloud" ? "Waiting for Xcode Cloud" : "Waiting for a runner";
  if (b.status === "preparing") return "Starting";
  if (b.status === "uploading") return "Uploading";
  return b.phases.find((ph) => ph.status === "running")?.name ?? "Building";
}

/**
 * Follows builds step by step: a spinner with what each is doing, and a line per finished step. Reads only
 * the build's status and phases, never its log, so it stays quiet however much the build prints.
 */
export async function followSteps(lb: Lb, path: ProjectPath, started: Build[]): Promise<Build[]> {
  const tag = (b: Build) => (started.length > 1 ? `${b.platform === "ios" ? "iOS" : "Android"} · ` : "");
  const shown = new Map<number, Set<string>>(started.map((b) => [b.number, new Set<string>()]));
  const latest = new Map<number, Build>(started.map((b) => [b.number, b]));
  const runnerSeen = new Set<number>();
  // No guide bar: restarted after every step line, the spinner would otherwise add a "│" spacer each time.
  const spin = p.spinner({ withGuide: false });
  spin.start(fit(started.map((b) => `${tag(b)}${activity(b)}`).join("   ")));
  const say = (line: string) => {
    spin.clear();
    // One line per step, without the blank spacer line clack's log adds: a build has many steps.
    process.stdout.write(`${pc.gray("│")}  ${line}\n`);
    spin.start(fit(started.map((b) => `${tag(b)}${activity(latest.get(b.number)!)}`).join("   ")));
  };
  for (;;) {
    for (const b of started) {
      const prev = latest.get(b.number)!;
      if (FINISHED.has(prev.status)) continue;
      const fresh = await poll(() => unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/builds/{number}", { params: { path: { ...path, number: b.number } } })));
      latest.set(b.number, fresh);
      if (fresh.status !== "queued" && !runnerSeen.has(b.number)) {
        runnerSeen.add(b.number);
        say(`${pc.green("✔")} ${tag(b)}${fresh.engine === "xcode-cloud" ? "Xcode Cloud started" : "Runner started"}`);
      }
      for (const ph of fresh.phases) {
        if (ph.status === "running" || ph.status === "queued" || shown.get(b.number)!.has(ph.name)) continue;
        shown.get(b.number)!.add(ph.name);
        const mark = ph.status === "succeeded" ? pc.green("✔") : ph.status === "cancelled" ? pc.yellow("■") : pc.red("✖");
        say(`${mark} ${tag(b)}${ph.name} ${pc.dim(minutes(ph.durationSec))}`);
      }
    }
    const all = [...latest.values()];
    if (all.every((b) => FINISHED.has(b.status))) {
      spin.stop(all.every((b) => b.status === "succeeded") ? "Finished" : "Finished with problems");
      return all;
    }
    spin.message(fit(all.map((b) => `${tag(b)}${FINISHED.has(b.status) ? b.status : activity(b)}`).join("   ")));
    await sleep(3000);
  }
}

/** The whole build log as it happens (--logs); with more than one build, lines carry the platform. */
async function followLogs(lb: Lb, path: ProjectPath, started: Build[]): Promise<Build[]> {
  const prefix = started.length > 1;
  return Promise.all(
    started.map(async (b) => {
      let after = 0;
      let phase: string | null = null;
      for (;;) {
        const page = await poll(() => unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/builds/{number}/logs", { params: { path: { ...path, number: b.number }, query: { after } } })));
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
          const fresh = await poll(() => unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/builds/{number}", { params: { path: { ...path, number: b.number } } })));
          if (FINISHED.has(fresh.status) && fresh.logLineCount <= after) break;
          await sleep(2000);
        }
      }
      return poll(() => unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/builds/{number}", { params: { path: { ...path, number: b.number } } })));
    }),
  );
}

/** Every line of a build's log, page by page (a few thousand lines for a typical build). */
type LinkBuild = { number: number; platform: string; distributionKind?: string; artifacts: { kind: string; status: string }[] };

/**
 * The link to a finished build: an install page for an ad hoc .ipa or an .apk (open it on the phone, or scan
 * its QR code), a download page for anything else. Null when the build has no app.
 */
export async function installLink(lb: ReturnType<typeof client>, path: { org: string; project: string }, b: LinkBuild) {
  const ready = new Set(b.artifacts.filter((a) => a.status === "ready").map((a) => a.kind));
  if (!["ipa", "apk", "aab", "app"].some((k) => ready.has(k))) return null;
  const link = await lb.POST("/v1/orgs/{org}/projects/{project}/builds/{number}/install-link", { params: { path: { ...path, number: b.number } } });
  if (!link.data) return null;
  const adhoc = ready.has("ipa") && b.distributionKind === "internal";
  const apk = !ready.has("ipa") && ready.has("apk");
  const label = adhoc ? "Install on a registered iPhone" : apk ? "Install on an Android phone" : "Download";
  return { url: link.data.url, label, phone: adhoc || apk };
}

export async function fetchLog(lb: Lb, path: ProjectPath, number: number, limit = 50_000) {
  const lines: { text: string; stream: string; phase: string | null }[] = [];
  let after = 0;
  while (lines.length < limit) {
    const page = await poll(() => unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/builds/{number}/logs", { params: { path: { ...path, number }, query: { after } } })));
    lines.push(...page.lines);
    after = page.nextSeq;
    if (page.complete || !page.lines.length) break;
  }
  return lines;
}

/**
 * Why a failed build failed, in its build tool's own words (see failure.ts); the end of the log when no tool
 * marked an error. The whole log is one command away.
 */
async function printFailure(lb: Lb, path: ProjectPath, b: Build, tagged: boolean) {
  const log = await fetchLog(lb, path, b.number).catch(() => []);
  if (!log.length) return [];
  const why = whyItFailed(log);
  const label = `${tagged ? `${b.platform === "ios" ? "iOS" : "Android"} · ` : ""}build #${b.number} failed`;
  if (why.length) {
    p.log.error(`${label}. Why:`);
    console.log(why.map((l) => `  ${pc.red(l)}`).join("\n"));
  } else {
    p.log.error(`${label}. The end of its log:`);
    console.log(log.slice(-30).map((l) => (l.stream === "stderr" ? pc.red(l.text) : pc.dim(l.text))).join("\n"));
  }
  p.log.info(`Whole log: ${pc.cyan(cmd(`liftbay builds logs ${b.number}`))}`);
  return why;
}

/** Files `liftbay init` writes or changes; uncommitted, they're the setup the build would be missing. */
const SETUP_FILES = ["liftbay.json", ".github/workflows/liftbay.yml", "app.json", "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"];

function git(args: string[]) {
  // trimEnd, not trim: `git status --porcelain` lines start with a space (" M file") that's part of the format.
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
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
  // The build runs the workflow file on this branch: missing or out of date, offer the current one first.
  const wanted = await currentWorkflow();
  const present = existsSync(WORKFLOW_PATH) ? readFileSync(WORKFLOW_PATH, "utf8") : null;
  if (present !== wanted) {
    const what = present === null ? `${WORKFLOW_PATH} isn't in this repository` : `${WORKFLOW_PATH} is out of date`;
    if (!interactive) fail(`${what}. Update it with \`liftbay ci init --yes\`, then commit and push it.`);
    p.log.warn(`${what}${present === null ? "" : " (Liftbay changed how builds run)"}.`);
    if (cancelled(await p.confirm({ message: present === null ? "Add it?" : "Update it?", initialValue: true }))) {
      mkdirSync(dirname(WORKFLOW_PATH), { recursive: true });
      writeFileSync(WORKFLOW_PATH, wanted);
      p.log.success(`${present === null ? "Added" : "Updated"} ${WORKFLOW_PATH}`);
    } else if (present === null) {
      fail(`Builds need ${WORKFLOW_PATH} on ${branch}. Run \`liftbay ci init\` to add it.`);
    }
  }
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

  // Like EAS: progress by default (each step as it finishes), the full log with --logs or `liftbay builds logs`.
  const results = opts.logs ? await followLogs(lb, path, started) : await followSteps(lb, path, started);
  const reasons = new Map<number, string[]>();
  for (const r of results.filter((r) => r.status === "failed")) reasons.set(r.number, await printFailure(lb, path, r, started.length > 1));

  const out = [];
  for (const r of results) {
    let installUrl: string | null = null;
    const mark = r.status === "succeeded" ? pc.green("✔") : r.status === "cancelled" ? pc.yellow("■") : pc.red("✖");
    p.log.message(`${mark} #${r.number} ${r.platform} ${r.status}${r.durationSec ? ` in ${Math.round(r.durationSec / 60)}m ${r.durationSec % 60}s` : ""}`);
    for (const a of r.artifacts.filter((a) => a.status === "ready")) {
      p.log.message(`  ${a.name} ${pc.dim(`(${(a.sizeBytes / 1024 / 1024).toFixed(1)} MB)`)}`);
    }
    if (r.status === "succeeded") {
      const link = await installLink(lb, path, r);
      installUrl = link?.url ?? null;
      if (link) p.log.message(`  ${link.label}: ${pc.cyan(link.url)}`);
      if (link?.phone) p.log.message((await QRCode.toString(link.url, { type: "terminal", small: true })).trimEnd());
    }
    out.push({ ...summary(r), durationSec: r.durationSec, artifacts: r.artifacts, installUrl, ...(reasons.has(r.number) ? { failure: reasons.get(r.number) } : {}) });
  }
  const failed = results.filter((r) => r.status !== "succeeded");
  p.outro(failed.length ? pc.red(`${failed.length} build${failed.length > 1 ? "s" : ""} did not succeed`) : "Done");
  if (failed.length) process.exitCode = 1;
  return { builds: out };
}
