# liftbay

The Liftbay command-line tool: build, sign, submit and update React Native apps from your own CI.

```sh
npx liftbay login       # sign in through the browser
npx liftbay init        # link the app, set up builds and over-the-air updates
npx liftbay build       # build on your GitHub Actions and follow the logs
npx liftbay update publish --channel production
```

Requires Node.js 20 or newer. In CI, set `LIFTBAY_TOKEN` to an organization API token instead of `liftbay login`.

## For AI agents

The Liftbay agent skill teaches Claude Code, Codex, Cursor and other coding agents to use Liftbay:

```sh
npx skills add liftbay/skills
```

It's published at [liftbay/skills](https://github.com/liftbay/skills), and ships in this package too, as `skills/liftbay/SKILL.md`. Every command accepts `--json`: stdout then holds one JSON result or `{"error": …}`, progress goes to stderr, and nothing prompts. Guide: https://liftbay.dev/docs/agents

## Commands

| Command | What it does |
|---|---|
| `login`, `logout`, `whoami` | Account |
| `init`, `ci init`, `ota init` | Set up builds and updates for the app in this folder |
| `github status`, `github connect`, `github workflow` | The Liftbay GitHub App and the build workflow on your default branch |
| `build` | Queue builds on your GitHub Actions or Xcode Cloud and follow their logs |
| `builds list`, `builds view`, `builds logs`, `builds download`, `builds cancel` | Look at builds and their artifacts |
| `submit`, `submissions list`, `submissions view` | TestFlight and Google Play uploads |
| `device add`, `device list`, `device remove` | iOS test devices for ad hoc builds |
| `env list`, `env import`, `env set`, `env unset`, `env export` | Environment variables; `env import` reads `.env` files and `eas.json` |
| `credentials`, `credentials ios` | Show signing; set up iOS signing with your Apple ID or a `.p8` key |
| `update publish`, `update list`, `update rollout`, `update rollback` | Over-the-air updates |
| `channels` | List update channels |

Full reference: https://liftbay.dev/docs/cli

## What it sends where

The CLI talks to the Liftbay API (`api.liftbay.dev`) and to the signed storage URLs it hands out for uploads. `credentials ios` signs in to Apple from your machine: your Apple ID password goes only to Apple, and the session is kept in `~/.liftbay/apple` (readable only by you).

## Development

This repository is published from the Liftbay monorepo. Build with `npm run build`; the output is a single file in `dist/` with no runtime dependencies.

## License

Apache-2.0
