import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { whyItFailed } from "../src/failure.ts";

const lines = (text: string, stream = "stdout") => text.split("\n").map((t) => ({ text: t, stream }));

describe("why a build failed", () => {
  it("Gradle: the error a tool printed before the failure, and what went wrong (a real Expo app build)", () => {
    const log = [...lines(readFileSync(join(__dirname, "fixtures-gradle-sentry.log"), "utf8")), { text: "Gradle assembleRelease failed: exit status 1", stream: "system" }];
    const why = whyItFailed(log);
    expect(why[0]).toMatch(/^error: Auth token is required/);
    expect(why).toContain("Execution failed for task ':app:createBundleReleaseJsAndAssets_SentryUpload_com.example.app@1.0.0+1_1'.");
    expect(why.at(-1)).toBe("Gradle assembleRelease failed: exit status 1");
    expect(why.some((l) => l.startsWith("at ") || l.includes("ExecuteActionsTaskExecuter"))).toBe(false);
    expect(why.length).toBeLessThan(12);
  });

  it("Xcode: its error lines and the failure summary", () => {
    const why = whyItFailed(
      lines(`CompileSwift normal arm64 /app/ios/App.swift
/app/ios/App/AppDelegate.swift:12:5: error: cannot find 'Foo' in scope
    Foo()
    ^~~
note: something
** ARCHIVE FAILED **
The following build commands failed:`),
    );
    expect(why).toEqual(["/app/ios/App/AppDelegate.swift:12:5: error: cannot find 'Foo' in scope", "** ARCHIVE FAILED **"]);
  });

  it("npm and CocoaPods, without stack frames", () => {
    expect(whyItFailed(lines("npm error code ERESOLVE\nnpm error ERESOLVE could not resolve\n    at Arborist.x (/a.js:1:1)"))).toEqual(["npm error code ERESOLVE", "npm error ERESOLVE could not resolve"]);
    expect(whyItFailed(lines('[!] CocoaPods could not find compatible versions for pod "React-Core"'))).toEqual(['[!] CocoaPods could not find compatible versions for pod "React-Core"']);
  });

  it("nothing marked: empty, so the caller shows the end of the log", () => {
    expect(whyItFailed(lines("compiling\nlinking\nKilled"))).toEqual([]);
  });
});
