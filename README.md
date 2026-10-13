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

This repository includes an agent skill that teaches Claude Code, Codex, Cursor and other coding agents to use Liftbay:

```sh
npx skills add liftbay/cli
```

The skill is [`skills/liftbay/SKILL.md`](skills/liftbay/SKILL.md). Every command accepts `--json`: stdout then holds one JSON result or `{"error": …}`, progress goes to stderr, and nothing prompts. Guide: https://liftbay.dev/docs/agents

## Commands

| Command | What it does |
|---|---|
| `login`, `logout`, `whoami` | Account |
| `init`, `ci init`, `ota init` | Set up builds and updates for the app in this folder |
| `build` | Queue builds on your GitHub Actions and follow their logs |
| `builds list`, `builds view`, `builds logs`, `builds download`, `builds cancel` | Look at builds and their artifacts |
| `submit`, `submissions list`, `submissions view` | TestFlight and Google Play uploads |
| `device add`, `device list`, `device remove` | iOS test devices for ad hoc builds |
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
