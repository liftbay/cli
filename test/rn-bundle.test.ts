import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundleName, nativeAppVersion, usesHermes } from "../src/commands/rn-bundle.ts";

function app(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "lb-rn-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

describe("React Native bundles for CodePush and hot-updater", () => {
  it("names the bundle the way each client loads it", () => {
    expect(bundleName("codepush", "android")).toBe("index.android.bundle");
    expect(bundleName("codepush", "ios")).toBe("main.jsbundle");
    expect(bundleName("hot-updater", "android")).toBe("index.android.bundle");
    expect(bundleName("hot-updater", "ios")).toBe("index.ios.bundle");
  });

  it("reads the binary's version from the native projects", () => {
    const dir = app({
      "android/app/build.gradle": 'android {\n  defaultConfig {\n    versionCode 7\n    versionName "1.4.2"\n  }\n}',
      "ios/Lab.xcodeproj/project.pbxproj": "buildSettings = {\n MARKETING_VERSION = 2.0;\n};",
    });
    expect(nativeAppVersion("android", dir)).toBe("1.4.2");
    expect(nativeAppVersion("ios", dir)).toBe("2.0");
    expect(nativeAppVersion("android", app({ "android/app/build.gradle.kts": 'versionName = "3.1.0"' }))).toBe("3.1.0");
    expect(nativeAppVersion("ios", app({}))).toBeNull();
  });

  it("uses Hermes unless the native project turns it off", () => {
    expect(usesHermes("android", app({ "android/gradle.properties": "newArchEnabled=true\nhermesEnabled=true" }))).toBe(true);
    expect(usesHermes("android", app({ "android/gradle.properties": "hermesEnabled=false" }))).toBe(false);
    expect(usesHermes("ios", app({ "ios/Podfile": "use_react_native!(\n  :hermes_enabled => false\n)" }))).toBe(false);
    expect(usesHermes("ios", app({ "ios/Podfile": "use_react_native!()" }))).toBe(true);
  });
});

describe("update signing keys", () => {
  it("writes PEM with plain newlines (CodePush on iOS can't read \\r\\n keys)", async () => {
    const { generateSigningCertificate } = await import("../src/commands/signing.ts");
    const g = generateSigningCertificate("test");
    for (const pem of [g.privateKeyPem, g.publicKeyPem, g.certificatePem]) expect(pem).not.toContain("\r");
  });
});
