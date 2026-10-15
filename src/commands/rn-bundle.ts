import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fail } from "../context.ts";
import { run } from "../project.ts";

/**
 * Bundles for CodePush and hot-updater apps (React Native without expo-updates), the way their own CLIs make
 * them: `react-native bundle`, then Hermes bytecode when the app uses Hermes, with the asset folders React
 * Native's asset resolver expects. The server zips these files as each client needs (CodePush in a
 * `CodePush/` folder, hot-updater at the root).
 */
export type RnClient = "codepush" | "hot-updater";
type Platform = "ios" | "android";
export type BundleFile = { path: string; abs: string; sha256: string; sizeBytes: number; contentType: string };

/** The file name each client loads the bundle from. */
export function bundleName(client: RnClient, platform: Platform) {
  if (platform === "android") return "index.android.bundle";
  return client === "codepush" ? "main.jsbundle" : "index.ios.bundle";
}

const contentTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ttf: "font/ttf", otf: "font/otf", json: "application/json", mp3: "audio/mpeg", mp4: "video/mp4" };

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    return statSync(abs).isDirectory() ? walk(abs) : [abs];
  });
}

/** The app's entry file, as `react-native bundle` would pick it. */
export function entryFile(cwd = process.cwd()) {
  for (const f of ["index.js", "index.ts", "index.tsx", "index.jsx"]) if (existsSync(join(cwd, f))) return f;
  fail("No index.js (or index.ts) entry file here: run this in your React Native app's folder.");
}

/** Hermes is on unless the native project turns it off (React Native's default since 0.70). */
export function usesHermes(platform: Platform, cwd = process.cwd()) {
  if (platform === "android") {
    const props = existsSync(join(cwd, "android/gradle.properties")) ? readFileSync(join(cwd, "android/gradle.properties"), "utf8") : "";
    return !/^\s*hermesEnabled\s*=\s*false/m.test(props);
  }
  const podfile = existsSync(join(cwd, "ios/Podfile")) ? readFileSync(join(cwd, "ios/Podfile"), "utf8") : "";
  return !/:hermes_enabled\s*=>\s*false/.test(podfile);
}

/** hermesc ships with React Native (older versions) or in the hermes-compiler package (newer ones). */
export function hermesc(cwd = process.cwd()) {
  const os = process.platform === "darwin" ? "osx-bin" : process.platform === "win32" ? "win64-bin" : "linux64-bin";
  const exe = process.platform === "win32" ? "hermesc.exe" : "hermesc";
  const candidates = [join(cwd, "node_modules/hermes-compiler/hermesc", os, exe), join(cwd, "node_modules/react-native/sdks/hermesc", os, exe)];
  const found = candidates.find((c) => existsSync(c));
  if (!found) fail(`Hermes is on, but hermesc wasn't found (looked in ${candidates.map((c) => relative(cwd, c)).join(", ")}). Run npm install.`);
  return found;
}

/** The binary's version, which CodePush and hot-updater (app-version strategy) match updates against. */
export function nativeAppVersion(platform: Platform, cwd = process.cwd()): string | null {
  if (platform === "android") {
    const gradle = ["android/app/build.gradle", "android/app/build.gradle.kts"].map((f) => join(cwd, f)).find(existsSync);
    const m = gradle && readFileSync(gradle, "utf8").match(/versionName\s*=?\s*["']([^"']+)["']/);
    return m ? m[1]! : null;
  }
  if (!existsSync(join(cwd, "ios"))) return null;
  const project = readdirSync(join(cwd, "ios")).find((d) => d.endsWith(".xcodeproj"));
  const pbx = project && join(cwd, "ios", project, "project.pbxproj");
  const m = pbx && existsSync(pbx) && readFileSync(pbx, "utf8").match(/MARKETING_VERSION = "?([^";]+)"?;/);
  return m ? m[1]! : null;
}

export async function exportRnBundles(client: RnClient, platforms: Platform[], env: Record<string, string>) {
  const out = join(tmpdir(), `liftbay-rn-${Date.now()}`);
  const entry = entryFile();
  const bundles = {} as Record<Platform, { launchAsset: string; files: BundleFile[] }>;
  for (const pl of platforms) {
    const dir = join(out, pl);
    mkdirSync(dir, { recursive: true });
    const name = bundleName(client, pl);
    const bundle = join(dir, name);
    await run("npx", ["react-native", "bundle", "--platform", pl, "--dev", "false", "--minify", "false", "--entry-file", entry, "--bundle-output", bundle, "--assets-dest", dir, "--reset-cache"], process.cwd(), env);
    if (usesHermes(pl)) {
      const hbc = `${bundle}.hbc`;
      await run(hermesc(), ["-emit-binary", "-O", "-w", "-out", hbc, bundle], process.cwd(), env);
      rmSync(bundle);
      renameSync(hbc, bundle);
    }
    const files = walk(dir).map((abs) => {
      const data = readFileSync(abs);
      const path = relative(dir, abs).split("\\").join("/");
      const ext = path.split(".").pop()!.toLowerCase();
      return { path, abs, sha256: createHash("sha256").update(data).digest("hex"), sizeBytes: data.length, contentType: path === name ? "application/javascript" : (contentTypes[ext] ?? "application/octet-stream") };
    });
    bundles[pl] = { launchAsset: name, files: [files.find((f) => f.path === name)!, ...files.filter((f) => f.path !== name)] };
  }
  return { out, bundles };
}
