# Contributing to Keith

Keith is a personal agent harness: a core server, peripheral nodes and a terminal client, built on eharness.

## Prerequisites

- Bun 1.4.2 or later (the version in `package.json` `packageManager`).
- gitleaks for the pre-commit hook: `brew install gitleaks`. The hook fails instead of skipping when it is missing.

## Setup

```sh
bun install        # also points git at .githooks
bun run link       # puts keith-core, keith and keith-node on PATH
```

## The gate

- `bun run check` must pass. It runs Biome, the type checks, the tests, the import, size and export checks. CI runs the same command.
- `bun run smoke` must pass for changes that touch runtime behaviour. It starts real processes with a fake provider (about 40 seconds, so it is not part of `check`).

## Rules

- Read [AGENTS.md](AGENTS.md) first. Its hard rules apply to every change, human or agent.
- Specs are contracts. If you change the code's behaviour, change the spec in `docs/specs/` in the same commit.
- Commits and PR titles use Conventional Commits. Scopes are listed in [commitlint.config.js](commitlint.config.js). The commit-msg hook and CI enforce them.
- When behaviour that users see changes, add a changeset: `bunx changeset`.
- Keep repo text in English: code, UI strings, docs, plans and changelogs.

## Pull requests

1. Fork the repository and create a branch named `feat/<short-name>` or `fix/<short-name>`.
2. Make the change, with tests next to the code, and run `bun run check`.
3. Open a pull request against `main` and fill in the [pull request template](.github/pull_request_template.md).
4. Wait for CI to pass. Maintainers review and merge; they may ask for changes.

## License

Keith is licensed under [CC BY-NC-SA 4.0](LICENSE). By contributing you agree that your contribution is licensed under the same terms.

## Conduct and security

Be respectful; see the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately as described in [SECURITY.md](SECURITY.md), never in a public issue.
