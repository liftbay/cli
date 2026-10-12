import { Command } from "commander";
import { reportError } from "./context.ts";
import { login, logout, whoami } from "./commands/auth.ts";
import { build } from "./commands/build.ts";
import { xcodeCloudConnect, xcodeCloudDisconnect, xcodeCloudStatus } from "./commands/xcode-cloud.ts";
import { credentialsAndroidExportCommand, credentialsAndroidImportCommand, credentialsCommand, credentialsIosCommand } from "./commands/credentials.ts";
import { credentialsAndroidCommand, submit } from "./commands/submit.ts";
import { deviceAdd, deviceList, deviceRemove } from "./commands/devices.ts";
import { ciInitCommand, initCommand, otaInitCommand } from "./commands/setup.ts";
import { channels, list, publish, rollback, rollout } from "./commands/update.ts";
import { signingInit } from "./commands/signing.ts";

const program = new Command("liftbay").description("Build, ship and update React Native apps").version("0.1.1");
const wrap =
  <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) =>
  async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (e) {
      reportError(e);
    }
  };

const setupOptions = (cmd: Command) =>
  cmd
    .option("--org <slug>", "organization")
    .option("--project <slug>", "project slug (created if it doesn't exist)")
    .option("--platforms <list>", "ios, android or all")
    .option("--runtime-policy <policy>", "appVersion or fingerprint")
    .option("-y, --yes", "accept defaults, no prompts")
    .option("--api-url <url>", "API URL (for self-hosted or local development)")
    .option("--dashboard-url <url>", "dashboard URL");

program
  .command("login")
  .description("Sign in through the browser")
  .option("--api-url <url>", "API URL")
  .option("--dashboard-url <url>", "dashboard URL")
  .option("--no-open", "don't open the browser")
  .action(wrap(login));
program.command("logout").description("Sign out and remove the saved token").action(wrap(logout));
program.command("whoami").description("Show the signed-in user and organizations").action(wrap(whoami));

setupOptions(program.command("init").description("Set up this app: link the project, builds, then OTA updates").option("--no-ota", "skip OTA updates")).action(wrap(initCommand));

const ci = program.command("ci").description("Builds");
setupOptions(ci.command("init").description("Set up build profiles, environments and app identifiers")).action(wrap(ciInitCommand));

program
  .command("build")
  .description("Build on your GitHub Actions (Android on Linux, iOS on macOS) and follow the logs")
  .option("--platform <platform>", "ios, android or all (default: the profile's platforms)")
  .option("--profile <name>", "build profile from liftbay.json", "production")
  .option("--ref <ref>", "branch, tag or commit to build (default: current branch)")
  .option("-m, --message <text>", "build message")
  .option("--simulator", "iOS: build for the simulator instead of a signed .ipa")
  .option("--no-wait", "queue and exit without following the logs")
  .option("--submit", "submit store builds when they succeed: TestFlight, or a Google Play track")
  .option("--track <track>", "Play track for --submit: internal, alpha, beta or production")
  .option("--engine <engine>", "auto (default), github-actions or xcode-cloud")
  .action(wrap(build));

program
  .command("submit")
  .description("Submit a store build to TestFlight (iOS) or a Google Play track (Android)")
  .option("--build <number>", "build number to submit")
  .option("--latest", "the newest successful store build of each platform (default)")
  .option("--platform <platform>", "ios, android or all (default all)")
  .option("--track <track>", "Play track: internal (default), alpha, beta or production")
  .option("--rollout <percent>", "Play: staged rollout percentage")
  .option("--no-wait", "queue and exit without following progress")
  .action(wrap(submit));

const xcodeCloud = program.command("xcode-cloud").description("Run iOS store builds on your own Xcode Cloud");
xcodeCloud
  .command("connect")
  .description("Link the app's Xcode Cloud product and create the Liftbay workflow (waits for the one-time App Store Connect step)")
  .option("--team-id <id>", "Apple team ID, if the organization has several")
  .option("--workspace <path>", "workspace, e.g. ios/App.xcworkspace (default: detected)")
  .option("--scheme <name>", "scheme to archive (default: detected)")
  .option("--no-wait", "don't wait for the App Store Connect step")
  .action(wrap(xcodeCloudConnect));
xcodeCloud.command("status").description("Connection and this month's estimated hours").action(wrap(xcodeCloudStatus));
xcodeCloud.command("disconnect").description("Remove the Liftbay workflow; iOS builds go back to GitHub Actions").action(wrap(xcodeCloudDisconnect));

const collect = (value: string, prev: string[] = []) => [...prev, value];
const credentials = program.command("credentials").description("Signing credentials: show what's stored").action(wrap(credentialsCommand));
credentials
  .command("ios")
  .description("Set up iOS signing: sign in with your Apple ID (or use a .p8 key); Liftbay creates the certificate and profiles")
  .option("--apple-id <email>", "Apple ID to sign in with (or LIFTBAY_APPLE_ID)")
  .option("--team-id <id>", "Apple team ID")
  .option("--bundle-id <id>", "bundle id to sign, repeatable (default: detected app and extensions)", collect)
  .option("--p8 <file>", "use an App Store Connect API key file instead of signing in")
  .option("--key-id <id>", "key ID of the .p8 key")
  .option("--issuer-id <uuid>", "issuer ID of the .p8 key")
  .option("--adhoc", "ad hoc profiles for registered devices (internal builds) instead of App Store profiles")
  .option("--sign-out", "forget the saved Apple session for --apple-id")
  .option("-y, --yes", "no prompts")
  .action(wrap(credentialsIosCommand));
const android = credentials
  .command("android")
  .description("Google Play service account for Play uploads (shows the current one without options); import or export the upload key")
  .option("--play-key <file>", "service account JSON key file")
  .option("--remove", "remove the stored service account")
  .action(wrap(credentialsAndroidCommand));
android
  .command("import")
  .description("Sign Android builds with your existing upload keystore (PKCS12 or JKS) instead of a generated one")
  .option("--keystore <file>", "the .jks, .keystore or .p12 file")
  .option("--alias <alias>", "key alias (or LIFTBAY_KEY_ALIAS)")
  .option("--store-password <password>", "keystore password; prefer LIFTBAY_KEYSTORE_PASSWORD, flags end up in shell history")
  .option("--key-password <password>", "key password if different (or LIFTBAY_KEY_PASSWORD; default: the keystore password)")
  .option("--replace", "replace a stored upload key (Play then needs an upload key reset, unless it's the same key)")
  .option("-y, --yes", "no prompts")
  .action(wrap(credentialsAndroidImportCommand));
android
  .command("export")
  .description("Download the upload keystore and a keystore.properties with its alias and passwords, for a backup (owners and admins)")
  .option("--out <file>", "keystore file to write (default: <project>-upload.p12 or .jks); the .properties file goes next to it")
  .option("--force", "overwrite existing files")
  .action(wrap(credentialsAndroidExportCommand));

const device = program.command("device").description("iOS test devices for internal (ad hoc) builds");
device
  .command("add")
  .description("Register an iPhone or iPad: shows a QR code to open on it, or pass --udid")
  .option("--udid <udid>", "add by UDID instead of a registration link")
  .option("--name <name>", "device name (with --udid)")
  .option("--team-id <id>", "Apple team, when the organization has several")
  .action(wrap(deviceAdd));
device.command("list").description("List registered devices").action(wrap(deviceList));
device.command("remove <id>").description("Remove a device (disabled at Apple)").action(wrap(deviceRemove));

const ota = program.command("ota").description("Over-the-air updates");
setupOptions(ota.command("init").description("Set up expo-updates, the Liftbay plugin and channels")).action(wrap(otaInitCommand));

const update = program.command("update").description("Publish and manage OTA updates");
update
  .command("publish")
  .description("Export the JS bundle and publish it to a channel")
  .option("--channel <name>", "channel (default: production)")
  .option("--profile <name>", "use the channel of this build profile")
  .option("--platform <platform>", "ios, android or all", "all")
  .option("-m, --message <text>", "release message (default: last commit message)")
  .option("--rollout <percent>", "start with a partial rollout", "100")
  .option("--mandatory", "apply immediately instead of on next launch")
  .option("--private-key <file>", "update signing key (default: LIFTBAY_UPDATE_PRIVATE_KEY, then keys/liftbay-private-key.pem)")
  .action(wrap(publish));
const signing = update.command("signing").description("Sign updates with your own key (expo-updates, hot-updater, CodePush)");
signing
  .command("init")
  .description("Create a signing key and certificate, keep the key here, and register the certificate")
  .option("--private-key <file>", "where to write the private key", "keys/liftbay-private-key.pem")
  .option("--certificate <file>", "where to write the certificate", "certs/liftbay-certificate.pem")
  .option("--common-name <name>", "certificate common name (default: project slug)")
  .option("--force", "replace an existing key and certificate")
  .option("-y, --yes", "no prompts; require signed updates on every channel")
  .action(wrap(signingInit));

update.command("list").description("Release history of a channel").option("--channel <name>", "channel", "production").action(wrap(list));
update.command("rollback").description("Roll back the active release").option("--channel <name>", "channel", "production").action(wrap(rollback));
update
  .command("rollout <percent>")
  .description("Change the active release's rollout percentage")
  .option("--channel <name>", "channel", "production")
  .action(wrap(rollout));

program.command("channels").description("List update channels").action(wrap(channels));

program.parseAsync().catch(reportError);
