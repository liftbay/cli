import { spawn } from "node:child_process";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { client, cmd, dashboardUrl, fail, isInteractive, unwrap } from "../context.ts";
import { requireConfig, type LiftbayConfig } from "../project.ts";
import { cancelled } from "./link.ts";

type Lb = ReturnType<typeof client>;
type Status = { repo: string | null; connected: boolean; defaultBranch: string | null; workflow: "present" | "outdated" | "missing" | "unknown" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WAIT_MINUTES = 15;

function openBrowser(url: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // No browser here (SSH, CI): the link is printed anyway.
  }
}

/** The project's GitHub status, with the repository as owner/name (the API stores it as github:owner/name). */
async function status(lb: Lb, config: LiftbayConfig, refresh = true): Promise<Status> {
  const s = (await unwrap(
    lb.GET("/v1/orgs/{org}/projects/{project}/github/status", { params: { path: { org: config.org, project: config.project }, query: { refresh: refresh ? "true" : "false" } } }),
  )) as Status;
  return { ...s, repo: s.repo?.replace(/^github:/, "") ?? null };
}

/** Polls until `done(status)`, with a spinner. Returns the last status, or null if it timed out. */
async function waitFor(lb: Lb, config: LiftbayConfig, message: string, done: (s: Status) => boolean): Promise<Status | null> {
  const spin = p.spinner();
  spin.start(`${message} ${pc.dim("(Ctrl-C to stop)")}`);
  const until = Date.now() + WAIT_MINUTES * 60_000;
  while (Date.now() < until) {
    await sleep(4000);
    const s = await status(lb, config);
    if (done(s)) {
      spin.stop(message.replace(/^Waiting for /, "Done: "));
      return s;
    }
  }
  spin.error("Stopped waiting");
  return null;
}

export type GithubCheck = Status & { installUrl?: string; pullRequestUrl?: string | null };

/**
 * Builds run through the Liftbay GitHub App, and GitHub only starts a workflow that is on the repository's
 * default branch. This makes sure both are in place: in a terminal it opens the page to fix each one and
 * waits; otherwise it fails with the link (or, with `soft`, returns what's missing).
 */
export async function ensureGithub(opts: { needWorkflow: boolean; soft?: boolean; wait?: boolean }): Promise<GithubCheck> {
  const config = requireConfig();
  const lb = client();
  let s = await status(lb, config);
  const interactive = isInteractive() && opts.wait !== false;
  if (!s.repo) {
    const message = `This project has no GitHub repository. Push the app to GitHub, then run ${cmd("liftbay ci init")}.`;
    if (opts.soft) return s;
    fail(message);
  }
  const owner = s.repo!.split("/")[0];

  if (!s.connected) {
    const { url } = await unwrap(lb.POST("/v1/orgs/{org}/github/install", { params: { path: { org: config.org } } }));
    p.log.warn(`The Liftbay GitHub App isn't installed for ${pc.bold(s.repo!)} yet. Builds run through it.`);
    if (!interactive) {
      if (opts.soft) return { ...s, installUrl: url };
      fail(`Install the Liftbay GitHub App on ${owner} (give it access to ${s.repo}): ${url}\nThen run this again. In the dashboard: ${dashboardUrl()}/${config.org}/github`);
    }
    // The link goes on a line of its own: wrapped inside a box, terminals no longer open it as one link.
    p.log.step("Install the Liftbay GitHub App");
    p.log.message(
      pc.dim(`Pick ${pc.bold(owner!)}, give it access to ${pc.bold(s.repo!.split("/")[1]!)} (or all repositories) and save.\nAlready installed on GitHub? Choose Configure, check the repository is selected and save.`),
    );
    console.log(`\n${pc.cyan(url)}\n`);
    if (!cancelled(await p.confirm({ message: "Open this in your browser now?", initialValue: true }))) {
      fail(`Install it from the link above, or at ${dashboardUrl()}/${config.org}/github, then run this again.`);
    }
    openBrowser(url);
    const done = await waitFor(lb, config, "Waiting for the GitHub App to be installed", (x) => x.connected);
    if (!done) fail(`The GitHub App isn't installed yet. Finish at ${dashboardUrl()}/${config.org}/github, then run this again.`);
    s = done;
  }

  if (opts.needWorkflow && s.workflow !== "present") {
    const branch = s.defaultBranch ?? "the default branch";
    const why =
      s.workflow === "outdated"
        ? `The Liftbay workflow on ${branch} is outdated.`
        : `GitHub only starts workflows that are on the default branch (${branch}), and .github/workflows/liftbay.yml isn't there yet. It only runs when Liftbay starts a build.`;
    if (s.workflow === "outdated" && !interactive) {
      p.log.warn(`${why} Update it with ${cmd("liftbay github workflow")}.`);
      return s;
    }
    if (!interactive) {
      if (opts.soft) return s;
      fail(`${why}\nOpen a pull request that adds it with \`liftbay github workflow\`, merge it, then run this again.`);
    }
    p.log.warn(why);
    const ok = cancelled(await p.confirm({ message: `Open a pull request that ${s.workflow === "outdated" ? "updates" : "adds"} the workflow on ${branch}?`, initialValue: true }));
    if (!ok) {
      if (s.workflow === "outdated") return s;
      fail(`Commit .github/workflows/liftbay.yml to ${branch} yourself, or run ${cmd("liftbay github workflow")}, then run this again.`);
    }
    const pr = await unwrap(lb.POST("/v1/orgs/{org}/projects/{project}/github/workflow", { params: { path: { org: config.org, project: config.project } } }));
    if (pr.status === "up_to_date") return { ...s, workflow: "present" };
    p.log.success(`Pull request ${pr.status}: ${pc.cyan(pr.url ?? "")}`);
    if (pr.url) openBrowser(pr.url);
    if (s.workflow === "outdated") return { ...s, pullRequestUrl: pr.url };
    const merged = await waitFor(lb, config, "Waiting for the pull request to be merged", (x) => x.workflow === "present");
    if (!merged) fail(`Merge ${pr.url}, then run this again.`);
    s = merged;
  }
  return s;
}

// ── Commands ─────────────────────────────────────────────────────────────

export async function githubStatus() {
  const config = requireConfig();
  const lb = client();
  const s = await status(lb, config);
  const mark = (ok: boolean) => (ok ? pc.green("✔") : pc.red("✖"));
  console.log(`${mark(!!s.repo)} Repository       ${s.repo ?? pc.dim("none: push the app to GitHub, then liftbay ci init")}`);
  console.log(`${mark(s.connected)} GitHub App       ${s.connected ? "installed" : pc.dim(`not installed: ${cmd("liftbay github connect")}`)}`);
  console.log(
    `${mark(s.workflow === "present")} Workflow         ${
      s.workflow === "present"
        ? `on ${s.defaultBranch}`
        : !s.connected
          ? pc.dim("checked once the GitHub App is installed")
          : pc.dim(`${s.workflow} on ${s.defaultBranch ?? "the default branch"}: ${cmd("liftbay github workflow")}`)
    }`,
  );
  return s;
}

/** Installs the GitHub App (in a terminal: opens it and waits). With --no-wait or for agents: prints the link. */
export async function githubConnect(opts: { wait?: boolean }) {
  return ensureGithub({ needWorkflow: false, soft: true, wait: opts.wait });
}

/** Opens (or updates) the pull request that adds the workflow on the default branch. */
export async function githubWorkflow(opts: { wait?: boolean }) {
  const config = requireConfig();
  const lb = client();
  const s = await status(lb, config);
  if (!s.connected) fail(`Install the Liftbay GitHub App first: ${cmd("liftbay github connect")}`);
  if (s.workflow === "present") {
    p.log.success(`The workflow is already on ${s.defaultBranch}.`);
    return { ...s, pullRequestUrl: null };
  }
  const pr = await unwrap(lb.POST("/v1/orgs/{org}/projects/{project}/github/workflow", { params: { path: { org: config.org, project: config.project } } }));
  p.log.success(pr.status === "up_to_date" ? "The workflow is up to date." : `Pull request ${pr.status}: ${pc.cyan(pr.url ?? "")}`);
  if (pr.url && isInteractive() && opts.wait !== false) {
    openBrowser(pr.url);
    const merged = await waitFor(lb, config, "Waiting for the pull request to be merged", (x) => x.workflow === "present");
    return { ...(merged ?? s), pullRequestUrl: pr.url };
  }
  return { ...s, pullRequestUrl: pr.url, next: "Merge the pull request, then build" };
}
