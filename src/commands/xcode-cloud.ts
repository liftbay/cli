import * as p from "@clack/prompts";
import pc from "picocolors";
import { client, fail, isInteractive, unwrap } from "../context.ts";
import { requireConfig } from "../project.ts";

type ConnectOptions = { teamId?: string; workspace?: string; scheme?: string; wait?: boolean };
type Status = { connected: boolean; step: string; message: string; actionUrl: string | null; workspacePath: string | null; scheme: string | null; hours: { usedThisMonth: number; included: number } | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function printStatus(s: Status) {
  if (s.connected) {
    p.log.success(`Connected · ${s.workspacePath} · scheme ${s.scheme}`);
    if (s.hours) p.log.info(`About ${s.hours.usedThisMonth} of ${s.hours.included} Xcode Cloud hours used this month ${pc.dim("(estimated from run durations)")}`);
  } else {
    p.log.warn(s.message);
    if (s.actionUrl) p.log.info(`Open: ${pc.cyan(s.actionUrl)}`);
  }
}

/**
 * Connects the project's app to its Xcode Cloud product. Enabling Xcode Cloud for the app is a one-time step in
 * App Store Connect that Apple's API can't do, so this waits for it (like `eas`'s interactive setup).
 */
export async function xcodeCloudConnect(opts: ConnectOptions) {
  const config = requireConfig();
  const lb = client();
  const path = { org: config.org, project: config.project };
  const body = { teamId: opts.teamId, workspacePath: opts.workspace, scheme: opts.scheme };
  p.intro(pc.bgCyan(pc.black(" liftbay xcode-cloud connect ")));
  const wait = opts.wait ?? isInteractive();
  let last = "";
  for (;;) {
    const s = (await unwrap(lb.POST("/v1/orgs/{org}/projects/{project}/xcode-cloud/connect", { params: { path }, body }))) as Status;
    if (s.step === "ready") {
      printStatus(s);
      return p.outro(`iOS store builds now run on Xcode Cloud while hours remain. Force an engine with ${pc.cyan("liftbay build --engine xcode-cloud|github-actions")}`);
    }
    if (s.step !== last) printStatus(s);
    last = s.step;
    if (!wait || s.step === "apple_key") fail(s.step === "apple_key" ? s.message : "Not connected yet. Run this again once the step above is done.");
    const spin = p.spinner();
    spin.start("Waiting for that step (checking every 10 seconds; Ctrl-C to stop)");
    await sleep(10_000);
    spin.stop("Checking again");
  }
}

export async function xcodeCloudStatus() {
  const config = requireConfig();
  const s = (await unwrap(client().GET("/v1/orgs/{org}/projects/{project}/xcode-cloud", { params: { path: { org: config.org, project: config.project } } }))) as Status;
  printStatus(s);
}

export async function xcodeCloudDisconnect() {
  const config = requireConfig();
  await unwrap(client().DELETE("/v1/orgs/{org}/projects/{project}/xcode-cloud", { params: { path: { org: config.org, project: config.project } } }));
  console.log(`${pc.green("✔")} Disconnected. The Liftbay workflow was removed from Xcode Cloud; iOS builds run on GitHub Actions.`);
}
