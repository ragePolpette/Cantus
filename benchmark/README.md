# Cantus benchmarks

| Suite | Measures | Reproduce |
|---|---|---|
| [Publication benchmark](publication/README.md) | TypeScript cross-file references, first-use wall time and breaking-change checks on three pinned repositories | [Method and commands](publication/README.md#reproduce), [raw results](publication/results.json), [smoke runner](publication/smoke.mjs) |
| [Language-server comparisons](#historical-cross-file-reference-results) | Earlier cross-file reference measurements on Python, Go, Rust and C# repositories | [Commands](#run-it), [reference scripts](l1/) |
| [Agent workflow pilot](agent-workflows/README.md) | A/B protocol for agent impact questions, with exact answer scoring and token usage when available | [Runner](agent-workflows/codex-impact.mjs) |

## Historical cross-file reference results

The numbers below were recorded on earlier Cantus revisions. The publication benchmark above records the current candidate and its tested source tree.

What this measures: for the exported symbols of a real project, the uses of each symbol in **other files**, as Cantus finds them (`callers`, the call sites of `cantus analyze --json`), against what a **language server** reports for the same symbol (`textDocument/references`). The server is the reference, not an oracle: where it does not see a file (code built for another system, tests) the file is left out on both sides, and the scripts say how.

### Results from 3 November 2026

| Project | Language | Reference | Symbols (with uses) | Precision | Recall (call sites) | Recall before the 03/11 fixes |
|---|---|---|---|---|---|---|
| httpx | Python | pyright 1.1.414 | 130 (67) | 100% | 97.4% | 97.4% |
| fzf | Go | gopls 0.20.0 | 301 (282) | 100% ¹ | 95.2% | 44.2% |
| just | Rust | rust-analyzer 1.97.0 | 180 (167) | 98.8% | 96.7% | 0.6% |
| FluentValidation | C# | csharp-ls 0.28 | 293 | 93.6% | 95.4% | 79.6% ² |

Cantus `d7d8418` (main after #245). Projects: httpx `b5addb6`, fzf `99bfd5a`, just `7b7b51b`. Symbols are the exported ones, picked evenly up to 300; uses are lines, in non-test files other than the one that defines the symbol.

¹ On the files gopls compiles for Linux (`go list`). Counting also the files built only for other systems (`*_windows.go`, `//go:build tcell`) the precision reads 86%: those uses are real, the server just does not read those files.

² Measured on 03/11 evening by another thread on the owner's PC, Cantus `ffd344f` (main after #266, which resolves a `using` written inside a namespace from that namespace outwards: 75% of the uses missed before). Same 293 symbols and same server answers before and after; test files are left out on both sides (#267). Files: precision 93.2%, recall 98.6% (was 76.4%). In the first run most of the false positives were `IValidator` and `IValidator<T>` taken as one name (harmless for `callers`); `new()` without a type name (110 uses) cannot be linked without types.

What the numbers do **not** say:
- **One project per language.** No confidence interval. httpx exports 130 symbols, fewer than the 200 a proper sample needs.
- **Only four languages.** These historical server runs did not cover Java or JavaScript/TypeScript.
- **The recall left is mostly methods and qualified paths.** Python: annotations; Go: `pkg.Name` where several files declare the name for different systems; Rust: `Self::Variant`, `module::function`, `use Enum::*`. A method called on a value is not linked in any of them (no type inference).
- The same-package rule (Go) and the glob rule (Rust) were added on 03/11 after this benchmark found the two largest holes; the "before" column is the benchmark run on the code of 02/11.

### Run it

You need a compiled Cantus (`pnpm build`), the project to measure (clean checkout, no `.cantus`) and its language server on the PATH. Nothing from the project is built or run by these scripts; the servers may read the project's manifest (`cargo metadata`, `go list`), so use a checkout you do not mind them touching.

```bash
ROOT=/path/to/project
node dist/cli.js analyze -C $ROOT --json > analysis.json
node benchmark/l1/extract-symbols.mjs $ROOT analysis.json symbols.json 300
# the reference: pyright-langserver python | gopls go | rust-analyzer rust
node benchmark/l1/lsp-refs.mjs gopls go $ROOT symbols.json refs.json      # LSP_WARMUP_MS=30000 for rust-analyzer
node benchmark/l1/compare.mjs analysis.json refs.json
```

Per language:
- **Python:** `python3 -I benchmark/l1/py-import-lines.py $ROOT ign.json`, then `compare.mjs analysis.json refs.json ign.json` (the import lines are not uses).
- **Rust:** `node benchmark/l1/rs-use-lines.mjs $ROOT ign.json`, the same third argument.
- **Go:** write the files built for this system, `cd $ROOT && go list -f '{{.Dir}}|{{join .GoFiles ","}},{{join .CgoFiles ","}}' ./...`, as a JSON list of paths relative to the root, and run `ONLY_FILES=files.json node benchmark/l1/compare.mjs analysis.json refs.json`.

Wait for the server to finish indexing before trusting a run: it answers with fewer references, with no error, until it has (in one run, intelephense on a large PHP project returned 44% more references after another 90 seconds). `lsp-refs.mjs` waits `LSP_WARMUP_MS` (default 15 s) and retries cancelled requests; for a big project raise it and compare two runs.
