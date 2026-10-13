import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { client, dashboardUrl, fail, unwrap } from "../context.ts";
import { expoConfig, output, requireConfig, run } from "../project.ts";
import { loadPrivateKey, signDraft } from "./signing.ts";

type Platform = "ios" | "android";
type ExportedFile = { path: string; abs: string; sha256: string; sizeBytes: number; contentType: string };

const contentTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  otf: "font/otf",
  json: "application/json",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

function file(dir: string, rel: string, virtualPath: string, contentType: string): ExportedFile {
  const data = readFileSync(join(dir, rel));
  return { path: virtualPath, abs: join(dir, rel), sha256: createHash("sha256").update(data).digest("hex"), sizeBytes: data.length, contentType };
}

/** Runs `expo export` and turns its metadata.json into one file list per platform. */
async function exportBundles(platforms: Platform[]) {
  const out = mkdtempSync(join(tmpdir(), "liftbay-export-"));
  await run("npx", ["expo", "export", "--output-dir", out, "--dump-assetmap", ...platforms.flatMap((pl) => ["--platform", pl])]);
  const meta = JSON.parse(readFileSync(join(out, "metadata.json"), "utf8")) as {
    fileMetadata: Record<Platform, { bundle: string; assets: { path: string; ext: string }[] }>;
  };
  const bundles = {} as Record<Platform, { launchAsset: string; files: ExportedFile[] }>;
  for (const pl of platforms) {
    const m = meta.fileMetadata[pl];
    if (!m) fail(`expo export produced no ${pl} bundle`);
    const files = [file(out, m.bundle, m.bundle, "application/javascript"), ...m.assets.map((a) => file(out, a.path, `${a.path}.${a.ext}`, contentTypes[a.ext] ?? "application/octet-stream"))];
    bundles[pl] = { launchAsset: m.bundle, files };
  }
  return { out, bundles };
}

/** The runtime version each platform's binary reports, resolved by expo-updates itself. */
async function runtimeVersion(platform: Platform): Promise<string> {
  const raw = await output("npx", ["expo-updates", "runtimeversion:resolve", "--platform", platform]);
  const parsed = JSON.parse(raw.trim().split("\n").pop()!) as { runtimeVersion: string | null };
  if (!parsed.runtimeVersion) fail(`Could not resolve the ${platform} runtime version. Set runtimeVersion in app.json (liftbay ota init does this).`);
  return parsed.runtimeVersion;
}

export async function publish(opts: { channel?: string; profile?: string; message?: string; platform?: string; rollout?: string; mandatory?: boolean; privateKey?: string }) {
  const config = requireConfig();
  const lb = client();
  const channel = opts.channel ?? (opts.profile ? config.build?.profiles[opts.profile]?.channel : undefined) ?? "production";
  const platforms: Platform[] = !opts.platform || opts.platform === "all" ? ["ios", "android"] : [opts.platform as Platform];
  const path = { org: config.org, project: config.project };
  const message = opts.message ?? (() => {
    try {
      return execFileSync("git", ["log", "-1", "--pretty=%s"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "Update";
    }
  })();
  const gitRef = (() => {
    try {
      return {
        ref: execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(),
        commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(),
      };
    } catch {
      return null;
    }
  })();

  p.intro(pc.bgCyan(pc.black(" liftbay update publish ")));
  if (!platforms.every((x) => x === "ios" || x === "android")) fail("--platform must be ios, android or all");
  p.log.step(`Exporting ${platforms.join(" and ")} bundles`);
  const { out, bundles } = await exportBundles(platforms);
  try {
    // Group platforms by runtime version: each group is one release.
    const groups = new Map<string, Platform[]>();
    for (const pl of platforms) {
      const rv = await runtimeVersion(pl);
      groups.set(rv, [...(groups.get(rv) ?? []), pl]);
    }
    const appConfig = await expoConfig();

    const all = platforms.flatMap((pl) => bundles[pl].files);
    const spin = p.spinner();
    spin.start("Checking which files are new");
    const prep = await unwrap(
      lb.POST("/v1/orgs/{org}/projects/{project}/updates/files", { params: { path }, body: { files: all.map((f) => ({ sha256: f.sha256, sizeBytes: f.sizeBytes, contentType: f.contentType })) } }),
    );
    const bySha = new Map(all.map((f) => [f.sha256, f]));
    let done = 0;
    for (const m of prep.missing) {
      const f = bySha.get(m.sha256)!;
      spin.message(`Uploading ${++done}/${prep.missing.length}: ${f.path}`);
      const res = await fetch(m.uploadUrl, { method: "PUT", body: readFileSync(f.abs), headers: { "Content-Type": f.contentType } });
      if (!res.ok) fail(`Upload failed for ${f.path} (${res.status})`);
    }
    spin.stop(`${all.length} files: ${prep.missing.length} uploaded, ${prep.alreadyStored} already stored`);

    // With an update signing key, Liftbay prepares the exact bytes and this machine signs them.
    const key = loadPrivateKey(opts.privateKey);
    const published = [];
    if (key) p.log.info(`Signing with ${pc.cyan(key.source)}`);
    for (const [runtime, group] of groups) {
      const body = {
        message,
        runtimeVersion: runtime,
        rolloutPercent: Number(opts.rollout ?? 100),
        mandatory: !!opts.mandatory,
        gitRef: gitRef?.ref ?? null,
        commit: gitRef?.commit ?? null,
        appConfig,
        bundles: Object.fromEntries(
          group.map((pl) => [pl, { launchAsset: bundles[pl].launchAsset, files: bundles[pl].files.map(({ path, sha256, contentType, sizeBytes }) => ({ path, sha256, contentType, sizeBytes })) }]),
        ),
      };
      const request = key
        ? (async () => {
            const draft = await unwrap(lb.POST("/v1/orgs/{org}/projects/{project}/channels/{channel}/releases/sign", { params: { path: { ...path, channel } }, body }));
            return lb.POST("/v1/orgs/{org}/projects/{project}/channels/{channel}/releases/sign/{draftId}", {
              params: { path: { ...path, channel, draftId: draft.draftId } },
              body: { signatures: signDraft(draft.items, key.pem) },
            });
          })()
        : lb.POST("/v1/orgs/{org}/projects/{project}/channels/{channel}/releases", { params: { path: { ...path, channel } }, body });
      const release = await unwrap(request);
      // An emergency publish on Free past its monthly publishes, or the bandwidth limit is reached.
      const notice = (await request).response.headers.get("Liftbay-Notice");
      if (notice) p.log.warn(notice);
      published.push({ id: release.id, channel, runtimeVersion: runtime, platforms: group, rolloutPercent: release.rolloutPercent, signed: release.signed, message, notice });
      p.log.success(
        `Published to ${pc.bold(channel)} · runtime ${runtime} · ${group.join(", ")}${release.rolloutPercent < 100 ? ` · ${release.rolloutPercent}% rollout` : ""}${release.signed ? " · signed" : ""}`,
      );
    }
    const url = `${dashboardUrl()}/${config.org}/${config.project}/updates/${channel}`;
    p.outro(pc.dim(url));
    return { releases: published, url };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

export async function list(opts: { channel?: string }) {
  const config = requireConfig();
  const channel = opts.channel ?? "production";
  const releases = await unwrap(client().GET("/v1/orgs/{org}/projects/{project}/channels/{channel}/releases", { params: { path: { org: config.org, project: config.project, channel } } }));
  if (!releases.length) console.log(`No releases on ${channel} yet.`);
  for (const r of releases.slice(0, 20)) {
    const status = r.status === "active" ? pc.green("active") : r.status === "rolled_back" ? pc.red("rolled back") : pc.dim("superseded");
    console.log(`${new Date(r.createdAt).toLocaleString().padEnd(24)} ${status.padEnd(22)} ${String(r.rolloutPercent).padStart(3)}%  ${pc.dim(r.runtimeVersion.padEnd(10))} ${r.message}`);
  }
  return { channel, releases: releases.slice(0, 20) };
}

async function activeRelease(channel: string) {
  const config = requireConfig();
  const path = { org: config.org, project: config.project, channel };
  const releases = await unwrap(client().GET("/v1/orgs/{org}/projects/{project}/channels/{channel}/releases", { params: { path } }));
  const active = releases.find((r) => r.status === "active") ?? fail(`No active release on ${channel}`);
  return { path, active };
}

export async function rollback(opts: { channel?: string }) {
  const { path, active } = await activeRelease(opts.channel ?? "production");
  const request = client().POST("/v1/orgs/{org}/projects/{project}/channels/{channel}/releases/{release}/rollback", { params: { path: { ...path, release: active.id } } });
  const res = await unwrap(request);
  console.log(`${pc.green("✔")} Rolled back "${active.message}". ${res.active ? "The previous release is active again." : "Devices return to the bundle built into the app."}`);
  // The plan's OTA bandwidth is used up: the rollback still reaches devices, newer updates wait.
  const notice = (await request).response.headers.get("Liftbay-Notice");
  if (notice) console.log(`${pc.yellow("!")} ${notice}`);
  return { rolledBack: { id: active.id, message: active.message }, active: res.active, notice };
}

export async function rollout(percent: string, opts: { channel?: string }) {
  const { path, active } = await activeRelease(opts.channel ?? "production");
  const r = await unwrap(
    client().PATCH("/v1/orgs/{org}/projects/{project}/channels/{channel}/releases/{release}/rollout", { params: { path: { ...path, release: active.id } }, body: { rolloutPercent: Number(percent) } }),
  );
  console.log(`${pc.green("✔")} "${r.message}" now rolls out to ${r.rolloutPercent}%`);
  return { id: r.id, message: r.message, rolloutPercent: r.rolloutPercent };
}

export async function channels() {
  const config = requireConfig();
  const list = await unwrap(client().GET("/v1/orgs/{org}/projects/{project}/channels", { params: { path: { org: config.org, project: config.project } } }));
  for (const c of list) console.log(`${pc.bold(c.name.padEnd(16))} env ${c.environmentSlug.padEnd(12)} ${c.protocols.join(", ").padEnd(32)} ${pc.dim(c.currentRelease?.message ?? "no active release")}`);
  return { channels: list };
}
