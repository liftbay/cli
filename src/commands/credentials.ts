import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import * as p from "@clack/prompts";
import { LiftbayApiError } from "@liftbay/sdk";
import pc from "picocolors";
import { AppleAuthError, AppleSession, type AppleTeam } from "../apple/index.ts";
import { client, fail, isInteractive, unwrap } from "../context.ts";
import { expoConfig, requireConfig } from "../project.ts";
import { cancelled } from "./link.ts";

export type IosCredentialOptions = {
  /** Ad hoc profiles for registered devices (internal builds) instead of App Store profiles. */
  adhoc?: boolean;
  appleId?: string;
  teamId?: string;
  bundleId?: string[];
  p8?: string;
  keyId?: string;
  issuerId?: string;
  yes?: boolean;
};

/** Bundle ids to sign: the app, plus extension targets found in the native project. */
export async function detectBundleIds(cwd = process.cwd()): Promise<string[]> {
  const ids = new Set<string>();
  try {
    const id = (await expoConfig(cwd)).ios?.bundleIdentifier;
    if (id) ids.add(id);
  } catch {
    // Not an Expo app, or its config doesn't load; the Xcode project below still counts.
  }
  const ios = join(cwd, "ios");
  if (existsSync(ios)) {
    for (const entry of readdirSync(ios).filter((e) => e.endsWith(".xcodeproj"))) {
      const pbx = join(ios, entry, "project.pbxproj");
      if (!existsSync(pbx)) continue;
      for (const m of readFileSync(pbx, "utf8").matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([A-Za-z0-9.-]+)"?;/g)) {
        if (!/tests?$/i.test(m[1]!)) ids.add(m[1]!);
      }
    }
  }
  return [...ids];
}

function readP8(path: string) {
  if (!existsSync(path)) fail(`No file at ${path}`);
  const privateKeyP8 = readFileSync(path, "utf8");
  if (!privateKeyP8.includes("PRIVATE KEY")) fail(`${path} is not an App Store Connect .p8 key`);
  return { privateKeyP8, keyIdFromName: basename(path).match(/AuthKey_([A-Z0-9]{10})\.p8$/)?.[1] };
}

/** Signs in with the Apple ID (2FA in the terminal), picks the team and creates an API key for Liftbay. */
async function keyFromAppleId(opts: IosCredentialOptions) {
  const appleId =
    opts.appleId ?? process.env.LIFTBAY_APPLE_ID ?? cancelled(await p.text({ message: "Apple ID (email)", validate: (v) => (v?.includes("@") ? undefined : "Enter the email of your Apple developer account") }));
  const session = await AppleSession.signIn(appleId, {
    password: async () => process.env.LIFTBAY_APPLE_PASSWORD ?? cancelled(await p.password({ message: `Password for ${appleId}` })),
    code: async (info) => {
      // Values are strings for the prompt: "device", or a phone id to text a code to.
      const options = [
        ...(info.deviceCode ? [{ value: "device", label: "Enter the code shown on your Apple devices" }] : []),
        ...info.phones.map((ph) => ({ value: String(ph.id), label: `Text a code to ${ph.number}` })),
      ];
      const choice = options.length > 1 ? cancelled(await p.select({ message: "Two-factor authentication", options })) : (options[0]?.value ?? "device");
      if (choice !== "device") return { sms: Number(choice) };
      return cancelled(await p.text({ message: `${info.length}-digit code`, validate: (v) => (new RegExp(`^\\d{${info.length}}$`).test(v ?? "") ? undefined : `Enter the ${info.length}-digit code`) }));
    },
  }, { log: (m) => p.log.info(m) });

  const teams = await session.teams();
  if (!teams.length) fail("This Apple ID has no developer team. Join the Apple Developer Program first.");
  const team: AppleTeam =
    teams.find((t) => t.teamId === opts.teamId) ??
    (teams.length === 1 ? teams[0]! : cancelled(await p.select({ message: "Apple team", options: teams.map((t) => ({ value: t, label: `${t.name} (${t.teamId})` })) })));
  await session.selectTeam(team);

  const spin = p.spinner();
  spin.start("Creating an App Store Connect API key for Liftbay");
  try {
    const key = await session.createApiKey("Liftbay");
    spin.stop(`API key ${key.keyId} created (revoke it any time in App Store Connect → Users and Access → Integrations)`);
    return { teamId: team.teamId, teamName: team.name, ...key };
  } catch (e) {
    spin.error("Could not create an API key");
    throw e;
  }
}

/** The .p8 route: for CI, or for people who don't want to type their Apple password. */
async function keyFromP8(opts: IosCredentialOptions) {
  const path = opts.p8 ?? cancelled(await p.text({ message: "Path to the AuthKey_XXXXXXXXXX.p8 file" }));
  const { privateKeyP8, keyIdFromName } = readP8(path.replace(/^~/, process.env.HOME ?? "~"));
  const keyId = opts.keyId ?? keyIdFromName ?? cancelled(await p.text({ message: "Key ID" }));
  const issuerId = opts.issuerId ?? cancelled(await p.text({ message: "Issuer ID", placeholder: "shown above the key list in App Store Connect → Integrations" }));
  const teamId = opts.teamId ?? cancelled(await p.text({ message: "Apple team ID", placeholder: "10 characters, developer.apple.com → Membership" }));
  return { teamId, teamName: null, keyId, issuerId, privateKeyP8 };
}

/**
 * Makes sure the project can produce signed iOS builds: an App Store Connect API key for the team (from an
 * Apple ID sign-in, like EAS, or a .p8 file), then the certificate and one profile per bundle id, created by Liftbay.
 */
export async function setUpIos(opts: IosCredentialOptions) {
  const config = requireConfig();
  const lb = client();
  const org = { org: config.org };
  const path = { org: config.org, project: config.project };

  // 1. An API key for the team: reuse the organization's, or create one.
  const overview = await unwrap(lb.GET("/v1/orgs/{org}/apple", { params: { path: org } }));
  let teamId = opts.teamId ?? (overview.keys.length === 1 ? overview.keys[0]!.teamId : undefined);
  if (!opts.p8 && overview.keys.length > 1 && !teamId) {
    teamId = cancelled(await p.select({ message: "Apple team", options: overview.keys.map((k) => ({ value: k.teamId, label: `${k.teamName ?? k.teamId} (${k.teamId})` })) }));
  }
  const haveKey = !opts.p8 && !!teamId && overview.keys.some((k) => k.teamId === teamId);
  if (haveKey) {
    p.log.info(`Using the App Store Connect key saved for team ${teamId}`);
  } else {
    const method =
      opts.p8 || opts.keyId ? "p8" : opts.yes || !isInteractive() ? (process.env.LIFTBAY_APPLE_ID ? "apple" : "p8") : cancelled(
        await p.select({
          message: "How should Liftbay access your Apple developer account?",
          options: [
            { value: "apple" as const, label: "Sign in with your Apple ID", hint: "recommended; your password stays on this machine" },
            { value: "p8" as const, label: "Use an App Store Connect API key (.p8)", hint: "for CI" },
          ],
        }),
      );
    let key;
    try {
      key = method === "apple" ? await keyFromAppleId(opts) : await keyFromP8(opts);
    } catch (e) {
      if (e instanceof AppleAuthError) fail(e.message);
      throw e;
    }
    const spin = p.spinner();
    spin.start("Checking the key with Apple");
    await unwrap(lb.PUT("/v1/orgs/{org}/apple/keys", { params: { path: org }, body: key })).catch((e) => {
      spin.error("Apple rejected the key");
      throw e;
    });
    spin.stop("Key saved (encrypted)");
    teamId = key.teamId;
  }

  // 2. Which bundle ids to sign.
  const detected = [...new Set([...(await detectBundleIds()), ...(opts.bundleId ?? [])])];
  if (!detected.length) fail("No iOS bundle identifier found. Set expo.ios.bundleIdentifier in app.json, or pass --bundle-id.");
  const bundleIds =
    opts.yes || !isInteractive() || detected.length === 1
      ? detected
      : cancelled(await p.multiselect({ message: "Sign these bundle ids (the app and its extensions)", options: detected.map((id) => ({ value: id, label: id })), initialValues: detected, required: true }));

  // 3. Certificate and profiles: App Store, and ad hoc when asked for or when the team has test devices.
  const kinds: ("store" | "adhoc")[] = opts.adhoc ? ["adhoc"] : ["store"];
  if (!opts.adhoc && isInteractive() && !opts.yes) {
    const devices = (await unwrap(lb.GET("/v1/orgs/{org}/devices", { params: { path: org } }))).filter((d) => d.teamId === teamId && d.enabled);
    if (devices.length && cancelled(await p.confirm({ message: `Also sign internal builds for your ${devices.length} registered device${devices.length > 1 ? "s" : ""} (ad hoc)?`, initialValue: true }))) {
      kinds.push("adhoc");
    }
  }
  let result;
  for (const kind of kinds) result = await provisionKind(lb, path, teamId!, bundleIds, kind);
  return result!;
}

async function provisionKind(lb: ReturnType<typeof client>, path: { org: string; project: string }, teamId: string, bundleIds: string[], kind: "store" | "adhoc") {
  let revokeCertificateIds: string[] | undefined;
  const label = kind === "adhoc" ? "ad hoc " : "";
  for (;;) {
    const spin = p.spinner();
    spin.start(`Creating the distribution certificate and ${bundleIds.length} ${label}profile${bundleIds.length > 1 ? "s" : ""}`);
    try {
      const result = await unwrap(lb.POST("/v1/orgs/{org}/projects/{project}/signing/ios/provision", { params: { path }, body: { teamId, bundleIds, revokeCertificateIds, kind } }));
      spin.stop(kind === "adhoc" ? `Ad hoc signing ready for ${result.deviceCount} device${result.deviceCount === 1 ? "" : "s"}` : "Signing ready");
      p.log.success(`Distribution certificate ${result.certificate.created ? "created" : "reused"} · expires ${result.certificate.expiresAt.slice(0, 10)}`);
      for (const pr of result.profiles) p.log.success(`${kind === "adhoc" ? "Ad hoc profile" : "Profile"} ${pr.bundleId} · expires ${pr.expiresAt.slice(0, 10)}`);
      return result;
    } catch (e) {
      spin.error(kind === "adhoc" ? "Ad hoc signing needs attention" : "Apple needs a decision");
      if (e instanceof LiftbayApiError && e.code === "no_devices") fail(`${e.message}`);
      if (!(e instanceof LiftbayApiError) || e.code !== "certificate_limit" || revokeCertificateIds) throw e;
      if (!isInteractive()) fail(`${e.message}\n${Object.entries(e.fields).map(([id, d]) => `  ${id}  ${d}`).join("\n")}\nRun interactively to choose one.`);
      const id = cancelled(await p.select({ message: e.message, options: Object.entries(e.fields).map(([value, label]) => ({ value, label })) }));
      const ok = cancelled(await p.confirm({ message: "Revoke it? Apps already signed with it keep working.", initialValue: false }));
      if (!ok) fail("Stopped. Revoke a certificate yourself in the Apple Developer site, then run this again.");
      revokeCertificateIds = [id];
    }
  }
}

export async function credentialsIosCommand(opts: IosCredentialOptions & { signOut?: boolean }) {
  if (opts.signOut) {
    const appleId = opts.appleId ?? fail("Pass --apple-id to sign out of that Apple ID");
    AppleSession.forget(appleId);
    return console.log(`${pc.green("✔")} Removed the saved Apple session for ${appleId}`);
  }
  p.intro(pc.bgCyan(pc.black(" liftbay credentials ios ")));
  await setUpIos(opts);
  p.outro(
    opts.adhoc
      ? `Internal iOS builds now install on your registered devices. Start one with ${pc.cyan("liftbay build --platform ios --profile preview")}`
      : `iOS builds are now signed. Start one with ${pc.cyan("liftbay build --platform ios")}`,
  );
}

/** What's stored: the organization's Apple keys and this project's signing material. */
export async function credentialsCommand() {
  const config = requireConfig();
  const lb = client();
  const apple = await unwrap(lb.GET("/v1/orgs/{org}/apple", { params: { path: { org: config.org } } }));
  const signing = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/signing", { params: { path: { org: config.org, project: config.project } } }));
  console.log(pc.bold("Apple"));
  if (!apple.keys.length) console.log(`  No App Store Connect key. Run ${pc.cyan("liftbay credentials ios")}`);
  for (const k of apple.keys) console.log(`  Team ${k.teamName ?? ""} ${pc.dim(k.teamId)} · key ${k.keyId}`);
  for (const c of apple.certificates) console.log(`  Distribution certificate ${pc.dim(c.serialNumber)} · expires ${c.expiresAt.slice(0, 10)}`);
  console.log(pc.bold(`\n${config.project}`));
  const ios = (s: typeof signing.ios, none: string) =>
    s ? `${pc.green("ready")} · team ${s.teamId} · ${s.bundleIds.length || "?"} bundle id${s.bundleIds.length === 1 ? "" : "s"}${s.deviceCount !== null ? ` · ${s.deviceCount} devices` : ""}${s.expiresAt ? ` · expires ${s.expiresAt.slice(0, 10)}` : ""}` : none;
  console.log(`  iOS (App Store)    ${ios(signing.ios, pc.yellow("none: store builds are simulator builds"))}`);
  console.log(`  iOS (ad hoc)       ${ios(signing.iosAdhoc, pc.dim(`none: run ${pc.cyan("liftbay credentials ios --adhoc")} for internal builds`))}`);
  console.log(
    `  Android upload key ${signing.android ? `${pc.green("ready")} · alias ${signing.android.keyAlias} · ${signing.android.source}` : pc.dim(`created on the first Android build, or bring yours: ${pc.cyan("liftbay credentials android import")}`)}`,
  );
  const play = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/stores/google-play", { params: { path: { org: config.org, project: config.project } } }));
  console.log(`  Google Play        ${play ? `${pc.green("ready")} · ${play.clientEmail}` : pc.dim(`none (liftbay credentials android --play-key key.json)`)}`);
}

export type AndroidImportOptions = { keystore?: string; alias?: string; storePassword?: string; keyPassword?: string; replace?: boolean; yes?: boolean };

const expandHome = (path: string) => path.replace(/^~/, process.env.HOME ?? "~");
/** Play Console shows certificate fingerprints as colon-separated uppercase hex. */
const fingerprint = (hex: string) => hex.toUpperCase().match(/.{2}/g)!.join(":");

/** Uses an existing upload keystore (the key your app is registered with on Play) instead of one Liftbay generates. */
export async function credentialsAndroidImportCommand(opts: AndroidImportOptions) {
  const config = requireConfig();
  const lb = client();
  const path = { org: config.org, project: config.project };
  const interactive = isInteractive() && !opts.yes;
  const ask = async (message: string) => (interactive ? cancelled(await p.text({ message })) : undefined);

  const file = opts.keystore ?? (await ask("Path to the upload keystore (.jks, .keystore or .p12)")) ?? fail("Pass --keystore <file>");
  if (!existsSync(expandHome(file))) fail(`No file at ${file}`);
  const keystore = readFileSync(expandHome(file));
  const keyAlias = opts.alias ?? process.env.LIFTBAY_KEY_ALIAS ?? (await ask("Key alias")) ?? fail("Pass --alias <alias> (or LIFTBAY_KEY_ALIAS)");
  const storePassword =
    opts.storePassword ??
    process.env.LIFTBAY_KEYSTORE_PASSWORD ??
    (interactive ? cancelled(await p.password({ message: "Keystore password" })) : fail("Set LIFTBAY_KEYSTORE_PASSWORD (or pass --store-password)"));
  // PKCS12 keystores have one password; JKS ones may have a separate key password.
  const keyPassword =
    opts.keyPassword ??
    process.env.LIFTBAY_KEY_PASSWORD ??
    (interactive ? cancelled(await p.password({ message: "Key password (Enter if it's the keystore password)", validate: () => undefined })) || undefined : undefined);

  const body = { keystoreBase64: keystore.toString("base64"), storePassword, keyAlias, keyPassword, replace: !!opts.replace };
  let status;
  try {
    status = await unwrap(lb.PUT("/v1/orgs/{org}/projects/{project}/signing/android", { params: { path }, body }));
  } catch (e) {
    if (!(e instanceof LiftbayApiError) || e.status !== 409 || opts.replace) throw e;
    const warning = "This project already has an Android upload key. Replacing it means Play rejects uploads until you reset the upload key in Play Console (unless this is the same key).";
    if (!interactive) fail(`${warning}\nExport a backup with ${pc.cyan("liftbay credentials android export")}, then pass --replace.`);
    p.log.warn(warning);
    if (!cancelled(await p.confirm({ message: "Replace the stored upload key?", initialValue: false }))) fail(`Kept the stored key. Back it up with ${pc.cyan("liftbay credentials android export")}.`);
    status = await unwrap(lb.PUT("/v1/orgs/{org}/projects/{project}/signing/android", { params: { path }, body: { ...body, replace: true } }));
  }
  console.log(`${pc.green("✔")} Upload key imported (encrypted) · alias ${status.android?.keyAlias ?? keyAlias}`);
  if (status.android?.certificateSha256) console.log(pc.dim(`  Certificate SHA-256 ${fingerprint(status.android.certificateSha256)}\n  It should match the upload key certificate in Play Console → Test and release → App integrity.`));
}

/** Downloads the stored upload keystore and its passwords, for a backup. Owners and admins only; audit logged. */
export async function credentialsAndroidExportCommand(opts: { out?: string; force?: boolean }) {
  const config = requireConfig();
  const lb = client();
  const key = await unwrap(lb.POST("/v1/orgs/{org}/projects/{project}/signing/android/export", { params: { path: { org: config.org, project: config.project } } }));
  const out = resolve(expandHome(opts.out ?? `${config.project}-upload.${key.format === "jks" ? "jks" : "p12"}`));
  const properties = join(dirname(out), `${basename(out, extname(out))}.properties`);
  for (const f of [out, properties]) if (existsSync(f) && !opts.force) fail(`${f} exists. Pass --force to overwrite it.`);
  writeFileSync(out, Buffer.from(key.keystoreBase64, "base64"), { mode: 0o600 });
  // keystore.properties, the format Android projects read signing configs from.
  const escape = (v: string) => v.replace(/\\/g, "\\\\").replace(/([:=#!])/g, "\\$1");
  writeFileSync(
    properties,
    [
      `# Liftbay Android upload key for ${config.org}/${config.project}, exported ${new Date().toISOString()}`,
      "# Contains secrets: store it in a password manager and never commit it.",
      `storeFile=${escape(out)}`,
      `storePassword=${escape(key.storePassword)}`,
      `keyAlias=${escape(key.keyAlias)}`,
      `keyPassword=${escape(key.keyPassword)}`,
      ...(key.certificateSha256 ? [`# Certificate SHA-256: ${fingerprint(key.certificateSha256)}`] : []),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  // writeFileSync's mode only applies to new files.
  chmodSync(out, 0o600);
  chmodSync(properties, 0o600);
  console.log(`${pc.green("✔")} Keystore      ${out}`);
  console.log(`${pc.green("✔")} Passwords     ${properties}`);
  console.log(`  Alias ${key.keyAlias} · ${key.format.toUpperCase()}${key.certificateSha256 ? ` · SHA-256 ${fingerprint(key.certificateSha256)}` : ""}`);
  console.log(pc.yellow("! These files contain your upload key and its passwords. Keep them somewhere safe and out of git."));
}
