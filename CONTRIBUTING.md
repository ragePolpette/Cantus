# Contributing to Cantus

Cantus maps a codebase for developers and coding agents. A change should make its analysis, focused context or fixed agent/check/review loop more reliable or easier to use. New workflows and languages need a concrete use case; discuss them in an issue before implementing them.

## Development

Use Node.js 20.19+ (20.x) or 22.12+, Git and the pnpm version in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm check:package
```

`pnpm test` builds before running the Node test suite. The package check needs that build and the original tracked files under `grammars/`; it verifies the package manifest and loads each grammar to parse a language sample. Do not replace missing grammars with unrelated builds to obtain a green result.

For a focused check after building:

```sh
node --test tests/init.test.mjs
```

For manual testing, run `node /absolute/path/to/cantus/dist/cli.js init` inside a disposable project. `init --dry-run --no-serve` previews setup; `init --yes --no-serve` writes the map and accepts generated notes. Tasks that use an agent require that agent's own installation and authentication.

## Pull requests

- Keep one concrete problem per PR. Explain the trigger, resulting behavior and relevant limitations.
- Add a regression test for a behavior fix. Run the checks relevant to the change and the full suite before proposing a release.
- Record the commands, Node version, operating system and results. GitHub Actions minutes are currently exhausted: a missing CI run is not evidence that checks passed or failed.
- Check the nearest `AGENTS.md` before editing a block. Preserve generated markers and user-written notes.
- Keep CLI messages and code in English. Existing maintainer guides are in Italian; update the relevant guide when behavior changes.
- Plugin file changes require a plugin version increase and an updated version record; `tests/plugin-version.test.mjs` checks this.

Report an analysis failure with a small reproducible project and the expected imports, API or callers. Remove credentials and private source before sharing fixtures or logs. Separate verified results from estimates: Cantus does not yet have a demonstrated token or task-quality advantage over an unaided agent.

## Release preparation

See [docs/RELEASE.md](docs/RELEASE.md) for the release checks.

Run `npm run verify:release` for types, tests, package integrity and installation into a clean consumer. The installation step needs npm registry access, or a populated npm cache with `npm run smoke:package -- --offline`. See [docs/RELEASE.md](docs/RELEASE.md) for separate browser, platform and real-agent checks. Browser tests are optional when Playwright is absent: a skipped test is not a verified interface.
