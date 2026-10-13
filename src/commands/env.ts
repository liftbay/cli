import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { client, cmd, fail, isInteractive, unwrap } from "../context.ts";
import { requireConfig } from "../project.ts";
import { cancelled } from "./link.ts";

type Visibility = "plain" | "sensitive" | "secret";
type Var = { key: string; value: string };
type Lb = ReturnType<typeof client>;
type ProjectPath = { org: string; project: string };

const VISIBILITIES: Visibility[] = ["plain", "sensitive", "secret"];
const KEY = /^[A-Z_][A-Z0-9_]*$/;

// ── .env files ───────────────────────────────────────────────────────────

/** KEY=value lines, as dotenv reads them: comments, `export`, single and double quotes (with \n escapes). */
export function parseEnv(content: string): { vars: Var[]; invalid: number[] } {
  const vars: Var[] = [];
  const invalid: number[] = [];
  content.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) return void invalid.push(i + 1);
    let value = m[2] ?? "";
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) {
      value = value.slice(1, -1);
      if (q === '"') value = value.replace(/\\(n|"|\\)/g, (_, c: string) => (c === "n" ? "\n" : c));
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    vars.push({ key: m[1]!, value });
  });
  return { vars, invalid };
}

/** The same format back, quoting what needs it; the API's .env import reads it. */
export function serializeEnv(vars: Var[]): string {
  return vars
    .map(({ key, value }) => {
      const quote = /[\s#"'\\]/.test(value) || value === "";
      return `${key}=${quote ? `"${value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"')}"` : value}`;
    })
    .join("\n");
}

/**
 * Visibility when none is given: `EXPO_PUBLIC_*` values are inlined into the app, so they're plain. Names that
 * look like credentials are secret (write-only); everything else is sensitive (encrypted, revealable).
 */
export function visibilityFor(key: string, forced?: Visibility): Visibility {
  if (key.startsWith("EXPO_PUBLIC_")) return forced === "sensitive" ? "sensitive" : "plain";
  if (forced) return forced;
  return /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH|API_KEY|ACCESS_KEY|_KEY$)/.test(key) ? "secret" : "sensitive";
}

function parseVisibility(v?: string): Visibility | undefined {
  if (v && !VISIBILITIES.includes(v as Visibility)) fail(`--visibility must be ${VISIBILITIES.join(", ")}`);
  return v as Visibility | undefined;
}

// ── EAS ──────────────────────────────────────────────────────────────────

export type EasProfile = { name: string; slug: string; distribution: "internal" | "store"; channel: string; env: Record<string, string>; developmentClient: boolean };

const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "default";

/**
 * Build profiles from eas.json, with `extends` resolved. Profiles that exist only to be extended (like a
 * `base` with env but no channel or distribution) are left out; their env reaches the profiles that use them.
 */
export function readEasProfiles(cwd = process.cwd()): EasProfile[] | null {
  const path = join(cwd, "eas.json");
  if (!existsSync(path)) return null;
  let eas: { build?: Record<string, Record<string, any>> };
  try {
    eas = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("eas.json isn't valid JSON");
  }
  const build = eas.build ?? {};
  const resolveProfile = (name: string, seen: string[] = []): Record<string, any> => {
    const own = build[name] ?? fail(`eas.json: profile "${seen.at(-1)}" extends unknown profile "${name}"`);
    if (seen.includes(name)) fail(`eas.json: profiles extend each other in a loop (${[...seen, name].join(" → ")})`);
    const parent = own.extends ? resolveProfile(own.extends, [...seen, name]) : {};
    return { ...parent, ...own, env: { ...parent.env, ...own.env } };
  };
  const extended = new Set(Object.values(build).map((b) => b.extends).filter(Boolean));
  return Object.keys(build)
    .filter((name) => !(extended.has(name) && !build[name]!.channel && !build[name]!.distribution && !build[name]!.developmentClient))
    .map((name) => {
      const r = resolveProfile(name);
      const env = Object.fromEntries(Object.entries(r.env ?? {}).filter(([k, v]) => KEY.test(k) && v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
      return { name, slug: slugify(name), distribution: r.distribution === "internal" ? "internal" : "store", channel: slugify(r.channel ?? name), env, developmentClient: !!r.developmentClient };
    });
}

// ── API helpers ──────────────────────────────────────────────────────────

async function environments(lb: Lb, path: ProjectPath) {
  return unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/environments", { params: { path } }));
}

/** Creates the environment when it doesn't exist. Returns whether it was created. */
export async function ensureEnvironment(lb: Lb, path: ProjectPath, slug: string, existing?: { slug: string }[]) {
  const envs = existing ?? (await environments(lb, path));
  if (envs.some((e) => e.slug === slug)) return false;
  await unwrap(lb.POST("/v1/orgs/{org}/projects/{project}/environments", { params: { path }, body: { name: slug, slug } }));
  return true;
}

export type ImportResult = { environment: string; added: string[]; updated: string[]; skipped: { key: string; reason: string }[]; visibility: Record<string, Visibility> };

/** Saves variables into one environment: one import per visibility, so each key gets the right one. */
export async function importVariables(lb: Lb, path: ProjectPath, env: string, vars: Var[], opts: { visibility?: Visibility; overwrite: boolean }): Promise<ImportResult> {
  const result: ImportResult = { environment: env, added: [], updated: [], skipped: [], visibility: {} };
  const bad = vars.filter((v) => !KEY.test(v.key));
  for (const v of bad) result.skipped.push({ key: v.key, reason: "names must be UPPER_SNAKE_CASE" });
  const byVisibility = new Map<Visibility, Var[]>();
  for (const v of vars.filter((v) => KEY.test(v.key))) {
    const vis = visibilityFor(v.key, opts.visibility);
    result.visibility[v.key] = vis;
    byVisibility.set(vis, [...(byVisibility.get(vis) ?? []).filter((x) => x.key !== v.key), v]);
  }
  for (const [visibility, group] of byVisibility) {
    const r = await unwrap(
      lb.POST("/v1/orgs/{org}/projects/{project}/environments/{env}/import", { params: { path: { ...path, env } }, body: { content: serializeEnv(group), visibility, overwrite: opts.overwrite } }),
    );
    result.added.push(...r.added);
    result.updated.push(...r.updated);
    result.skipped.push(...r.skipped);
  }
  return result;
}

export function printImport(r: ImportResult) {
  const count = (n: number, word: string) => `${n} ${word}`;
  p.log.success(`${pc.bold(r.environment)}: ${count(r.added.length, "added")}, ${count(r.updated.length, "updated")}${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}`);
  for (const key of [...r.added, ...r.updated]) p.log.message(`  ${key.padEnd(36)} ${pc.dim(r.visibility[key] ?? "")}`);
  for (const s of r.skipped) p.log.message(pc.dim(`  ${s.key.padEnd(36)} skipped: ${s.reason}`));
}

/** --environment, or the one a file is named for (.env.production, .env.preview.local), or a prompt. */
async function pickEnvironment(lb: Lb, path: ProjectPath, given: string | undefined, file?: string) {
  const envs = await environments(lb, path);
  const fromName = file ? basename(file).match(/^\.env\.([a-z0-9-]+?)(?:\.local)?$/)?.[1] : undefined;
  const slug = given ?? (fromName && envs.some((e) => e.slug === fromName) ? fromName : undefined);
  if (slug) return { slug, envs };
  const names = envs.map((e) => e.slug).join(", ");
  if (!isInteractive()) fail(`Pass --environment (${names})${file ? ` for ${file}` : ""}`);
  return { slug: cancelled(await p.select({ message: file ? `Environment for ${file}` : "Environment", options: envs.map((e) => ({ value: e.slug, label: e.name, hint: `${e.variableCount} variables` })) })), envs };
}

// ── Commands ─────────────────────────────────────────────────────────────

const projectPath = () => {
  const config = requireConfig();
  return { org: config.org, project: config.project };
};

/** Environments, or one environment's variables (sensitive values masked, secrets never shown). */
export async function envList(opts: { environment?: string }) {
  const lb = client();
  const path = projectPath();
  if (!opts.environment) {
    const envs = await environments(lb, path);
    for (const e of envs) console.log(`${pc.bold(e.slug.padEnd(16))} ${String(e.variableCount).padStart(3)} variables  ${pc.dim(`revision ${e.revision}`)}`);
    return { environments: envs.map(({ slug, name, variableCount, revision, updatedAt }) => ({ slug, name, variableCount, revision, updatedAt })) };
  }
  const vars = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/environments/{env}/variables", { params: { path: { ...path, env: opts.environment } } }));
  if (!vars.length) console.log(`No variables in ${opts.environment}. Add some with ${pc.cyan(cmd(`liftbay env import .env --environment ${opts.environment}`))}`);
  for (const v of vars) {
    const shown = v.visibility === "plain" ? (v.value ?? "") : v.visibility === "secret" ? pc.dim("(secret)") : pc.dim("•••••• (sensitive)");
    console.log(`${v.key.padEnd(36)} ${shown}`);
  }
  return { environment: opts.environment, variables: vars.map((v) => ({ key: v.key, visibility: v.visibility, value: v.visibility === "plain" ? v.value : null, updatedAt: v.updatedAt })) };
}

/** KEY=value pairs into one environment. Values in arguments end up in shell history: prefer `env import` for secrets. */
export async function envSet(pairs: string[], opts: { environment?: string; visibility?: string }) {
  const lb = client();
  const path = projectPath();
  const vars = pairs.map((pair) => {
    const at = pair.indexOf("=");
    if (at < 1) fail(`"${pair}" isn't KEY=value`);
    return { key: pair.slice(0, at), value: pair.slice(at + 1) };
  });
  const { slug } = await pickEnvironment(lb, path, opts.environment);
  const r = await importVariables(lb, path, slug, vars, { visibility: parseVisibility(opts.visibility), overwrite: true });
  printImport(r);
  return r;
}

export async function envUnset(keys: string[], opts: { environment?: string }) {
  const lb = client();
  const path = projectPath();
  const { slug } = await pickEnvironment(lb, path, opts.environment);
  const vars = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/environments/{env}/variables", { params: { path: { ...path, env: slug } } }));
  const removed = [];
  for (const key of keys) {
    const v = vars.find((x) => x.key === key);
    if (!v) {
      p.log.warn(`${key} isn't set in ${slug}`);
      continue;
    }
    await unwrap(lb.DELETE("/v1/orgs/{org}/projects/{project}/environments/{env}/variables/{id}", { params: { path: { ...path, env: slug, id: v.id } } }));
    p.log.success(`Removed ${key} from ${slug}`);
    removed.push(key);
  }
  return { environment: slug, removed };
}

/**
 * Imports variables from .env files (each into the environment it's named for, or --environment), or from
 * eas.json (each build profile's env, with `extends` resolved, into the environment of the same name).
 */
export async function envImport(files: string[], opts: { environment?: string; visibility?: string; overwrite?: boolean }) {
  const lb = client();
  const path = projectPath();
  const visibility = parseVisibility(opts.visibility);
  const overwrite = opts.overwrite !== false;
  const results: ImportResult[] = [];
  for (const file of files) {
    const abs = resolve(file.replace(/^~/, process.env.HOME ?? "~"));
    if (!existsSync(abs)) fail(`No file at ${file}`);

    if (basename(abs) === "eas.json") {
      const profiles = readEasProfiles(resolve(abs, ".."))!;
      if (!profiles.length) fail("eas.json has no build profiles");
      const envs = await environments(lb, path);
      for (const prof of opts.environment ? profiles.filter((x) => x.slug === opts.environment) : profiles) {
        if (await ensureEnvironment(lb, path, prof.slug, envs)) p.log.success(`Created environment ${pc.bold(prof.slug)}`);
        const vars = Object.entries(prof.env).map(([key, value]) => ({ key, value }));
        if (!vars.length) {
          p.log.info(`${pc.bold(prof.slug)}: no env in eas.json`);
          continue;
        }
        const r = await importVariables(lb, path, prof.slug, vars, { visibility, overwrite });
        printImport(r);
        results.push(r);
      }
      continue;
    }

    const { vars, invalid } = parseEnv(readFileSync(abs, "utf8"));
    if (invalid.length) p.log.warn(`${file}: skipped unreadable line${invalid.length > 1 ? "s" : ""} ${invalid.join(", ")}`);
    const { slug } = await pickEnvironment(lb, path, opts.environment, file);
    const r = await importVariables(lb, path, slug, vars, { visibility, overwrite });
    printImport(r);
    results.push(r);
  }
  return { imported: results };
}

/** Writes an environment as a .env file. Secret values are never exported. */
export async function envExport(opts: { environment?: string; out?: string; force?: boolean }) {
  const lb = client();
  const path = projectPath();
  const { slug } = await pickEnvironment(lb, path, opts.environment);
  const content = String(await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/environments/{env}/export", { params: { path: { ...path, env: slug } }, parseAs: "text" })));
  if (!opts.out) {
    process.stdout.write(`${content.trimEnd()}\n`);
    return { environment: slug, content };
  }
  if (existsSync(opts.out) && !opts.force) fail(`${opts.out} exists. Pass --force to overwrite it.`);
  writeFileSync(opts.out, `${content.trimEnd()}\n`, { mode: 0o600 });
  p.log.success(`Wrote ${opts.out} ${pc.dim("(secret values are not exported)")}`);
  return { environment: slug, file: resolve(opts.out) };
}
