import { readFileSync } from "node:fs";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { client, dashboardUrl, fail, unwrap } from "../context.ts";
import { requireConfig } from "../project.ts";

type Platform = "ios" | "android";
type SubmitOptions = { build?: string; latest?: boolean; platform?: string; track?: string; rollout?: string; wait?: boolean };

const TRACKS = ["internal", "alpha", "beta", "production"] as const;
const DONE = new Set(["succeeded", "failed"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Uploads a successful store build to TestFlight (iOS) or a Google Play track (Android), then follows it. */
export async function submit(opts: SubmitOptions) {
  const config = requireConfig();
  const lb = client();
  const path = { org: config.org, project: config.project };
  const track = opts.track as (typeof TRACKS)[number] | undefined;
  if (track && !TRACKS.includes(track)) fail(`--track must be one of ${TRACKS.join(", ")}`);
  const rolloutPercent = opts.rollout ? Number(opts.rollout) : undefined;
  if (rolloutPercent !== undefined && !(rolloutPercent >= 1 && rolloutPercent <= 100)) fail("--rollout must be between 1 and 100");

  const requests: { buildNumber?: number; platform?: Platform }[] = opts.build
    ? [{ buildNumber: Number(opts.build) }]
    : (!opts.platform || opts.platform === "all" ? (["ios", "android"] as Platform[]) : [opts.platform as Platform]).map((platform) => ({ platform }));
  if (!opts.build && opts.platform && !["ios", "android", "all"].includes(opts.platform)) fail("--platform must be ios, android or all");

  p.intro(pc.bgCyan(pc.black(" liftbay submit ")));
  const queued = [];
  for (const r of requests) {
    const s = await unwrap(lb.POST("/v1/orgs/{org}/projects/{project}/submissions", { params: { path }, body: { ...r, track, rolloutPercent } }));
    p.log.step(`Build ${pc.bold(`#${s.buildNumber}`)} → ${s.target === "testflight" ? "TestFlight" : `Play ${s.target}${s.rolloutPercent ? ` (${s.rolloutPercent}%)` : ""}`}`);
    queued.push(s);
  }
  if (opts.wait === false) return p.outro(`Queued. Follow along in the dashboard: ${pc.dim(`${dashboardUrl()}/${config.org}/${config.project}/submissions`)}`);

  const results = await Promise.all(
    queued.map(async (s) => {
      let shown = 0;
      for (;;) {
        const d = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/submissions/{submission}", { params: { path: { ...path, submission: s.id } } }));
        for (const e of d.events.slice(shown)) p.log.message(`${pc.dim(s.platform.padEnd(8))}${e.text}`);
        shown = d.events.length;
        if (DONE.has(d.status)) return d;
        await sleep(3000);
      }
    }),
  );
  const failed = results.filter((r) => r.status !== "succeeded");
  for (const r of results) p.log.message(`${r.status === "succeeded" ? pc.green("✔") : pc.red("✖")} #${r.buildNumber} ${r.message ?? r.status}`);
  p.outro(failed.length ? pc.red(`${failed.length} submission${failed.length > 1 ? "s" : ""} failed`) : "Submitted");
  if (failed.length) process.exitCode = 1;
}

/** Saves the Google Play service account used for Play uploads. */
export async function credentialsAndroidCommand(opts: { playKey?: string; remove?: boolean }) {
  const config = requireConfig();
  const lb = client();
  const path = { org: config.org, project: config.project };
  if (opts.remove) {
    await unwrap(lb.DELETE("/v1/orgs/{org}/projects/{project}/stores/google-play", { params: { path } }));
    return console.log(`${pc.green("✔")} Removed the Google Play service account`);
  }
  if (!opts.playKey) {
    const status = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/stores/google-play", { params: { path } }));
    return console.log(status ? `Google Play service account: ${status.clientEmail}` : `No Google Play service account. Add one with ${pc.cyan("liftbay credentials android --play-key key.json")}`);
  }
  let json: string;
  try {
    json = readFileSync(opts.playKey.replace(/^~/, process.env.HOME ?? "~"), "utf8");
  } catch {
    fail(`Can't read ${opts.playKey}`);
  }
  const spin = p.spinner();
  spin.start("Checking the service account with Google Play");
  const status = await unwrap(lb.PUT("/v1/orgs/{org}/projects/{project}/stores/google-play", { params: { path }, body: { serviceAccountJson: json } })).catch((e) => {
    spin.error("Google Play rejected the service account");
    throw e;
  });
  spin.stop(`Saved (encrypted): ${status?.clientEmail}`);
}
