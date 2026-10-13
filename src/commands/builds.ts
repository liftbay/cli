import { createWriteStream, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import pc from "picocolors";
import { client, cmd, dashboardUrl, fail, jsonMode, unwrap } from "../context.ts";
import { requireConfig } from "../project.ts";

const FINISHED = new Set(["succeeded", "failed", "cancelled"]);
const STATUSES = ["queued", "preparing", "running", "uploading", "succeeded", "failed", "cancelled"] as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function project() {
  const config = requireConfig();
  return { config, path: { org: config.org, project: config.project } };
}

function buildNumber(value: string) {
  const n = Number(value.replace(/^#/, ""));
  if (!Number.isInteger(n) || n < 1) fail(`"${value}" is not a build number`);
  return n;
}

const statusColor = (s: string) => (s === "succeeded" ? pc.green(s) : s === "failed" ? pc.red(s) : s === "cancelled" ? pc.yellow(s) : pc.cyan(s));
const duration = (sec: number | null) => (sec ? `${Math.floor(sec / 60)}m ${sec % 60}s` : "");

/** Recent builds, newest first. */
export async function buildsList(opts: { platform?: string; status?: string; limit?: string }) {
  const { config, path } = project();
  if (opts.platform && !["ios", "android"].includes(opts.platform)) fail("--platform must be ios or android");
  const status = opts.status?.split(",").map((s) => s.trim()) as (typeof STATUSES)[number][] | undefined;
  if (status && !status.every((s) => STATUSES.includes(s))) fail(`--status must be one or more of ${STATUSES.join(", ")}`);
  const limit = Number(opts.limit ?? 20);
  const all = await unwrap(
    client().GET("/v1/orgs/{org}/projects/{project}/builds", { params: { path, query: { platform: opts.platform as "ios" | "android" | undefined, status } } }),
  );
  const builds = all.slice(0, limit);
  if (!builds.length) console.log(`No builds yet. Start one with ${pc.cyan(cmd("liftbay build"))}`);
  for (const b of builds) {
    console.log(
      `${pc.bold(`#${b.number}`.padEnd(6))} ${b.platform.padEnd(8)} ${statusColor(b.status).padEnd(20)} ${b.profile.padEnd(12)} ${b.gitRef.padEnd(20)} ${pc.dim(`${duration(b.durationSec).padEnd(8)} ${b.message ?? ""}`)}`,
    );
  }
  return { builds: builds.map((b) => ({ ...b, url: `${dashboardUrl()}/${config.org}/${config.project}/builds/${b.number}` })) };
}

/** One build: status, phases and artifacts. */
export async function buildsView(number: string) {
  const { config, path } = project();
  const b = await unwrap(client().GET("/v1/orgs/{org}/projects/{project}/builds/{number}", { params: { path: { ...path, number: buildNumber(number) } } }));
  const url = `${dashboardUrl()}/${config.org}/${config.project}/builds/${b.number}`;
  console.log(`${pc.bold(`#${b.number}`)} ${b.platform} · ${statusColor(b.status)} · ${b.profile} · ${b.gitRef}${b.commit ? ` ${pc.dim(b.commit.slice(0, 7))}` : ""} · ${b.engine}`);
  if (b.message) console.log(pc.dim(b.message));
  for (const ph of b.phases) console.log(`  ${statusColor(ph.status).padEnd(20)} ${ph.name} ${pc.dim(duration(ph.durationSec ?? null))}`);
  for (const a of b.artifacts) console.log(`  ${a.kind.padEnd(6)} ${a.name} ${pc.dim(`${(a.sizeBytes / 1024 / 1024).toFixed(1)} MB · ${a.status}`)}`);
  // Internal (ad hoc) iOS builds install from a page opened on a registered device.
  let installUrl: string | null = null;
  if (b.status === "succeeded" && b.platform === "ios" && b.artifacts.some((a) => a.kind === "ipa" && a.status === "ready")) {
    const link = await client().POST("/v1/orgs/{org}/projects/{project}/builds/{number}/install-link", { params: { path: { ...path, number: b.number } } });
    installUrl = link.data?.url ?? null;
    if (installUrl) console.log(`  Install on a registered device: ${pc.cyan(installUrl)}`);
  }
  console.log(pc.dim(url));
  return { ...b, url, installUrl };
}

type LogLine = { seq?: number; phase: string | null; stream: string; text: string };

/** The build log: everything so far, then (with --follow) new lines until the build ends. */
export async function buildsLogs(number: string, opts: { follow?: boolean; tail?: string }) {
  const { path } = project();
  const lb = client();
  const n = buildNumber(number);
  const tail = opts.tail ? Number(opts.tail) : null;
  const collected: LogLine[] = [];
  const print = (l: LogLine) => {
    if (jsonMode()) return void collected.push(l);
    console.log(l.stream === "stderr" ? pc.red(l.text) : l.stream === "system" ? pc.dim(l.text) : l.text);
  };

  let after = 0;
  const backlog: LogLine[] = [];
  for (;;) {
    const page = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/builds/{number}/logs", { params: { path: { ...path, number: n }, query: { after } } }));
    backlog.push(...page.lines);
    after = page.nextSeq;
    if (page.complete || !page.lines.length) break;
  }
  for (const l of tail ? backlog.slice(-tail) : backlog) print(l);

  if (opts.follow) {
    for (;;) {
      const page = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/builds/{number}/logs", { params: { path: { ...path, number: n }, query: { after } } }));
      for (const l of page.lines) print(l);
      after = page.nextSeq;
      if (page.complete) break;
      if (!page.lines.length) {
        const b = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/builds/{number}", { params: { path: { ...path, number: n } } }));
        if (FINISHED.has(b.status) && b.logLineCount <= after) break;
        await sleep(2000);
      }
    }
  }
  const b = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/builds/{number}", { params: { path: { ...path, number: n } } }));
  return { number: n, status: b.status, lines: collected.map(({ phase, stream, text }) => ({ phase, stream, text })) };
}

export async function buildsCancel(number: string) {
  const { path } = project();
  const b = await unwrap(client().POST("/v1/orgs/{org}/projects/{project}/builds/{number}/cancel", { params: { path: { ...path, number: buildNumber(number) } } }));
  console.log(`${pc.green("✔")} Cancel requested for #${b.number} (${b.status})`);
  return { number: b.number, status: b.status, cancelRequested: b.cancelRequested };
}

/** Saves a build's artifacts (.ipa, .apk, .aab, …) into a folder. */
export async function buildsDownload(number: string, opts: { kind?: string; out?: string }) {
  const { path } = project();
  const lb = client();
  const b = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/builds/{number}", { params: { path: { ...path, number: buildNumber(number) } } }));
  const ready = b.artifacts.filter((a) => a.status === "ready" && (!opts.kind || a.kind === opts.kind));
  if (!ready.length) fail(opts.kind ? `Build #${b.number} has no ready ${opts.kind} artifact` : `Build #${b.number} has no ready artifacts (${b.status})`);
  const dir = resolve(opts.out ?? ".");
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const a of ready) {
    const link = await unwrap(
      lb.GET("/v1/orgs/{org}/projects/{project}/builds/{number}/artifacts/{artifactId}/download", {
        params: { path: { ...path, number: b.number, artifactId: a.id }, query: { redirect: "false" } },
      }),
    );
    const url = (link as { url: string }).url;
    const res = await fetch(url);
    if (!res.ok || !res.body) fail(`Download failed for ${a.name} (${res.status})`);
    const file = join(dir, a.name);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
    console.log(`${pc.green("✔")} ${file} ${pc.dim(`(${(a.sizeBytes / 1024 / 1024).toFixed(1)} MB)`)}`);
    files.push({ kind: a.kind, name: a.name, path: file, sizeBytes: a.sizeBytes });
  }
  return { number: b.number, files };
}

export async function submissionsList(opts: { limit?: string }) {
  const { config, path } = project();
  const all = await unwrap(client().GET("/v1/orgs/{org}/projects/{project}/submissions", { params: { path } }));
  const list = all.slice(0, Number(opts.limit ?? 20));
  if (!list.length) console.log(`No submissions yet. Submit a store build with ${pc.cyan(cmd("liftbay submit"))}`);
  for (const s of list) {
    const target = s.target === "testflight" ? "TestFlight" : `Play ${s.target}`;
    console.log(`${pc.bold(`#${s.buildNumber}`.padEnd(6))} ${s.platform.padEnd(8)} ${target.padEnd(16)} ${statusColor(s.status).padEnd(20)} ${pc.dim(s.message ?? "")} ${pc.dim(s.id)}`);
  }
  return { submissions: list, url: `${dashboardUrl()}/${config.org}/${config.project}/submissions` };
}

export async function submissionsView(id: string) {
  const { path } = project();
  const s = await unwrap(client().GET("/v1/orgs/{org}/projects/{project}/submissions/{submission}", { params: { path: { ...path, submission: id } } }));
  console.log(`${pc.bold(`#${s.buildNumber}`)} ${s.platform} → ${s.target} · ${statusColor(s.status)}${s.message ? ` · ${s.message}` : ""}`);
  for (const e of s.events) console.log(`  ${pc.dim(new Date(e.ts).toLocaleTimeString())} ${e.text}`);
  return s;
}
