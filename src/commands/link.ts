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

/** Links this folder to a Liftbay project, creating the project if needed. Idempotent. */
export async function ensureLinked(app: DetectedApp, opts: LinkOptions): Promise<LiftbayConfig> {
  const existing = readConfig();
  if (existing) {
    p.log.success(`Linked to ${pc.bold(`${existing.org}/${existing.project}`)}`);
    return existing;
  }
  const lb = client();
  const orgs = await unwrap(lb.GET("/v1/orgs"));
  if (!orgs.length) fail("You're not in any organization yet. Create one at the dashboard first.");

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
