import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { client, cmd, fail, readCredentials, unwrap } from "../context.ts";
import { detectApp, readAppJson, readConfig } from "../project.ts";
import { readEasProfiles } from "./env.ts";
import type { SetupOptions } from "./setup.ts";

/**
 * `liftbay init` for agents. An agent can't answer prompts, but it can interview the person: `init --questions`
 * lists every question with the choices that apply to this app, and `init --answers <file>` runs with those
 * answers and no prompts at all.
 */
export type InitAnswers = {
  /** An existing organization (its slug). */
  org?: string;
  /** Or: create an organization with this name. */
  newOrg?: string;
  /** An existing project (its slug). */
  project?: string;
  /** Or: create a project with this name. */
  newProject?: string;
  platforms?: ("ios" | "android")[];
  iosEngine?: "github-actions" | "xcode-cloud";
  eas?: boolean;
  ota?: boolean;
  runtimePolicy?: "appVersion" | "fingerprint";
  /** .env files to import, per environment: { "production": [".env.production"] }. */
  envFiles?: Record<string, string[]>;
};

const KEYS: (keyof InitAnswers)[] = ["org", "newOrg", "project", "newProject", "platforms", "iosEngine", "eas", "ota", "runtimePolicy", "envFiles"];

/** Reads and checks an answers file; every mistake is reported at once, by field. */
export function readAnswers(path: string): InitAnswers {
  if (!existsSync(path)) fail(`No answers file at ${path}`);
  let a: Record<string, unknown>;
  try {
    a = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${path} isn't valid JSON`);
  }
  const problems: string[] = [];
  const unknown = Object.keys(a).filter((k) => !KEYS.includes(k as keyof InitAnswers));
  if (unknown.length) problems.push(`unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} (allowed: ${KEYS.join(", ")})`);
  const str = (k: string) => a[k] !== undefined && (typeof a[k] !== "string" || !(a[k] as string).trim()) && problems.push(`${k} must be a non-empty string`);
  const bool = (k: string) => a[k] !== undefined && typeof a[k] !== "boolean" && problems.push(`${k} must be true or false`);
  const oneOf = (k: string, values: string[]) => a[k] !== undefined && !values.includes(a[k] as string) && problems.push(`${k} must be ${values.join(" or ")}`);
  ["org", "newOrg", "project", "newProject"].forEach(str);
  ["eas", "ota"].forEach(bool);
  oneOf("iosEngine", ["github-actions", "xcode-cloud"]);
  oneOf("runtimePolicy", ["appVersion", "fingerprint"]);
  if (a.org && a.newOrg) problems.push("give org or newOrg, not both");
  if (a.project && a.newProject) problems.push("give project or newProject, not both");
  if (a.platforms !== undefined && (!Array.isArray(a.platforms) || !a.platforms.length || !a.platforms.every((x) => x === "ios" || x === "android"))) {
    problems.push(`platforms must be a list of "ios" and/or "android"`);
  }
  if (a.envFiles !== undefined) {
    const ok = typeof a.envFiles === "object" && a.envFiles !== null && Object.values(a.envFiles).every((v) => Array.isArray(v) && v.every((f) => typeof f === "string"));
    if (!ok) problems.push(`envFiles must look like { "production": [".env.production"] }`);
    else for (const f of Object.values(a.envFiles as Record<string, string[]>).flat()) if (!existsSync(f)) problems.push(`envFiles: no file at ${f}`);
  }
  if (problems.length) fail(`${path}:\n  ${problems.join("\n  ")}`);
  return a as InitAnswers;
}

export function answersToOptions(a: InitAnswers): SetupOptions & { ota?: boolean } {
  return {
    org: a.org,
    newOrg: a.newOrg,
    project: a.project,
    projectName: a.newProject,
    platforms: a.platforms?.join(","),
    iosEngine: a.iosEngine,
    eas: a.eas,
    ota: a.ota,
    runtimePolicy: a.runtimePolicy,
    yes: true,
  };
}

type Question = { id: keyof InitAnswers; question: string; type: "choice" | "multi" | "boolean" | "text" | "files"; choices?: { value: string; label: string }[]; default?: unknown; when?: string; note?: string };

/** Every question `init` would ask, with the choices that apply here. Nothing is changed. */
export async function initQuestions() {
  const app = await detectApp();
  const linked = readConfig();
  const signedIn = !!(process.env.LIFTBAY_TOKEN || readCredentials());
  let orgs: { slug: string; name: string }[] = [];
  const projects: Record<string, { slug: string; name: string }[]> = {};
  if (signedIn) {
    const lb = client();
    orgs = await unwrap(lb.GET("/v1/orgs")).catch(() => []);
    for (const o of orgs) projects[o.slug] = await unwrap(lb.GET("/v1/orgs/{org}/projects", { params: { path: { org: o.slug } } })).catch(() => []);
  }
  const eas = readEasProfiles();
  const envFiles = readdirSync(".").filter((f) => /^\.env(\..+)?$/.test(f) && !/\.(example|sample|template)$/.test(f));
  const policy = readAppJson()?.expo?.runtimeVersion?.policy;

  const questions: Question[] = [];
  if (!linked) {
    questions.push(
      orgs.length
        ? {
            id: "org",
            question: "Which Liftbay organization should own this app?",
            type: "choice",
            choices: orgs.map((o) => ({ value: o.slug, label: o.name })),
            default: orgs.length === 1 ? orgs[0]!.slug : undefined,
            note: "Or answer newOrg with a name to create another organization.",
          }
        : {
            id: "newOrg",
            question: "What should the new Liftbay organization be called?",
            type: "text",
            note: signedIn ? "This account has no organization yet; init creates it." : "Not signed in yet, so existing organizations can't be listed. Sign in first to see them.",
          },
      {
        id: "project",
        question: "Use an existing Liftbay project, or create a new one?",
        type: "choice",
        choices: Object.values(projects).flat().map((pr) => ({ value: pr.slug, label: pr.name })),
        default: undefined,
        note: `For a new project, answer newProject with its name instead (suggested: "${app.name}").`,
      },
    );
  }
  questions.push({ id: "platforms", question: "Which platforms should Liftbay build?", type: "multi", choices: [{ value: "ios", label: "iOS" }, { value: "android", label: "Android" }], default: ["ios", "android"] });
  questions.push({
    id: "iosEngine",
    question: "Where should iOS store builds run by default?",
    type: "choice",
    when: "platforms includes ios",
    choices: [
      { value: "github-actions", label: "GitHub Actions (macOS runners on your GitHub minutes; ready now)" },
      { value: "xcode-cloud", label: "Xcode Cloud (25 free hours a month with the Apple Developer Program; one-time setup after iOS signing)" },
    ],
    default: "github-actions",
  });
  if (eas?.length) {
    questions.push({
      id: "eas",
      question: `Use eas.json's build profiles (${eas.map((e) => e.name).join(", ")}), their channels and env variables?`,
      type: "boolean",
      default: true,
    });
  }
  questions.push({ id: "ota", question: "Set up over-the-air updates (expo-updates)?", type: "boolean", default: true });
  questions.push({
    id: "runtimePolicy",
    question: "Which installed apps can receive an update?",
    type: "choice",
    when: "ota is true",
    choices: [
      { value: "appVersion", label: "Same app version (bump the version when native code changes)" },
      { value: "fingerprint", label: "Same native fingerprint (computed from native code and config)" },
    ],
    default: policy === "fingerprint" ? "fingerprint" : "appVersion",
  });
  if (envFiles.length) {
    questions.push({
      id: "envFiles",
      question: `Which of these files should go into which environment? ${envFiles.join(", ")}`,
      type: "files",
      default: {},
      note: 'Like { "production": [".env.production"], "preview": [".env.preview"] }. Files like .env or .env.local often hold local development values: ask before sending them.',
    });
  }

  const example: InitAnswers = {
    ...(linked ? {} : orgs.length ? { org: orgs[0]!.slug } : { newOrg: "Acme" }),
    ...(linked ? {} : { newProject: app.name }),
    platforms: ["ios", "android"],
    iosEngine: "github-actions",
    ...(eas?.length ? { eas: true } : {}),
    ota: true,
    runtimePolicy: "appVersion",
  };
  const next = `Ask the person these questions, write their answers to a JSON file, then run: ${cmd("liftbay init --answers <file> --json")}`;

  p.intro(pc.bgCyan(pc.black(" liftbay init --questions ")));
  p.log.info(`${pc.bold(app.name)} · ${app.framework === "expo" ? "Expo" : "React Native"}${app.bundleId ? ` · ${app.bundleId}` : ""}${linked ? ` · linked to ${linked.org}/${linked.project}` : ""}`);
  if (!signedIn) p.log.warn(`Not signed in: ${cmd("liftbay login")} first to list organizations and projects.`);
  for (const q of questions) {
    const choices = q.choices?.length ? `\n${q.choices.map((c) => `   ${pc.cyan(c.value)}  ${pc.dim(c.label)}`).join("\n")}` : "";
    p.log.message(`${pc.bold(q.id)}${q.when ? pc.dim(` (if ${q.when})`) : ""}: ${q.question}${choices}${q.note ? `\n   ${pc.dim(q.note)}` : ""}`);
  }
  p.outro(next);
  return { app: { name: app.name, framework: app.framework, bundleId: app.bundleId, androidPackage: app.androidPackage }, linked: linked ? { org: linked.org, project: linked.project } : null, signedIn, questions, example, next };
}
