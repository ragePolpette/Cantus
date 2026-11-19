# First use, TypeScript references and the breaking-change check

Measured on 19 November 2026 on Linux x64 with Node 24.22.3 and TypeScript language service 6.0.3. The [run data](results.json) identifies the tested source tree and records every timing and gate outcome. The check uses the built Cantus CLI with its default analysis settings. Project dependencies were not installed.

## First use

Five new local checkouts per repository. Times are wall-clock medians, with min–max in parentheses. Each fresh checkout starts with a dry run that writes no Cantus files, then runs `init --no-serve` twice and exports HTML. The script checks that the second init leaves the saved map byte-for-byte identical and that init leaves tracked files untouched. The timings include CLI startup. Git clone, installation and rendering in a browser are outside these timings.

| Repository | Files read by init | Blocks | First init | Second init | Export map to HTML |
|---|---:|---:|---:|---:|---:|
| h3 | 113 | 7 | 867 ms (773–1,089) | 469 ms (443–695) | 915 ms (662–1,082) |
| ohash | 8 | 3 | 1,166 ms (1,072–1,443) | 350 ms (307–412) | 326 ms (312–682) |
| ofetch | 15 | 1 | 356 ms (342–359) | 347 ms (320–544) | 324 ms (308–571) |

## Cross-file TypeScript references

The reference set comes from the TypeScript language service. For each directly exported top-level named declaration in `src/`, compare the distinct file and line pairs in other production source files. Exclude comments, imports, re-exports and same-file uses. A reference is attributed to the defining file, so Cantus hits indexed under a barrel instead count as misses on the definition. This is the reference quality of the default callers index, separate from the gate below.

| Repository | TypeScript source files | Exported symbols | Matched | Extra | Missed | Precision | Recall |
|---|---:|---:|---:|---:|---:|---:|---:|
| h3 | 90 | 429 | 1,060 | 0 | 19 | 100% | 98.2% |
| ohash | 8 | 8 | 3 | 0 | 0 | 100% | 100% |
| ofetch | 7 | 32 | 42 | 0 | 1 | 100% | 97.7% |

In h3, 10 of the 19 misses are in a file skipped by Cantus's default third-party filter. Nine are usages attributed to re-exporting files. The miss in ofetch is a call through a star barrel. These repositories share an ecosystem and h3 accounts for most observations. The language service only sees the checked-out source and its configuration, and this comparison covers no external packages, local-only exports or tests.

## Breaking-change check on real repositories

On each repository, rename one function and update its same-file references. Run `cantus diff HEAD --fail-on breaking` on the baseline, the breaking rename, and the rename with a compatibility alias.

| Repository and function | Baseline | Rename | With alias | Evidence |
|---|---:|---:|---:|---|
| h3 · `sanitizeStatusCode` | 0 | 1 | 0 | Three callers and an unresolved named re-export |
| ohash · `serialize` | 0 | 1 | 0 | Three callers and an unresolved named re-export |
| ofetch · `createFetch` | 0 | 1 | 0 | Unresolved named import from a star barrel |

The public baseline `e678a56` returned 0 on the ofetch rename. The candidate returned 1 and pointed to `src/index.ts:1`. The new gate follows named imports through star barrels independently of the callers index. These are three controlled cases and require the project compiler and tests for wider coverage.

## Reproduce

Build Cantus with `pnpm install --frozen-lockfile`. Clone each benchmark repository and check it out at the revision in [results.json](results.json).

```sh
ROOT=/path/to/h3
node dist/cli.js analyze -C "$ROOT" --json > analysis.json
node benchmark/l1/ts-refs.mjs "$ROOT" src refs.json files.json
ONLY_FILES=files.json node benchmark/l1/compare.mjs analysis.json refs.json
node benchmark/publication/smoke.mjs "$ROOT" src/utils/sanitize.ts sanitizeStatusCode
```

Use `src/serialize.ts serialize` for ohash and `src/fetch.ts createFetch` for ofetch. These scripts run locally against source. The [agent workflow benchmark](../agent-workflows/README.md) measures a different question and has no scored token or quality comparison yet.
