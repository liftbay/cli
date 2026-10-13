import * as p from "@clack/prompts";
import pc from "picocolors";
import QRCode from "qrcode";
import { client, fail, isInteractive, unwrap } from "../context.ts";
import { requireConfig } from "../project.ts";
import { cancelled } from "./link.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What happens next once a device is in: profiles follow automatically when ad hoc signing is set up. */
async function nextStep(lb: ReturnType<typeof client>) {
  const config = requireConfig();
  const signing = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/signing", { params: { path: { org: config.org, project: config.project } } }));
  if (signing.iosAdhoc) p.log.info("The next internal iOS build re-creates the ad hoc profiles with this device.");
  else p.log.info(`Set up ad hoc signing to build for it: ${pc.cyan("liftbay credentials ios --adhoc")}`);
}

/**
 * Registers an iPhone or iPad for internal (ad hoc) builds: by UDID, or with a one-hour link the device opens
 * (shown as a QR code) to send its UDID itself.
 */
export async function deviceAdd(opts: { udid?: string; name?: string; teamId?: string; wait?: boolean }) {
  const config = requireConfig();
  const lb = client();
  const org = { org: config.org };
  p.intro(pc.bgCyan(pc.black(" liftbay device add ")));

  if (opts.udid) {
    const name = opts.name ?? (isInteractive() ? cancelled(await p.text({ message: "Device name", placeholder: "Sreeyesh's iPhone" })) : "iPhone");
    const device = await unwrap(lb.POST("/v1/orgs/{org}/devices", { params: { path: org }, body: { udid: opts.udid, name, teamId: opts.teamId } }));
    p.log.success(`Added ${pc.bold(device.name)} ${pc.dim(device.udid)}${device.registeredAtApple ? " · registered with Apple" : ""}`);
    await nextStep(lb);
    p.outro("Done");
    return { device };
  }

  const reg = await unwrap(lb.POST("/v1/orgs/{org}/devices/registrations", { params: { path: org }, body: { teamId: opts.teamId } }));
  const qr = await QRCode.toString(reg.url, { type: "terminal", small: true });
  p.note(`${qr}\n${reg.url}`, "Scan with the iPhone's camera, or open the link in Safari on it");
  p.log.info(pc.dim("On the device: Download profile → Allow, then Settings → Profile Downloaded → Install. The link works for one hour."));
  if (opts.wait === false) {
    p.outro(`Check with ${pc.cyan("liftbay device list")} once it's installed on the device.`);
    return { registration: { id: reg.id, url: reg.url, expiresAt: reg.expiresAt }, next: "Open the url on the iPhone or iPad, install the profile, then check `liftbay device list`" };
  }

  const spin = p.spinner();
  spin.start("Waiting for the device");
  const until = Date.parse(reg.expiresAt);
  while (Date.now() < until) {
    await sleep(2500);
    const status = await unwrap(lb.GET("/v1/orgs/{org}/devices/registrations/{registration}", { params: { path: { ...org, registration: reg.id } } }));
    if (status.device) {
      spin.stop(`Registered ${pc.bold(status.device.name)} ${pc.dim(`${status.device.model ?? ""} ${status.device.udid}`)}`);
      await nextStep(lb);
      p.outro("Done");
      return { device: status.device };
    }
  }
  spin.error("The link expired before a device registered");
  fail("Run `liftbay device add` again for a new link.");
}

export async function deviceList() {
  const config = requireConfig();
  const devices = await unwrap(client().GET("/v1/orgs/{org}/devices", { params: { path: { org: config.org } } }));
  if (!devices.length) console.log(`No devices yet. Add one with ${pc.cyan("liftbay device add")}`);
  for (const d of devices) {
    const state = !d.enabled ? pc.dim("disabled") : d.registeredAtApple ? pc.green("registered") : pc.yellow("pending Apple");
    console.log(`${d.name.padEnd(28)} ${pc.dim(d.udid.padEnd(42))} ${(d.model ?? "").padEnd(12)} ${state.padEnd(22)} ${pc.dim(d.id)}`);
  }
  return { devices };
}

export async function deviceRemove(id: string) {
  const config = requireConfig();
  await unwrap(client().DELETE("/v1/orgs/{org}/devices/{device}", { params: { path: { org: config.org, device: id } } }));
  console.log(`${pc.green("✔")} Removed. It stays out of the next ad hoc profiles.`);
  return { removed: id };
}
