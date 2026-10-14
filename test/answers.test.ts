import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { answersToOptions, readAnswers } from "../src/commands/answers.ts";

const dir = mkdtempSync(join(tmpdir(), "liftbay-answers-"));
const file = (name: string, content: unknown) => {
  const path = join(dir, name);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
};

describe("init --answers", () => {
  it("turns an interview into init options, with no prompts left", () => {
    const env = file(".env.production", "API=1\n");
    const answers = readAnswers(file("ok.json", { newOrg: "Gym Buddy", newProject: "Buddy", platforms: ["ios", "android"], iosEngine: "xcode-cloud", eas: true, ota: false, envFiles: { production: [env] } }));
    expect(answersToOptions(answers)).toEqual({
      org: undefined,
      newOrg: "Gym Buddy",
      project: undefined,
      projectName: "Buddy",
      platforms: "ios,android",
      iosEngine: "xcode-cloud",
      eas: true,
      ota: false,
      runtimePolicy: undefined,
      yes: true,
    });
  });

  it("reports every problem at once, by field", () => {
    const path = file("bad.json", { org: "a", newOrg: "b", platforms: ["web"], iosEngine: "circleci", ota: "yes", colour: "blue", envFiles: { production: ["missing.env"] } });
    let message = "";
    try {
      readAnswers(path);
    } catch (e) {
      message = (e as Error).message;
    }
    for (const part of ["unknown field colour", "org or newOrg", "platforms must", "iosEngine must", "ota must be true or false", "no file at missing.env"]) expect(message).toContain(part);
  });

  it("explains a file that isn't JSON or doesn't exist", () => {
    expect(() => readAnswers(file("broken.json", "{ nope"))).toThrow(/isn't valid JSON/);
    expect(() => readAnswers(join(dir, "none.json"))).toThrow(/No answers file/);
  });
});
