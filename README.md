# Cantus

Cantus maps a repository into blocks, then shows who depends on an API before you or a coding agent change it. Use the local map to explore the code, give an agent a block briefing over MCP, or run a Git diff check for broken references.

On h3, Cantus matched 1,060 of 1,079 cross-file TypeScript references in the benchmark sample. See the [results](#benchmarks) and [reproduction instructions](benchmark/).

![Cantus live map of a demo shop: TypeScript front end, admin page with classic scripts, C# backend](docs/view.png)

## What it does

- **Blocks and arrows.** The analysis reads your code and proposes blocks (modules) and the dependencies between them. You can name, describe and group them in `.cantus/model.json`.
- **Callers and breaking changes.** For recognized exports it indexes references from other blocks. After an edit it warns when an export other blocks use was removed or changed, with the call sites to update. `cantus impact` shows what a change in a block can reach, directly and through others.
- **Front end to backend.** It links statically recognizable `fetch` and Ajax calls to endpoints in ASP.NET, Minimal API, Flask, FastAPI and Django.
- **A briefing per block.** What the block exports, what it uses from the others, who calls it, its tests and its team documents, with a default budget of about 14k estimated tokens. Cantus can also generate per-block `AGENTS.md` notes.
- **For coding agents.** An MCP server, a Claude Code plugin with hooks and per-block specialists, and Git worktree workflows for reviewing agent changes.

## Languages

| Read in depth | Imports, call sites, public API |
|---|---|
| JavaScript / TypeScript (ES modules, CommonJS, classic scripts loaded by pages), Vue single-file components | yes, with contracts |
| Python, C#, Rust, Go, Java, PHP (through tree-sitter) | yes, without type inference |

Files in other languages (Kotlin, Ruby, Swift, C and C++…) belong to their blocks with their size, but are not read. Details per language are in the [reference](docs/REFERENCE.md).

## Try it

Requires Git, Node 20.19+ (20.x) or Node 22.12+, and pnpm.

```bash
git clone https://github.com/ragePolpette/Cantus.git
cd Cantus
pnpm install --frozen-lockfile
node dist/cli.js impact src-pricing -C tests/fixtures/shop
node dist/cli.js serve -C tests/fixtures/shop
```

The first command after installation shows where a pricing change can reach. Open the printed local URL to explore the shop map. For your own repository, run `node /path/to/Cantus/dist/cli.js init -C /path/to/project`. To use the shorter `cantus` command, run `npm link` in the Cantus checkout. The GitHub checkout is the current distribution channel.

For Claude Code, install the plugin after putting `cantus` on your PATH.

```bash
claude plugin marketplace add ragePolpette/Cantus
claude plugin install cantus@cantus
```

Run `cantus index` in the project to build or refresh the index used by Claude Code hooks. The MCP server analyzes on request. Codex can connect to the [read-only MCP profile](docs/INIT.md).

## Start

```bash
cd your-project
cantus init               # check, save the map (.cantus/model.json), offer notes and specialists, open the live map
```

`init` is safe to run again, asks before writing files in your project, and does not touch your code, your `.gitignore` or git. The same by hand:

```bash
cantus analyze --write    # infer the blocks and save the map (.cantus/model.json)
cantus serve              # live map in the browser (http://127.0.0.1:4321)
cantus context src-orders # the briefing for working on one block
```

Then, as you need them:

```bash
cantus notes              # per-block notes for coding agents
cantus agents             # one Claude Code specialist subagent per block
cantus impact src-orders  # what a change there can reach
cantus diff               # what your branch changes in the map, for a pull request
cantus view --svg         # the map as a still picture (SVG), for a README or a post
cantus mermaid --markdown # the block graph as a Mermaid flowchart
cantus check              # findings and analysis problems; exits 1 on errors
```

## More

- **New project mode.** In the live map, "Edit the map" sketches layers, blocks and arrows before there is code ("Describe the project" asks Claude Code for a draft), and "Build the plan" prepares a new worktree whose Claude Code session (its lead) builds the planned blocks in waves, providers first, each through its block's specialist. Over MCP: `sketch_map`.
- **Work from the map, to the lead of a worktree.** Select blocks, write what should be done, and say where it goes: to the Claude Code session open in this worktree (its *lead*, which gives it to the block's specialist), to the one open in another worktree of the repository, or to a new worktree, which Cantus makes and for which it gives the lines that open a session. The map shows each worktree as working, waiting for you, to review or merged; it does not start agents or follow conversations, and a worktree Cantus made is reviewed and merged or discarded there. Unattended runs, with a gate and a separate verifier, are for the command line: `cantus task`, `cantus plan run`, `cantus verify`.
- **MCP.** `cantus mcp` serves the tools (`map`, `block_context`, `symbol_context`, `find_api`, `callers`, `impact`, `diff`, `review_changes`, …). Your own MCP servers (database, CI…) reach unattended tasks by default; `"agent": { "mcp": { "deny": ["jenkins"] } }` in the map refuses the ones you name, and `agent.mcp.specialists` / `agent.mcp.blocks.<id>` take servers away from the block specialists. See the reference.
- **`cantus refine` (experimental).** Claude Code can suggest descriptions, notes and layer assignments for blocks. Review the proposed changes against your project.

## Benchmarks

The 19 November 2026 run used Linux x64, Node 24.22.3 and TypeScript language service 6.0.3. It compared distinct cross-file references to named exports in production TypeScript files. The first `init --no-serve` timings are medians from five fresh checkouts per repository and include CLI startup. They exclude clone, installation and browser rendering.

| Repository | TypeScript references matched | Recall | Files read by init | First init |
|---|---:|---:|---:|---:|
| h3 | 1,060 / 1,079 | 98.2% | 113 | 867 ms |
| ohash | 3 / 3 | 100% | 8 | 1,166 ms |
| ofetch | 42 / 43 | 97.7% | 15 | 356 ms |

Cantus reported zero extra references within these samples. h3 accounted for most observations, and all three projects are from the same ecosystem. The ofetch miss is a reference through an `export *` file.

In a distinct breaking-change check, `cantus diff HEAD --fail-on breaking` blocked one incompatible function rename on each repository. All three passed after adding a compatibility alias. The ofetch case exercises a named import through `export *`. Run the project compiler and tests alongside this check.

- [Benchmark directory](benchmark/) for the suite index and scripts.
- [Method and reproduction commands](benchmark/publication/README.md) and [raw data](benchmark/publication/results.json) for the results above.
- [Earlier language-server comparisons](benchmark/README.md#historical-cross-file-reference-results) for Python, Go, Rust and C#.
- [Agent workflow pilot](benchmark/agent-workflows/README.md) for the Codex A/B harness. All 12 attempts stopped during sandbox startup, so there are no scored token, speed or quality results.

## Verification and limits

- The Linux release check passed 818 tests, including browser tests, on Node 24.22.3. Focused runs passed 35 tests each on Node 20.20.2 and 22.23.5. A clean tarball installation verified that the CLI can analyze samples in nine languages. Native Windows verification is pending. [Release checks](docs/RELEASE.md)
- Static analysis can miss dynamic URLs, namespace accesses, type-inferred references and some re-export paths. [Language coverage](docs/REFERENCE.md)
- Existing ArchFlow maps migrate from `.archflow/` to `.cantus/` on first use.

## Documentation

- [Guide](docs/GUIDA.md): how to use Cantus (in Italian).
- [Reference](docs/REFERENCE.md): everything Cantus reads, per language, the map file, the MCP tools, the live map, unattended runs, diagnostics.
- [Plugin](plugin/README.md): hooks, skill, specialists, requests from the live map to an open session.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for local checks and contribution guidelines.

Before publishing, run `npm run verify:release`: types, tests, package integrity and a clean install of the tarball. See [the release checks](docs/RELEASE.md) for the browser and platform checks that need to be recorded separately.

```bash
pnpm install
pnpm test       # builds, then runs node --test
```

Cantus builds with TypeScript 7 and maps itself: see `.cantus/model.json` and the `AGENTS.md` files in `src/`.

## Advanced usage

### Local inputs for verification

Declare project-relative files used by checks in `agent.gateInputs` in `.cantus/model.json`, for example `["test/local-settings.json"]`. Cantus includes their contents in candidate and integration proofs even when Git ignores them. For worktree tasks, make the files available through the worktree's copy or setup rules. List the specific input files that the check reads. Generated output and other ignored files stay outside this list.

### PHP and Roslyn

Analysis includes PHP declarations, namespace imports and statically named references. The root Composer PSR-4 mappings help distinguish duplicate class declarations. Dynamic includes, dynamic calls and runtime autoloader behavior are outside this static analysis.

For a semantic C# lookup, set `CANTUS_ROSLYN_PATH` locally to the absolute path of the `roslyn-language-server` executable. Then run, for example:

```text
cantus csharp references src/Orders.cs 12 16 --solution App.sln --trust
```

Use `definition`, `implementation` or `references` with a 1-based line and UTF-16 column. The command accepts a solution or project in the workspace and outputs JSON. Omitting `--solution` uses the server's project discovery. Run this command only on trusted projects, since Roslyn can execute project code. The semantic lookup is separate from the static analysis and runs on demand.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for the bundled grammars.
