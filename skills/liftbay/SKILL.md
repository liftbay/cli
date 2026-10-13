---
name: liftbay
description: Build, sign, submit and update React Native and Expo apps with Liftbay (liftbay.dev). Use when the user wants to set up CI/CD for a React Native or Expo app, build an iOS .ipa or Android .apk/.aab, set up iOS or Android signing, upload to TestFlight or Google Play, register test iPhones for ad hoc installs, or publish, roll out or roll back over-the-air (OTA) updates. Also use when a repo has a liftbay.json file or the user mentions Liftbay.
---

# Liftbay

Liftbay is CI/CD for React Native and Expo. Builds run on the user's own GitHub Actions (Android on Linux, iOS on macOS) or their own Xcode Cloud, so nothing needs Xcode on this machine. Liftbay handles signing, store submission and OTA updates.

You drive it through the `liftbay` CLI. Run it as `npx liftbay@latest <command>`, or as `liftbay` if it's installed (`npm i -g liftbay`). Run every command from the app's root folder: the one with `package.json` and, once linked, `liftbay.json`.

## Rules for agents

- **Always pass `--json`.** Stdout then holds exactly one JSON document: the result, or `{"error": {"code", "message", ...}}` with exit code 1. Progress and logs go to stderr. With `--json` the CLI never prompts; when it needs something, it fails with a message naming the flag to pass.
- **Never block on long waits.** Use `--no-wait` on `build`, `submit`, `login` and `device add`, then check back with `builds view`, `submissions list` or `whoami`.
- **Ask the user before anything that reaches real users or stores:** an OTA publish, rollout change or rollback on `production`; submitting to TestFlight; any Google Play track other than `internal`; cancelling a build someone else started.
- **Never handle secrets yourself.** Don't ask for, print, pass or commit Apple passwords, keystore passwords or the update signing key (`keys/liftbay-private-key.pem`). When a step needs one, ask the user to run that command in their own terminal.
- Read error messages: they say exactly what to do next.

## 1. Sign in

Check first:

```bash
liftbay whoami --json
```

If it fails with "Not signed in", use the browser sign-in in two steps:

```bash
liftbay login --no-wait --json
```

This returns `{"status": "pending", "userCode": "ABCD-EFGH", "url": "https://liftbay.dev/device?code=ABCD-EFGH", ...}` and opens the browser on this machine. Give the user the `url` and `userCode`, and ask them to approve it and tell you when they're done. Then finish:

```bash
liftbay login --json
```

It returns `{"status": "signed_in", "user": {...}}`. The request expires after 10 minutes; if it does, start again. The token is saved in `~/.liftbay/credentials.json`, so later commands just work.

**CI or unattended agents:** set `LIFTBAY_TOKEN` to an organization API token instead. The user creates it at `https://liftbay.dev/<org>/tokens`, and it takes priority over the saved login.

## 2. Link the app (once per repository)

```bash
liftbay init --yes --json
```

This detects the app (Expo or bare React Native), creates or links the Liftbay project, and writes `liftbay.json`. It also writes `.github/workflows/liftbay.yml` and sets up OTA updates with expo-updates and `@liftbay/expo-plugin` in `app.json`.

Useful flags:
- `--org <slug>`: required if the user is in several organizations; the error lists them.
- `--project <slug>`
- `--platforms ios|android|all`
- `--runtime-policy appVersion|fingerprint`
- `--no-ota`: builds only.

To set up one part on its own, use `liftbay ci init --yes --json` (builds) or `liftbay ota init --yes --json` (OTA).

Then:
1. Commit `liftbay.json`, `.github/workflows/liftbay.yml`, `app.json` and `package.json`, and push. Builds only work on branches that contain the workflow file.
2. The user installs the **Liftbay GitHub App** on the repository's owner at `https://liftbay.dev/<org>/github`. Builds start the workflow through it.

`liftbay.json` defines three build profiles:

| Profile | Distribution | Typical use |
|---|---|---|
| `development` | internal | dev builds |
| `preview` | internal | ad hoc iOS installs, APKs for testers |
| `production` | store | TestFlight and Google Play |

Each profile has an `environment` (its secrets and variables) and an OTA `channel` with the same name.

## 3. Signing

**Android:** nothing to do. Liftbay creates the upload key on the first Android build and stores it encrypted.
- To bring an existing key, the user runs `liftbay credentials android import --keystore <file> --alias <alias>`, with the password in `LIFTBAY_KEYSTORE_PASSWORD`.
- For a backup, the user runs `liftbay credentials android export` (owners and admins only).

**iOS:** needs the user once. Ask them to run this in their own terminal:

```bash
npx liftbay credentials ios
```

They sign in with their Apple ID, including the two-factor code, and Liftbay creates an App Store Connect API key, the distribution certificate and the profiles. After that, the key is saved for the organization and you can run iOS commands yourself. The Apple session is also saved, so `liftbay credentials ios --apple-id <email> --yes --json` works without prompts afterwards (for example, to add `--adhoc` profiles).

Without an Apple ID sign-in, the user can provide an App Store Connect API key instead: `--p8 AuthKey_XXXX.p8 --key-id <id> --issuer-id <uuid> --team-id <id>`.

Check what's stored:

```bash
liftbay credentials --json
```

## 4. Build

```bash
liftbay build --platform android --profile preview --no-wait --json
liftbay build --platform ios --profile production --no-wait --json
```

The result is `{"builds": [{"number": 12, "platform": "ios", "status": "queued", "url": ...}]}`. Builds take about 5–40 minutes, iOS longer. Check progress:

```bash
liftbay builds view 12 --json             # status, phases, artifacts; installUrl for ad hoc iOS builds
liftbay builds logs 12 --tail 200 --json  # the end of the log, to explain a failure
liftbay builds list --status failed --json
liftbay builds download 12 --out ./artifacts --json
liftbay builds cancel 12 --json
```

Statuses: `queued` → `preparing` → `running` → `uploading` → `succeeded` | `failed` | `cancelled`. When a build fails, read the last lines of the log. The reason is usually at the end: a dependency, native build or signing error, or a missing workflow file or GitHub App.

Other flags:
- `--ref <branch|tag|sha>`: defaults to the current branch, which must be pushed.
- `--simulator`: unsigned iOS simulator build; needs no Apple account.
- `--engine github-actions|xcode-cloud`
- `-m "message"`

**Xcode Cloud (optional):** `liftbay xcode-cloud connect --json`. Its error says which one-time step the user has to do in App Store Connect.

## 5. Submit to the stores

Submit as part of the build:

```bash
liftbay build --platform ios --profile production --submit --no-wait --json
```

Or submit a finished store build later:

```bash
liftbay submit --platform ios --no-wait --json                       # TestFlight
liftbay submit --platform android --track internal --no-wait --json  # Google Play
liftbay submissions list --json
liftbay submissions view <id> --json
```

- Google Play needs a service account first. The user adds it with `liftbay credentials android --play-key key.json`, or on the project's Credentials page.
- Play tracks are `internal`, `alpha`, `beta` and `production`. Use `--rollout <percent>` for a staged rollout.
- The first upload of a brand-new Play app must be done by hand in Play Console. Until then, uploads are saved as drafts.

## 6. Ad hoc iOS installs on test devices

1. Register the device:
   ```bash
   liftbay device add --no-wait --json
   ```
   This returns `registration.url`. The user opens it on the iPhone and installs the profile. Then check `liftbay device list --json`.
2. Create ad hoc profiles:
   ```bash
   liftbay credentials ios --adhoc --yes --json
   ```
   If this needs an Apple sign-in, ask the user to run it.
3. Build:
   ```bash
   liftbay build --platform ios --profile preview --no-wait --json
   ```
4. When the build has succeeded, `liftbay builds view <n> --json` returns `installUrl`. The user opens it on the registered device.

## 7. OTA updates (JS-only changes, no store review)

The app must have been built once after `liftbay ota init`, so the update URL is inside the binary. Then publish:

```bash
liftbay update publish --channel production -m "Fix checkout button" --json
```

This exports the bundle with `expo export`, uploads only new files, and publishes one release per runtime version. Confirm with the user before publishing to `production`.

Options:
- `--platform ios|android|all`
- `--rollout <percent>`: start partial.
- `--mandatory`: apply on download, not on next launch.
- `--profile <name>`: use that profile's channel.

Manage releases:

```bash
liftbay update list --channel production --json
liftbay update rollout 50 --channel production --json   # change the active release's rollout
liftbay update rollback --channel production --json     # previous release, or the bundle built into the app
liftbay channels --json
```

**Signed updates:** `liftbay update signing init --yes --json` creates a key pair. The private key stays in `keys/` (git-ignored) and the certificate goes into the app. After that, the apps need one rebuild, and every publish signs automatically. In CI, the key goes in the `LIFTBAY_UPDATE_PRIVATE_KEY` secret.

An update only reaches binaries with the same runtime version. When native code changes (new native modules, an Expo SDK upgrade, permissions), make a new build instead of an OTA update.

## Common errors

| Error | What to do |
|---|---|
| `Not signed in` | Section 1 |
| `No liftbay.json here` | Run from the app root, or `liftbay init --yes --json` |
| `Several organizations available; pass --org` | Pass `--org <slug>` from the list in the message |
| Build fails at once: no GitHub repository | Push the app to GitHub, then `liftbay ci init --yes --json` |
| Build fails: workflow not found / 404 | Commit and push `.github/workflows/liftbay.yml` on the branch you build |
| `github_not_connected` | User installs the Liftbay GitHub App at `liftbay.dev/<org>/github` |
| iOS build is a simulator build | No iOS signing yet: section 3 |
| `Apple ID sign-in needs a person` / two-factor code | Ask the user to run `npx liftbay credentials ios` in their terminal |
| `certificate_limit` | Apple allows a few distribution certificates per team. The user runs `liftbay credentials ios` interactively to pick one to revoke |
| `no_store_build` | Build with `--profile production` first |
| `plan_limit` (402) | Plan limit reached; the user upgrades at `liftbay.dev/<org>/billing` |
| `signed_required` | The channel only accepts signed updates; publish from a machine with the signing key |
| Update doesn't arrive | Wrong channel or runtime version; check `liftbay update list` and the app's `runtimeVersion` |

Docs: https://liftbay.dev/docs · Dashboard: https://liftbay.dev
