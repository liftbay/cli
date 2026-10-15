import { createPublicKey, createSign, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import * as p from "@clack/prompts";
import forge from "node-forge";

const lf = (pem: string) => pem.replace(/\r\n/g, "\n");
import pc from "picocolors";
import { client, cmd, fail, isInteractive, unwrap } from "../context.ts";
import { readAppJson, requireConfig, writeAppJson } from "../project.ts";
import { cancelled } from "./link.ts";

export const DEFAULT_PRIVATE_KEY = "keys/liftbay-private-key.pem";
const DEFAULT_PUBLIC_KEY = "certs/liftbay-public-key.pem";
const DEFAULT_CERTIFICATE = "certs/liftbay-certificate.pem";
/** Signed once and stored with the certificate: the reply to an app with nothing new. */
const NO_UPDATE_DIRECTIVE = JSON.stringify({ type: "noUpdateAvailable" });
const KEY_ID = "main";

/**
 * A self-signed code signing certificate like `expo-updates codesigning:generate` makes: RSA 2048,
 * digitalSignature + codeSigning, valid for `years`.
 */
export function generateSigningCertificate(commonName: string, years = 10) {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = `01${randomBytes(8).toString("hex")}`;
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + years * 365 * 86_400_000);
  const attrs = [{ name: "commonName", value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "keyUsage", critical: true, keyCertSign: false, digitalSignature: true },
    { name: "extKeyUsage", critical: true, codeSigning: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    // node-forge writes PEM with \r\n; CodePush on iOS strips only \n from the public key and then fails to read it.
    privateKeyPem: lf(forge.pki.privateKeyToPem(keys.privateKey)),
    publicKeyPem: lf(forge.pki.publicKeyToPem(keys.publicKey)),
    certificatePem: lf(forge.pki.certificateToPem(cert)),
  };
}

export const signRsaSha256 = (privateKeyPem: string, data: Buffer) => createSign("RSA-SHA256").update(data).sign(privateKeyPem, "base64");

/**
 * The update signing key, if this machine has one: `--private-key`, then LIFTBAY_UPDATE_PRIVATE_KEY
 * (the PEM itself, for CI secrets, or a path), then the default path written by `signing init`.
 */
export function loadPrivateKey(path?: string): { pem: string; source: string } | null {
  const read = (file: string, label: string) => {
    if (!existsSync(file)) fail(`No private key at ${file} (${label})`);
    return { pem: readFileSync(file, "utf8"), source: file };
  };
  if (path) return read(path, "--private-key");
  const env = process.env.LIFTBAY_UPDATE_PRIVATE_KEY;
  if (env) return env.includes("PRIVATE KEY") ? { pem: env.replace(/\\n/g, "\n"), source: "LIFTBAY_UPDATE_PRIVATE_KEY" } : read(env, "LIFTBAY_UPDATE_PRIVATE_KEY");
  return existsSync(DEFAULT_PRIVATE_KEY) ? { pem: readFileSync(DEFAULT_PRIVATE_KEY, "utf8"), source: DEFAULT_PRIVATE_KEY } : null;
}

function ensureIgnored(entry: string) {
  const current = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : "";
  if (current.split("\n").some((l) => l.trim() === entry || l.trim() === entry.replace(/\/$/, ""))) return false;
  writeFileSync(".gitignore", `${current}${current && !current.endsWith("\n") ? "\n" : ""}\n# Liftbay update signing key: never commit it\n${entry}\n`);
  return true;
}

/** Points the Liftbay config plugin at the certificate; expo-updates then embeds it in the app. */
function configureAppJson(certificatePath: string): boolean {
  const appJson = readAppJson();
  if (!appJson) return false;
  const expo = (appJson.expo ??= {});
  const plugins: unknown[] = (expo.plugins ??= []);
  const at = plugins.findIndex((pl) => (Array.isArray(pl) ? pl[0] : pl) === "@liftbay/expo-plugin");
  const options = { ...(at >= 0 && Array.isArray(plugins[at]) ? (plugins[at] as [string, Record<string, unknown>])[1] : {}), codeSigningCertificate: `./${certificatePath}` };
  if (at >= 0) plugins[at] = ["@liftbay/expo-plugin", options];
  else plugins.push(["@liftbay/expo-plugin", options]);
  writeAppJson(appJson);
  return true;
}

export async function signingInit(opts: { privateKey?: string; certificate?: string; commonName?: string; force?: boolean; yes?: boolean }) {
  const config = requireConfig();
  const lb = client();
  const path = { org: config.org, project: config.project };
  p.intro(pc.bgCyan(pc.black(" liftbay update signing init ")));

  const { signing } = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/updates/signing", { params: { path } }));
  if (signing && !opts.force) {
    fail(
      `This project already signs updates (certificate ${signing.fingerprint.slice(0, 16)}…). Pass --force to replace it; ` +
        "apps built with the current certificate will reject updates signed with a new key until they're rebuilt.",
    );
  }

  const privateKeyPath = opts.privateKey ?? DEFAULT_PRIVATE_KEY;
  const certificatePath = opts.certificate ?? DEFAULT_CERTIFICATE;
  if (existsSync(privateKeyPath) && !opts.force) fail(`${privateKeyPath} already exists. Pass --force to overwrite it, or --private-key for another path.`);

  const generated = generateSigningCertificate(opts.commonName ?? config.project);
  for (const dir of new Set([dirname(privateKeyPath), dirname(certificatePath), dirname(DEFAULT_PUBLIC_KEY)])) mkdirSync(dir, { recursive: true });
  writeFileSync(privateKeyPath, generated.privateKeyPem, { mode: 0o600 });
  chmodSync(privateKeyPath, 0o600);
  writeFileSync(certificatePath, generated.certificatePem);
  writeFileSync(DEFAULT_PUBLIC_KEY, generated.publicKeyPem);
  if (ensureIgnored(`${dirname(relative(".", privateKeyPath))}/`)) p.log.info(`Added ${pc.cyan(`${dirname(privateKeyPath)}/`)} to .gitignore`);
  p.log.success(`Private key: ${pc.cyan(privateKeyPath)} (stays on this machine)\n  Certificate: ${pc.cyan(certificatePath)} (commit it; it's embedded in your app)`);

  // Upload only the public certificate, with a signature proving we hold its private key.
  await unwrap(
    lb.PUT("/v1/orgs/{org}/projects/{project}/updates/signing", {
      params: { path },
      body: { certificatePem: generated.certificatePem, keyId: KEY_ID, noUpdateSignature: signRsaSha256(generated.privateKeyPem, Buffer.from(NO_UPDATE_DIRECTIVE)) },
    }),
  );
  p.log.success("Certificate saved to Liftbay");

  if (configureAppJson(certificatePath)) p.log.success(`Updated ${pc.cyan("app.json")}: the Liftbay plugin embeds the certificate in your app`);
  else p.note(`plugins: [["@liftbay/expo-plugin", { "codeSigningCertificate": "./${certificatePath}" }]]`, "Add to your app config");

  const channels = await unwrap(lb.GET("/v1/orgs/{org}/projects/{project}/channels", { params: { path } }));
  const signedOnly =
    !!channels.length &&
    (opts.yes || !isInteractive() || cancelled(await p.confirm({ message: "Require signed updates on every channel? Unsigned publishes will be refused.", initialValue: true })));
  if (signedOnly) {
    for (const ch of channels) {
      await unwrap(lb.PATCH("/v1/orgs/{org}/projects/{project}/channels/{channel}", { params: { path: { ...path, channel: ch.name } }, body: { signedOnly: true } }));
    }
    p.log.success(`Signed updates required on ${channels.map((c) => c.name).join(", ")}`);
  }

  p.note(
    [
      `1. Rebuild your apps once: the certificate is part of the binary.`,
      `2. ${pc.cyan(cmd("liftbay update publish"))} signs automatically with ${privateKeyPath}.`,
      `3. In CI, store the private key as a secret named ${pc.cyan("LIFTBAY_UPDATE_PRIVATE_KEY")}.`,
      `4. Back the key up somewhere safe. If it's lost, apps need a rebuild with a new certificate.`,
      ``,
      `hot-updater: set ${pc.cyan("HOT_UPDATER_PUBLIC_KEY")} (iOS Info.plist) / ${pc.cyan("com.hotupdater.PUBLIC_KEY")} (Android manifest meta-data) to ${DEFAULT_PUBLIC_KEY}.`,
      `CodePush: set ${pc.cyan("CodePushPublicKey")} (iOS) / ${pc.cyan("CodePushPublicKey")} string resource (Android) to ${DEFAULT_PUBLIC_KEY}.`,
    ].join("\n"),
    "Next",
  );
  p.outro("Update signing is set up.");
  return { privateKey: privateKeyPath, certificate: certificatePath, publicKey: DEFAULT_PUBLIC_KEY, signedOnlyChannels: signedOnly ? channels.map((c) => c.name) : [] };
}

/** Signs every item of a prepared release; the server checks each one against the certificate. */
export function signDraft(items: { id: string; data: string }[], privateKeyPem: string): Record<string, string> {
  try {
    createPublicKey(privateKeyPem);
  } catch {
    fail("The update signing key isn't a valid PEM private key");
  }
  return Object.fromEntries(items.map((i) => [i.id, signRsaSha256(privateKeyPem, Buffer.from(i.data, "base64"))]));
}

