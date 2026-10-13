import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEnv, readEasProfiles, serializeEnv, visibilityFor } from "../src/commands/env.ts";

describe(".env files", () => {
  it("reads comments, export, quotes and escapes", () => {
    const { vars, invalid } = parseEnv(
      ['# comment', 'export A=1', 'B="two words"', "C='single $x'", 'D="line\\nbreak"', 'E=plain # trailing', 'not a line', ''].join("\n"),
    );
    expect(vars).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "two words" },
      { key: "C", value: "single $x" },
      { key: "D", value: "line\nbreak" },
      { key: "E", value: "plain" },
    ]);
    expect(invalid).toEqual([7]);
  });

  it("writes what it reads", () => {
    const vars = [
      { key: "URL", value: "https://api.example.com/?a=1" },
      { key: "MULTI", value: 'a "quoted"\nvalue with # hash' },
      { key: "EMPTY", value: "" },
    ];
    expect(parseEnv(serializeEnv(vars)).vars).toEqual(vars);
  });
});

describe("visibility", () => {
  it("keeps EXPO_PUBLIC_ plain, credentials secret, the rest sensitive", () => {
    expect(visibilityFor("EXPO_PUBLIC_SUPABASE_KEY")).toBe("plain");
    expect(visibilityFor("EXPO_PUBLIC_X", "secret")).toBe("plain");
    expect(visibilityFor("SENTRY_AUTH_TOKEN")).toBe("secret");
    expect(visibilityFor("STRIPE_SECRET")).toBe("secret");
    expect(visibilityFor("SENTRY_ORG")).toBe("sensitive");
    expect(visibilityFor("SENTRY_ORG", "plain")).toBe("plain");
  });
});

describe("eas.json", () => {
  it("resolves extends, skips extend-only profiles and maps distribution and channel", () => {
    const dir = mkdtempSync(join(tmpdir(), "liftbay-eas-"));
    writeFileSync(
      join(dir, "eas.json"),
      JSON.stringify({
        build: {
          base: { env: { SENTRY_ORG: "org", EXPO_PUBLIC_APP_ENV: "base" } },
          development: { extends: "base", developmentClient: true, distribution: "internal", channel: "development", env: { EXPO_PUBLIC_APP_ENV: "development" } },
          preview: { extends: "base", distribution: "internal", channel: "preview" },
          production: { extends: "base", env: { EXPO_PUBLIC_APP_ENV: "production", BAD_NUMBER: 3 } },
          Store_Beta: { distribution: "store" },
        },
      }),
    );
    const profiles = readEasProfiles(dir)!;
    expect(profiles.map((p) => p.name)).toEqual(["development", "preview", "production", "Store_Beta"]);
    const byName = Object.fromEntries(profiles.map((p) => [p.name, p]));
    expect(byName.development).toMatchObject({ distribution: "internal", channel: "development", developmentClient: true, env: { SENTRY_ORG: "org", EXPO_PUBLIC_APP_ENV: "development" } });
    expect(byName.preview!.env).toEqual({ SENTRY_ORG: "org", EXPO_PUBLIC_APP_ENV: "base" });
    expect(byName.production).toMatchObject({ distribution: "store", channel: "production", env: { EXPO_PUBLIC_APP_ENV: "production", BAD_NUMBER: "3" } });
    expect(byName.Store_Beta).toMatchObject({ slug: "store-beta", channel: "store-beta" });
  });

  it("is null without eas.json", () => {
    expect(readEasProfiles(mkdtempSync(join(tmpdir(), "liftbay-noeas-")))).toBeNull();
  });
});
