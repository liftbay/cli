import * as p from "@clack/prompts";
import pc from "picocolors";
import QRCode from "qrcode";
import { execFileSync } from "node:child_process";
import { client, dashboardUrl, fail, isInteractive, unwrap } from "../context.ts";
import { setUpIos } from "./credentials.ts";
import { cancelled } from "./link.ts";
import { requireConfig } from "../project.ts";

type Platform = "ios" | "android";
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

/** Queues one build per platform on the customer's GitHub Actions, then follows the logs until they finish. */
export async function build(opts: BuildOptions) {
  const config = requireConfig();
  const lb = client();
  const profileName = opts.profile ?? "production";
  const profile = config.build?.profiles[profileName] ?? fail(`No build profile "${profileName}" in liftbay.json. Run \`liftbay ci init\`.`);
  const platforms: Platform[] = !opts.platform || opts.platform === "all" ? profile.platforms : [opts.platform as Platform];
  if (!platforms.every((x) => x === "ios" || x === "android")) fail("--platform must be ios, android or all");
  const gitRef = opts.ref ?? currentBranch() ?? "main";
  const engine = (opts.engine ?? "auto") as Engine;
  if (!["auto", "github-actions", "xcode-cloud"].includes(engine)) fail("--engine must be auto, github-actions or xcode-cloud");
  const path = { org: config.org, project: config.project };

  p.intro(pc.bgCyan(pc.black(" liftbay build ")));

  // Like EAS: the first signed iOS build offers to set up signing instead of quietly building for the simulator.
  if (platforms.includes("ios") && !opts.simulator) {
    const signing = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/signing", { params: { path } }));
    if (!signing.ios) {
      if (isInteractive() && cancelled(await p.confirm({ message: "iOS signing isn't set up. Sign in with your Apple ID and set it up now?", initialValue: true }))) {
        await setUpIos({});
      } else {
        p.log.warn(`No iOS signing yet: this iOS build is a simulator build. Run ${pc.cyan("liftbay credentials ios")} for signed builds.`);
      }
    }
  }
  const submit = !opts.simulator && (opts.submit ?? profile.submit ?? false);
  const submitTrack = (opts.track ?? profile.submitTrack) as (typeof TRACKS)[number] | undefined;
  if (submitTrack && !TRACKS.includes(submitTrack)) fail(`--track must be one of ${TRACKS.join(", ")}`);
  if (submit && profile.distribution !== "store") fail(`Profile "${profileName}" builds for ${profile.distribution} distribution; only store builds can be submitted`);
  const started = [];
  for (const platform of platforms) {
    const distribution = opts.simulator ? "simulator" : profile.distribution;
    const b = await unwrap(
      lb.POST("/v1/orgs/{org}/projects/{project}/builds", {
        params: { path },
        body: { platform, profile: profileName, environment: profile.environment, gitRef, message: opts.message, engine, distribution, ...(submit ? { submit: true, submitTrack } : {}) },
      }),
    );
    p.log.step(
      `Build ${pc.bold(`#${b.number}`)} · ${platform} · ${profileName} · ${gitRef} · ${b.engine === "xcode-cloud" ? "Xcode Cloud" : "GitHub Actions"}${submit ? ` · then ${platform === "ios" ? "TestFlight" : `Play ${submitTrack ?? "internal"}`}` : ""} ${pc.dim(`${dashboardUrl()}/${config.org}/${config.project}/builds/${b.number}`)}`,
    );
    started.push(b);
  }
  if (opts.wait === false) return p.outro("Queued. Follow along in the dashboard.");

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

  for (const r of results) {
    const mark = r.status === "succeeded" ? pc.green("✔") : r.status === "cancelled" ? pc.yellow("■") : pc.red("✖");
    p.log.message(`${mark} #${r.number} ${r.platform} ${r.status}${r.durationSec ? ` in ${Math.round(r.durationSec / 60)}m ${r.durationSec % 60}s` : ""}`);
    for (const a of r.artifacts.filter((a) => a.status === "ready")) {
      p.log.message(`  ${a.name} ${pc.dim(`(${(a.sizeBytes / 1024 / 1024).toFixed(1)} MB)`)}`);
    }    // Internal (ad hoc) iOS builds: the page testers open on a registered iPhone to install it.
    if (r.status === "succeeded" && r.platform === "ios" && r.artifacts.some((a) => a.kind === "ipa" && a.status === "ready")) {
      const link = await lb.POST("/v1/orgs/{org}/projects/{project}/builds/{number}/install-link", { params: { path: { ...path, number: r.number } } });
      if (link.data) {
        p.log.message(`  Install on a registered device: ${pc.cyan(link.data.url)}`);
        p.log.message((await QRCode.toString(link.data.url, { type: "terminal", small: true })).trimEnd());
      }
    }
  }
  const failed = results.filter((r) => r.status !== "succeeded");
  p.outro(failed.length ? pc.red(`${failed.length} build${failed.length > 1 ? "s" : ""} did not succeed`) : "Done");
  if (failed.length) process.exitCode = 1;
}
