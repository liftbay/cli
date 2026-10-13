import * as p from "@clack/prompts";
import pc from "picocolors";
import { client, fail, isInteractive, unwrap } from "../context.ts";
import { readConfig, writeConfig, type DetectedApp, type LiftbayConfig } from "../project.ts";

export type LinkOptions = { org?: string; project?: string; yes?: boolean };

/** Unwraps a prompt answer; Ctrl+C ends the wizard cleanly. */
function cancelled<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel("Cancelled");
    process.exit(0);
  }
  return value as Exclude<T, symbol>;
}
export { cancelled };

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/**
 * A new account has no organization yet: create one, like the dashboard's onboarding. The name is --org, a prompt,
 * or (for agents) the person's name or email.
 */
async function createFirstOrg(lb: ReturnType<typeof client>, given?: string) {
  const me = await unwrap(lb.GET("/v1/auth/me"));
  const suggested = given ?? (me.user.name?.trim() || me.user.email.split("@")[0]!);
  const name = isInteractive() && !given ? cancelled(await p.text({ message: "Name your organization", initialValue: suggested, validate: (v) => (slugify(v ?? "").length >= 2 ? undefined : "At least 2 letters or digits") })) : suggested;
  const base = slugify(name).padEnd(2, "0");
  // The slug is the organization's URL (liftbay.dev/<slug>); add a short suffix if it's taken.
  for (const slug of [base, `${base.slice(0, 35)}-${Math.random().toString(36).slice(2, 6)}`]) {
    const res = await lb.POST("/v1/orgs", { body: { name: name.slice(0, 64), slug } });
    if (res.data) {
      p.log.success(`Created organization ${pc.bold(res.data.name)} ${pc.dim(`(liftbay.dev/${res.data.slug})`)}`);
      return res.data;
    }
    if (res.response.status !== 409) await unwrap(Promise.resolve(res));
  }
  return fail("Couldn't pick a free organization URL. Pass --org <slug>.");
}

/** Links this folder to a Liftbay project, creating the project if needed. Idempotent. */
export async function ensureLinked(app: DetectedApp, opts: LinkOptions): Promise<LiftbayConfig> {
  const existing = readConfig();
  if (existing) {
    p.log.success(`Linked to ${pc.bold(`${existing.org}/${existing.project}`)}`);
    return existing;
  }
  const lb = client();
  const orgs = await unwrap(lb.GET("/v1/orgs"));
  if (!orgs.length) orgs.push(await createFirstOrg(lb, opts.org));

  let org = opts.org ?? (orgs.length === 1 ? orgs[0]!.slug : undefined);
  if (!org) {
    if (!isInteractive()) fail(`Several organizations available; pass --org (${orgs.map((o) => o.slug).join(", ")})`);
    org = cancelled(await p.select({ message: "Organization", options: orgs.map((o) => ({ value: o.slug, label: o.name, hint: o.slug })) }));
  }

  const projects = await unwrap(lb.GET("/v1/orgs/{org}/projects", { params: { path: { org } } }));
  let slug = opts.project;
  if (!slug) {
    const match = projects.find((pr) => pr.slug === app.slug);
    if (opts.yes || !isInteractive()) slug = match?.slug ?? app.slug;
    else {
      const choice = cancelled(
        await p.select({
          message: "Liftbay project",
          options: [
            { value: "__new__", label: `Create "${app.slug}"`, hint: "new project" },
            ...projects.map((pr) => ({ value: pr.slug, label: pr.name, hint: pr.slug })),
          ],
          initialValue: match?.slug ?? "__new__",
        }),
      );
      slug = choice === "__new__" ? app.slug : choice;
    }
  }

  let project = projects.find((pr) => pr.slug === slug);
  if (!project) {
    project = await unwrap(
      lb.POST("/v1/orgs/{org}/projects", {
        params: { path: { org } },
        body: { name: app.name, slug: slug!, framework: app.framework, bundleId: app.bundleId, androidPackage: app.androidPackage },
      }),
    );
    p.log.success(`Created project ${pc.bold(`${org}/${project.slug}`)} with development, preview and production environments`);
  } else {
    p.log.success(`Linked to existing project ${pc.bold(`${org}/${project.slug}`)}`);
  }

  const config: LiftbayConfig = { org, project: project.slug, projectId: project.id };
  writeConfig(config);
  p.log.info(`Wrote ${pc.cyan("liftbay.json")} ${pc.dim("(commit it: it links this repository to the project)")}`);
  return config;
}
