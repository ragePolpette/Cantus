import { snapshotPage, type SnapshotKind } from "./state/envelope.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { analyze, type Analysis } from "./analysis/analyze.js";
import { formatDiagnostic, writeAnalysisLog } from "./analysis/diagnostics.js";
import { check, type Finding } from "./analysis/rules.js";
import { explainDiagnostics, renderProblems } from "./analysis/explain.js";
import { type FindingLine, renderFindings } from "./analysis/findings.js";
import { describeImpact } from "./analysis/reach.js";
import { deltaFailures, renderDelta } from "./analysis/delta.js";
import { compareProject } from "./state/compare.js";
import { BRIEFING_TOKENS, buildScopePack, formatTokens, renderContextPrompt, resolveScope } from "./context/index.js";
import { NOTES_START, describeNotes, writeNotes } from "./map/notes.js";
import { type RefineResult, applyRefinement, blocksToRefine, describeRefinement, refineBatches } from "./map/refine.js";
import { addSuggestions, dismissSuggestions, readSuggestions } from "./analysis/suggestions.js";
import { requestRefinement } from "./run/refine.js";
import { addDoc, describeDocs } from "./map/docs.js";
import { describeMapUpdate, updateMap } from "./map/update.js";
import { runStdioServer } from "./mcp/server.js";
import { ProjectState } from "./state/state.js";
import { type MapServer, startMapServer } from "./serve/server.js";
import { readUsage, renderStats, summarizeUsage } from "./state/usage.js";
import { type HookEvent, type HookInput, handleHook, reportAgent, reportEdit, reportPermission, reportRead, takeRequests } from "./hooks/handlers.js";
import { readProjectIndex, writeProjectIndex } from "./state/project-index.js";
import { readRegistry } from "./run/worktree-registry.js";
import { renderOverview, worktreeOverview } from "./run/worktrees.js";
import { worktreeVerifyContext } from "./run/worktree-report.js";
import { readChanges } from "./state/changes.js";
import { mergeBase, resolveRef } from "./state/refs.js";
import { describeSelection, selectTests } from "./analysis/affected-tests.js";
import { type ArchModel, MODEL_DIR, deleteGroup, loadModel, migrateLegacyDir, modelPath, saveGroup, saveModel, unassignDoc } from "./model/index.js";
import { ensureAgentsFolder, exportClaudeAgents, refreshClaudeAgents } from "./outputs/claude-agents.js";
import { renderPoster } from "./outputs/poster.js";
import { buildViewData, renderViewHtml } from "./outputs/view.js";
import { renderMermaid } from "./outputs/mermaid.js";
import { claudeCodeRunner } from "./run/sdk-runner.js";
import { builtInRunner } from "./run/runners.js";
import { withCheckout } from "./run/verify-head.js";
import { needsAction, planVerification, prepareVerification, renderReviewText, worthSending } from "./run/verify.js";
import { readServeInfo } from "./state/serve-info.js";
import { PlanRunner, PlanStore, orderPlan, readPlan, renderPlanText } from "./run/plans.js";
import { RUNS_DIR, TaskManager, autonomousPolicy, resolveCheck, type Runner, type TaskEvent, type TaskRecord } from "./run/tasks.js";
import { pathToFileURL } from "node:url";
import { NEEDS_GIT, PLUGIN_COMMANDS, codexBlock, gitInfo, hasCommand, hasExportedAgents, hasGeneratedNotes, languageSummary, mcpRegistered, openBrowser, pluginInstalled, registerClaudeMcp } from "./init.js";
import { rerootModel } from "./map/reroot.js";
import { exitAfterFlush } from "./exit.js";

const HELP = `cantus — a map of your codebase for developers and coding agents

Usage: cantus <command> [options]

Commands:
  init                 Set up Cantus in this project and open the live map: checks (node, git, readable
                       files), saves or updates the map, summarizes the findings, offers per-block notes and
                       Claude Code specialists (asks first: they are files in your project), says how to give
                       a coding agent access (plugin; --mcp registers the MCP server for you only), then
                       serves the map and opens the browser. Safe to run again. It does not install or update
                       Cantus and does not edit your .gitignore, your code or git
      --yes            Accept the notes and specialists without asking
      --mcp            Register the MCP server in Claude Code (this project, this user: not .mcp.json)
      --no-serve       Stop after the setup, do not start the map
      --no-open        Start the map but do not open the browser
      --dry-run        Say what would happen and write nothing
  analyze              Analyze the code and show blocks and dependencies
      --write          Save or update the map (.cantus/model.json) from the code;
                       names, descriptions, layers and rules you wrote are kept
  csharp <definition|implementation|references> <file> <line> <column> --trust
                       Query the local Roslyn language server (CANTUS_ROSLYN_PATH)
      --solution <file>  Choose a .sln, .slnx or .csproj inside the project
  check                Compare the code with the map; exits 1 on errors
      --strict         Treat the map as a contract: unmapped dependencies and layer
                       violations are errors (also "strict": true in the map)
      --full           One line per finding: by default many alike (identical functions,
                       contracts that need types) are one line per group
  view                 Write an interactive map to .cantus/view.html
      --out <file>     Output path
      --svg            Write a still picture instead, .cantus/map.svg: the lanes, blocks
                       as wide as their code, arrows, findings, hotspots and the blocks
                       the working tree touches. For a README, a post or a pull request
      --width <px>     Width of the picture (default 1200)
      --base <ref>     Mark what changed since the point where this branch left <ref>
                       (e.g. main) instead of since the last commit: for a pull request
  diff [base] [head]   What a branch changes in the map, for a pull request: blocks, arrows
                       between them, new problems, exports changed or removed that other
                       blocks still use, endpoints. base defaults to main (the point where
                       this branch left it), head to the working tree; the repository is
                       never switched. --json for machine-readable output
      --fail-on <level>  Exit 1 when the change does not pass, to use as a check (agent.checks) or in CI.
                       breaking: an export removed is still used in files the change did not touch, or a
                       new error. strict: also a changed or moved export with such uses, and any new problem
  mermaid              Print the block graph as a Mermaid flowchart, to paste in a pull
                       request, a README or a wiki
      --markdown       Wrap it in a Markdown code fence
  context <block>      Print the briefing for working on a block; <block> can also be
                       a comma-separated list (one scope for several blocks)
      --group <id>     Brief a saved group instead
      --full           Print it whole: by default a large block's briefing is shortened
                       to about 14k tokens, like the block_context tool, and the other
                       exports of the blocks it uses are counted, not listed
  impact <block|file>  What a change in a block can touch: the blocks that use it, directly
                       and through others, and the blocks it depends on
      --full           List every block reached with its chain: by default the ones
                       reached only through others are counted by the block they pass through
  tests [base]         The test files a change can affect, one per line, for a test runner:
                       the files changed (uncommitted, or since the point where this branch left
                       <base>), the files that import them and the tests that import any of those.
                       It runs every test when it cannot tell (a deleted file, a configuration, a
                       language whose tests it cannot follow) and says why on stderr. An empty list
                       means nothing needs to run: check it before passing it to a runner
      --json           The selection with its reasons, machine-readable
  groups               List the saved groups
  group save <id> <block>...
                       Save a group of blocks as a working scope
      --name <name>    Display name (default: the id)
      --description <text>
  group delete <id>    Remove a saved group
  docs                 List the team's documents in the map and where they go
  doc add <path>       Give agents a Markdown document on top of the code's context:
      --block <id,...> for these blocks' briefings
      --group <id,...> for these groups' briefings
      --common         for every briefing (conventions, glossary, product rules)
      --description <text>
  doc new [path]       Create a document from a template and assign it (same options;
                       default path docs/blocks/<id>.md, docs/groups/<id>.md, docs/common.md)
  doc remove <path>    Take it from --block/--group, or clear --common; with none of
                       them it leaves the map (the file is kept)
  reroot --from <folder>
                       Move the map of a subfolder up to this root (-C): the map in <folder>/.cantus is
                       read, every path in it gets <folder>/ in front (blocks, notes' files, documents,
                       analysis.include/exclude, outside folders), ids and everything else stay. Shows what
                       it would write; --write saves .cantus/model.json here (never over an existing one;
                       the old map is left where it is)
  notes                Update the generated section of each block's AGENTS.md
                       (or CLAUDE.md) and the root pointer
  refine [<block>,...] Improve the map with Claude Code, reading only: a description per
                       block, a layer for unassigned ones, a few notes on working in each
                       (with the files they rest on), and suggestions it does not apply.
                       Blocks, arrows and callers stay the analysis's; what you wrote stays.
                       Only blocks new or changed since the last refine, unless named
      --all            Refine every block
      --model, --runner as for task; --budget <usd> per session (8 blocks each, siblings together)
      --language <name> Write names, descriptions and notes in it (default: that of the map's descriptions or the project's comments)
  suggestions          List what refine suggested and nobody has closed yet (they are also
                       findings of check); "suggestions dismiss <id>...|all" closes them
  serve                Serve the live map on http://127.0.0.1:4321 (next free port);
                       select blocks, save groups, updates as the code changes
      --port <n>       First port to try (0: any free port)
  mcp                  Run the MCP server on stdio, for Claude Code, Codex and others;
                       also serves the live map (see the open_map tool)
      --no-ui          Do not serve the live map
      --read-only      Expose only analysis tools and skip the live map
      --channels       Enable Claude Code channel notifications
  snapshot             Paginated analysis JSON (--kind, --offset, --limit)
  agents               Write one Claude Code subagent per block to .claude/agents/
  hook <event>         Claude Code hook handler (session-start, pre-edit, post-edit, user-prompt, tool-use, stop, permission, subagent-start, subagent-stop):
                       reads the hook input on stdin, prints context for the agent
  stats                What Cantus did for your agents, from .cantus/cache/usage.jsonl: briefings
                       (size, shortened), tools, searches that found nothing, edits and files read
                       outside a block, map tasks (cost by model), and where a note in a block's
                       context file would help. CANTUS_STATS=off records nothing
      --days <n>       Only the last n days
      --json           Machine-readable
  worktrees            The worktrees of this repository: branch, commits ahead of the main branch, the blocks each
                       changes (committed or not), the map each one serves, and the blocks changed in more than one;
                       the ones Cantus made are marked with their task
      --json           Machine-readable
      --clean          Remove the worktrees Cantus made that are merged with nothing uncommitted, and the entries
                       whose folder is gone; nothing else
  index                Refresh the compact index hooks read (.cantus/cache/index.json)
  plan <add|list|show|run|accept>
                       Work on several blocks as a written plan: one task per block, the order taken from the
                       map (providers first), each task in its own worktree, merged before the next one starts,
                       the task's check run again on the merged result. It stops at the first task that is not
                       done and says why
      plan add <file|->    Read a plan (JSON: goal, tasks with id, blocks, prompt, check, dependsOn, model, budgetUsd,
                           retries, verify, verifyModel; budgetUsd, verify and
                           verifyModel for the whole plan), check it against the map and store it. Not approved yet
      plan list            The plans and where each one stands
      plan show <id>       The tasks in order, what each waits for, and its state (--json for the files)
      plan run <id>        Approve this revision of the plan (--yes, or asked) and run it; run it again to pick up after a stop or a restart
      plan accept <id> <task>  A person accepts the findings (blocker/major) of a task's review so the plan can go on
      --yes                With run: approve without asking
      --run-setup          With run: agree to the commands of the map's worktree rules
      --runner, --shell    As for task
  verify               A separate Claude Code session reviews the work, read-only, and ends with
                       findings (severity, file:line, evidence). Cantus first runs the tests and
                       computes what needs no model (API changes and their callers, the map's
                       comparison with the base); the reviewer gets those, the request, the diff and
                       the briefing of the blocks touched, but not the author's reasoning. Progress on
                       stderr, the report on stdout; exits 1 if it found a blocker or major problem,
                       or could not finish. Compares with the last commit when there is uncommitted
                       work, else with where this branch left main
      --base <ref>     Compare with a commit, branch or tag instead
      --about "<text>" What the work was meant to do (the author's request); without it the reviewer
                       judges the changes on their own
      --tests <cmd>    Run this to test first (default: agent.verifyCommand in the map); --no-tests skips
      --dry-run        Print what the reviewer would be given, without running anything
      --request <id>   Verify the work of a request from the live map (compares with where the project
                       stood when the session took it; its text is the intent)
      --head <ref>     Verify a branch, tag or commit that is not checked out here, in a temporary checkout
                       (no installed dependencies: tests are skipped unless --tests is given; findings
                       are not sent to the session). To verify a worktree that exists, run it there: -C <folder>
      --no-deliver     Do not send the findings to the open session (the report is still printed)
      --local          Run here even if a live map is running (a map running for the open session
                       otherwise runs the review, shows it, and sends its findings to the session)
      --model <id>, --max-turns <n>, --budget <usd>, --runner <name>
                       As for task (default budget $1.50; model: agent.models.verify in the map)
  task <block>[,<block>...] "<prompt>"
                       Run Claude Code on a scope without supervision (Agent SDK);
                       progress on stderr, the agent's report on stdout, the full
                       record in .cantus/runs/<id>.json; exits 1 if it fails
      --group <id>     Use a saved group as the scope (then only "<prompt>")
      --all            The whole project (then only "<prompt>"): Claude Code plans and
                       delegates the pieces to the block specialists
      --build          Build the map's plan (blocks without code, arrows not in the
                       code), providers first; the prompt is optional notes
      --plan           Let the agent plan first (the plan is logged and approved)
      --worktree       Work on a new branch in its own git worktree (rules: agent.worktree in the map)
      --run-setup      With --worktree: agree to run the map's worktree setup commands (asked when there is a terminal)
      --merge          With --worktree: merge the branch when the task succeeds
      --allow-outside  Allow edits outside the scope (default: refused, reported)
      --shell <mode>   none | verify (default: only the verify command) | all
      --verify <cmd>   The verify command (default: agent.verifyCommand in the map): the agent may run it, and when
                       the agent is done Cantus runs it too, in the same folder; a non-zero exit blocks the task
      --check <name>   Use a named check of the map (agent.checks) instead of agent.verifyCommand
      --no-gate        Do not run the verify command after the agent is done (the agent may still run it)
      --retries <n>    When that check fails, start the agent again with its output, up to n more times (0-5; default:
                       agent.retries in the map, else 2); stops early if the same failure comes back or the budget is spent
      --trust          Allow every tool, not only reading, editing and Cantus's
      --model <id>     Claude model (default: the map's agent settings, else Claude Code's)
      --max-turns <n>, --budget <usd>
                       Stop after n turns, or when the estimated cost passes usd
      --runner <name>  Agent runner: sdk (Claude default), claude-cli, codex
                       ("claude -p", the command line's own login), or a module file
                       whose default export runs the agent; also for serve and mcp,
                       or "runner" under "agent" in the map

Options:
  -C, --dir <path>     Project directory (default: current directory)
      --json           Machine-readable output for analyze/check
  -v, --verbose        Print every analysis diagnostic, not only errors
  -h, --help           Show this help

Every command that reads the project writes all diagnostics (parse errors, unresolved
imports, compiler output, skipped files) to .cantus/analysis.log.`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: "string", short: "C" },
      write: { type: "boolean" },
      from: { type: "string" },
      json: { type: "boolean" },
      clean: { type: "boolean" },
      days: { type: "string" },
      out: { type: "string" },
      svg: { type: "boolean" },
      width: { type: "string" },
      markdown: { type: "boolean" },
      group: { type: "string" },
      port: { type: "string" },
      "no-ui": { type: "boolean" },
      "no-serve": { type: "boolean" },
      "no-open": { type: "boolean" },
      mcp: { type: "boolean" },
      "read-only": { type: "boolean" },
      channels: { type: "boolean" },
      kind: { type: "string" },
      offset: { type: "string" },
      limit: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      strict: { type: "boolean" },
      block: { type: "string" },
      common: { type: "boolean" },
      plan: { type: "boolean" },
      all: { type: "boolean" },
      build: { type: "boolean" },
      full: { type: "boolean" },
      worktree: { type: "boolean" },
      "run-setup": { type: "boolean" },
      merge: { type: "boolean" },
      "allow-outside": { type: "boolean" },
      shell: { type: "string" },
      verify: { type: "string" },
      "no-gate": { type: "boolean" },
      yes: { type: "boolean" },
      retries: { type: "string" },
      check: { type: "string" },
      base: { type: "string" },
      request: { type: "string" },
      head: { type: "string" },
      local: { type: "boolean" },
      "no-deliver": { type: "boolean" },
      about: { type: "string" },
      tests: { type: "string" },
      "no-tests": { type: "boolean" },
      "dry-run": { type: "boolean" },
      "fail-on": { type: "string" },
      trust: { type: "boolean" },
      solution: { type: "string" },
      model: { type: "string" },
      "max-turns": { type: "string" },
      budget: { type: "string" },
      language: { type: "string" },
      runner: { type: "string" },
      help: { type: "boolean", short: "h" },
      verbose: { type: "boolean", short: "v" },
    },
  });
  const [command, ...args] = positionals;
  if (!command || values.help) {
    console.log(HELP);
    return command || values.help ? 0 : 1;
  }
  // Claude Code sets CLAUDE_PROJECT_DIR for hooks and stdio MCP servers.
  const fromClaude = ["mcp", "hook", "index"].includes(command) ? process.env.CLAUDE_PROJECT_DIR : undefined;
  const root = path.resolve(values.dir ?? fromClaude ?? process.cwd());
  projectRoot = root;
  verbose = !!values.verbose;
  // On stderr: stdout carries the MCP protocol and the hooks' output.
  const migrated = migrateLegacyDir(root);
  if (migrated.length) console.error(`Cantus (formerly ArchFlow): moved ${migrated.join(", ")}. Commit the move with your code.`);

  switch (command) {
    case "init":
      return cmdInit(root, { yes: !!values.yes, dryRun: !!values["dry-run"], noServe: !!values["no-serve"], noOpen: !!values["no-open"], mcp: !!values.mcp, port: parsePort(values.port), runner: values.runner });
    case "analyze":
      return cmdAnalyze(root, { write: !!values.write, json: !!values.json });
    case "csharp": {
      const [query, file, line, column] = args;
      if (args.length !== 4 || (query !== "definition" && query !== "implementation" && query !== "references")) {
        throw new UsageError("Usage: cantus csharp <definition|implementation|references> <file> <line> <column> --trust");
      }
      if (!values.trust) throw new UsageError("Roslyn can execute project code. Run with --trust only for a project you trust.");
      const executable = process.env.CANTUS_ROSLYN_PATH;
      if (!executable) throw new UsageError("Set CANTUS_ROSLYN_PATH to the absolute path of roslyn-language-server.");
      const { queryRoslyn } = await import("./analysis/roslyn.js");
      console.log(JSON.stringify(await queryRoslyn(root, executable, values.solution, file, Number(line), Number(column), query), null, 2));
      return 0;
    }
    case "check":
      return cmdCheck(root, !!values.json, !!values.strict, !!values.full);
    case "view":
      return cmdView(root, values.out, !!values.svg, values.width, values.base);
    case "diff":
      return cmdDiff(root, args[0], args[1], !!values.json, values["fail-on"]);
    case "tests":
      return cmdTests(root, args[0], !!values.json);
    case "mermaid":
      return cmdMermaid(root, !!values.markdown);
    case "context":
      return cmdContext(root, values.group ? { group: values.group } : { blocks: requireArg(args[0], "context <block>[,<block>...] | --group <id>").split(",").map((id) => id.trim()).filter(Boolean) }, !!values.full);
    case "impact":
      return cmdImpact(root, requireArg(args[0], "impact <block|file>"), !!values.full);
    case "groups":
      return cmdGroups(root);
    case "group":
      return cmdGroup(root, args, { name: values.name, description: values.description });
    case "reroot":
      return cmdReroot(root, requireArg(values.from, "reroot --from <folder>"), !!values.write);
    case "notes":
      return cmdNotes(root);
    case "refine":
      return cmdRefine(root, args[0], values);
    case "suggestions":
      return cmdSuggestions(root, args);
    case "docs":
      return cmdDocs(root);
    case "doc":
      return cmdDoc(root, args, { block: values.block, group: values.group, common: values.common, description: values.description });
    case "mcp":
      return cmdMcp(root, { ui: !values["no-ui"] && !values["read-only"], readOnly: values["read-only"], channels: values.channels, port: parsePort(values.port), runner: values.runner });
    case "snapshot":
      console.log(JSON.stringify(snapshotPage(new ProjectState(root).get(), (values.kind ?? "blocks") as SnapshotKind, Number(values.offset ?? 0), Number(values.limit ?? 25)), null, 2));
      return 0;
    case "serve":
      return cmdServe(root, parsePort(values.port), values.runner);
    case "agents":
      return cmdAgents(root);
    case "hook":
      return cmdHook(root, requireArg(args[0], "hook <session-start|pre-edit|post-edit|user-prompt|tool-use|stop|permission|subagent-start|subagent-stop>"), !!values.dir || !!process.env.CLAUDE_PROJECT_DIR);
    case "stats":
      return cmdStats(root, values.days, !!values.json);
    case "worktrees":
      return cmdWorktrees(root, !!values.json, !!values.clean);
    case "index":
      return cmdIndex(root);
    case "verify":
      return cmdVerify(root, values);
    case "task":
      return cmdTask(root, args, values);
    case "plan":
      return cmdPlan(root, args, values);
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      return 1;
  }
}

let projectRoot: string | undefined;
let verbose = false;
// Posix separators: it is also shown to the user, the same on every system.
const LOG_FILE = path.posix.join(MODEL_DIR, "analysis.log");

function load(root: string): { model?: ArchModel; analysis: Analysis; findings: Finding[] } {
  const model = loadModel(root);
  const analysis = analyze(root, { model });
  reportDiagnostics(root, analysis);
  writeProjectIndex(root, analysis, model);
  return { model, analysis, findings: check(analysis, model) };
}

/** Writes the full diagnostic log and prints errors (everything with --verbose) to stderr. */
function reportDiagnostics(root: string, analysis: Analysis) {
  const { counts } = writeAnalysisLog(root, analysis, LOG_FILE);
  if (counts.error === 0 && counts.warning === 0 && !verbose) return;
  const shown = verbose ? analysis.diagnostics : analysis.diagnostics.filter((diagnostic) => diagnostic.level === "error").slice(0, 20);
  for (const diagnostic of shown) console.error(formatDiagnostic(diagnostic));
  const hidden = analysis.diagnostics.length - shown.length;
  console.error(
    `Analysis: ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info — full log in ${LOG_FILE}` +
      (hidden > 0 && !verbose ? ` (${hidden} not shown; use --verbose)` : "") +
      "\n",
  );
}

/** Unexpected failures are logged too, so they can be reported and fixed. */
function logCrash(error: unknown) {
  if (!projectRoot) return;
  try {
    const file = path.join(projectRoot, LOG_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stack = error instanceof Error ? error.stack ?? error.message : String(error);
    fs.appendFileSync(file, `\n[crash] ${new Date().toISOString()} cantus ${process.argv.slice(2).join(" ")}\n${stack}\n`);
    console.error(`Details written to ${LOG_FILE}.`);
  } catch {
    // the original error is already being reported
  }
}

interface InitOptions {
  yes: boolean;
  dryRun: boolean;
  noServe: boolean;
  noOpen: boolean;
  mcp: boolean;
  port?: number;
  runner?: string;
}

/** One question on stderr; false without a terminal, so a script never waits on it. */
async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function cmdInit(root: string, options: InitOptions): Promise<number> {
  const say = (mark: string, text: string) => console.log(`${mark} ${text}`);
  const dry = options.dryRun;
  console.log(`Cantus init${dry ? " (dry run: nothing is written)" : ""} in ${root}\n`);

  // 0. Checks. Nothing is written before they pass.
  const git = gitInfo(root);
  if (!git.available) say("!", `git is not on the PATH: the map works, but ${NEEDS_GIT} need it.`);
  else if (!git.top) say("!", `This folder is not in a git repository: the map works, but ${NEEDS_GIT} need one.`);
  else if (path.resolve(git.top) !== path.resolve(root)) say("·", `The repository starts at ${git.top}; the map covers only ${root}.`);
  else say("✓", "git repository found.");

  let model = loadModel(root);
  const first = analyze(root, { ...(model ? { model } : {}), ...(dry ? { cache: false } : {}) });
  const read = Object.keys(first.fileTokens);
  const languages = languageSummary(read);
  if (!languages) {
    console.error(`Nothing to map: Cantus read no file in ${root}. It reads JavaScript, TypeScript, Vue, Python, C#, Rust, Go, Java and PHP; files in other languages belong to their blocks without being read. Run it in the project's folder, or give another with -C.`);
    return 1;
  }
  const analysisErrors = first.diagnostics.filter((diagnostic) => diagnostic.level === "error");
  if (analysisErrors.length) {
    console.error(`Cannot initialize: ${analysisErrors.length} analysis error(s). Fix the reading errors, then run cantus init again. The map and agent notes were not updated.`);
    if (dry) {
      for (const diagnostic of analysisErrors.slice(0, 20)) console.error(formatDiagnostic(diagnostic));
    } else reportDiagnostics(root, first);
    return 1;
  }
  say("✓", `${read.length} files read (${languages}).`);
  if (read.length > 3000) say("·", "A big project: the first analysis is long, the next ones use the cache.");

  // 1. The map.
  if (dry) {
    say("·", model ? "Would update the map (.cantus/model.json); names, descriptions and rules you wrote stay." : "Would save the map (.cantus/model.json) from the code.");
  } else {
    const { model: current, analysis } = load(root);
    if (analysis.diagnostics.some((diagnostic) => diagnostic.level === "error")) {
      console.error("Cannot initialize: the code changed and could not be read. Fix the analysis errors, then run cantus init again.");
      return 1;
    }
    const update = updateMap(root, analysis, current);
    saveModel(root, update.model);
    model = update.model;
    say("✓", `${describeMapUpdate(update)} Saved ${path.relative(root, modelPath(root))}.`);
  }
  const state = dry ? undefined : load(root);
  const analysis = state?.analysis ?? first;

  // 2. The check: a summary, never a failure (a new map has findings).
  const findings = state?.findings ?? check(first, model);
  const count = (severity: string) => findings.filter((finding) => finding.severity === severity).length;
  say(findings.length ? "·" : "✓", findings.length ? `check: ${count("error")} errors, ${count("warning")} warnings, ${count("info")} notes.` : "check: the code matches the map.");
  for (const line of renderFindings(findings, analysis).slice(0, 3)) console.log(`    [${line.kind}] ${line.message}`);
  if (findings.length) console.log("    `cantus check --full` lists them all.");

  // 3. Files in the project, outside .cantus/: ask first (they are tracked files).
  const folders = analysis.blocks.flatMap((info) => info.block.include);
  const accepted = hasGeneratedNotes(root, folders, NOTES_START);
  if (dry) {
    say("·", `Would offer notes for up to ${analysis.blocks.length} blocks${accepted ? " (already accepted here: refreshed)" : ""} and Claude Code specialists.`);
  } else {
    const notesOk = accepted || options.yes || (await askYesNo(`Write per-block notes (AGENTS.md or CLAUDE.md in the blocks' folders, up to ${analysis.blocks.length} files)?`));
    if (notesOk) {
      const result = writeNotes(analysis, model);
      say("✓", `Notes: ${describeNotes(result)}. Unchanged: ${result.unchanged.length}.`);
    } else say("·", `Notes skipped${process.stdin.isTTY ? "" : " (no terminal to ask: --yes accepts)"}. Later: cantus notes.`);
    const hasClaude = fs.existsSync(path.join(root, ".claude")) || hasCommand("claude");
    if (hasClaude) {
      const agentsOk = hasExportedAgents(root) || options.yes || (await askYesNo(`Write a Claude Code specialist per block (.claude/agents, up to ${analysis.blocks.length} files)?`));
      if (agentsOk) {
        const result = exportClaudeAgents(analysis, model);
        if (result.blocked) say("!", `Specialists not written: .claude is a link to ${result.blocked}, outside the project.`);
        else say("✓", `Specialists: ${result.written.length} written, ${result.unchanged.length} unchanged, ${result.removed.length} removed.`);
      } else say("·", "Specialists skipped. Later: cantus agents.");
    }
  }

  // 4. Agent access.
  if (hasCommand("claude")) {
    if (pluginInstalled(root)) say("✓", "Claude Code: the Cantus plugin is installed (it brings the MCP server, hooks and the skill).");
    else if (mcpRegistered(root)) say("✓", "Claude Code: the MCP server `cantus` is already registered for this project.");
    else if (options.mcp && !dry) {
      const done = registerClaudeMcp(root);
      say(done.ok ? "✓" : "!", done.ok ? "Claude Code: MCP server registered for you in this project (not in .mcp.json)." : `Claude Code: the registration failed (${done.message}).`);
    } else {
      say("·", `Claude Code: not connected yet. Best: the plugin (hooks and the skill too):\n    ${PLUGIN_COMMANDS.join("\n    ")}\n  or only the MCP server: cantus init --mcp`);
    }
  } else say("·", "Claude Code was not found on the PATH; skipped.");
  if (hasCommand("codex")) say("·", `Codex is global, so it is not edited here. To give it read-only analysis of this project, add to its config.toml:\n${codexBlock(root).replace(/^/gm, "    ")}`);

  // 5. The live map.
  if (dry || options.noServe) {
    say("·", dry ? "Would start the live map (cantus serve) and open the browser." : "Live map not started (--no-serve): cantus serve.");
    return 0;
  }
  const running = readServeInfo(root);
  if (running) {
    say("✓", `The live map is already running: ${running.url}`);
    if (!options.noOpen && process.stdout.isTTY) openBrowser(running.url);
    return 0;
  }
  console.log("");
  return cmdServe(root, options.port, options.runner, { open: !options.noOpen && !!process.stdout.isTTY });
}

function cmdAnalyze(root: string, options: { write: boolean; json: boolean }): number {
  const { model, analysis, findings } = load(root);

  if (options.write) {
    const update = updateMap(root, analysis, model);
    const file = saveModel(root, update.model);
    ensureAgentsFolder(root);
    // Only new blocks in an existing map change what the analysis sees; otherwise it is already current.
    const refreshed = !update.created && update.addedBlocks.length > 0 ? analyze(root, { model: update.model }) : { ...analysis, blocksInferred: false };
    printAnalysis(refreshed, check(refreshed, update.model));
    console.log(`\n${describeMapUpdate(update)}\nSaved ${path.relative(root, file)}. Add names, descriptions and notes there; Cantus keeps them when it updates the map.`);
    if (update.created || update.addedBlocks.length > 0) console.log("Optional: `cantus refine` asks Claude Code to place unassigned blocks and add descriptions and notes. It does not always improve the map: look at what it changed.");
    return 0;
  }

  if (options.json) {
    console.log(JSON.stringify({ analysis: { ...analysis, contracts: undefined }, findings }, null, 2));
    return 0;
  }
  printAnalysis(analysis, findings);
  if (!model) console.log("\nNo map saved yet. `cantus analyze --write` saves these blocks as the map.");
  return 0;
}

function cmdCheck(root: string, json: boolean, strict: boolean, full: boolean): number {
  const loaded = load(root);
  const { model, analysis } = loaded;
  const findings = strict ? check(analysis, model, { strict }) : loaded.findings;
  if (json) {
    console.log(JSON.stringify({ findings, diagnostics: analysis.diagnostics }, null, 2));
  } else {
    if (!model) console.log("No map saved (.cantus/model.json): only structural checks ran. Create one with `cantus analyze --write`.\n");
    printFindings(renderFindings(findings, analysis, { full }), findings.length);
  }
  const analysisErrors = analysis.diagnostics.filter((diagnostic) => diagnostic.level === "error").length;
  if (!json) {
    const problems = renderProblems(explainDiagnostics(analysis.diagnostics));
    if (problems) console.log(`\nProblems while reading the project:\n${problems}`);
    if (analysisErrors > 0) console.log(`\n${analysisErrors} analysis error(s): see ${LOG_FILE}.`);
  }
  return findings.some((finding) => finding.severity === "error") || analysisErrors > 0 ? 1 : 0;
}

function cmdView(root: string, out?: string, svg = false, width?: string, base?: string): number {
  if (width !== undefined && !svg) throw new UsageError("view --width <px> goes with --svg");
  const px = width === undefined ? undefined : Number(width);
  if (px !== undefined && (!Number.isInteger(px) || px < 640 || px > 4000)) throw new UsageError("view --svg --width <px>: a whole number from 640 to 4000");
  const { model, analysis, findings } = load(root);
  const file = path.resolve(root, out ?? path.join(MODEL_DIR, svg ? "map.svg" : "view.html"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const view = buildViewData(analysis, model, findings, readChanges(root, base ? mergeBase(root, resolveRef(root, base), "HEAD") : undefined));
  fs.writeFileSync(file, svg ? renderPoster(view, { ...(px ? { width: px } : {}) }) : renderViewHtml(view));
  console.log(`Wrote ${path.relative(process.cwd(), file) || file}. ${svg ? "It is a picture: open it in a browser or put it in a README." : "Open it in a browser."}`);
  return 0;
}

function cmdSuggestions(root: string, args: string[]): number {
  if (args[0] === "dismiss") {
    const ids = args.slice(1);
    if (ids.length === 0) throw new UsageError("suggestions dismiss <id>...|all");
    const open = readSuggestions(root).map((entry) => entry.id);
    const unknown = ids[0] === "all" ? [] : ids.filter((id) => !open.includes(id));
    if (unknown.length > 0) throw new UsageError(`No open suggestion ${unknown.join(", ")}. Open: ${open.length ? open.join(", ") : "none"}.`);
    console.log(`${dismissSuggestions(root, ids[0] === "all" ? "all" : ids)} suggestion(s) closed.`);
    return 0;
  }
  if (args.length > 0) throw new UsageError("suggestions [dismiss <id>...|all]");
  const open = readSuggestions(root);
  if (open.length === 0) console.log("No open suggestions from refine.");
  else {
    for (const entry of open) console.log(`[${entry.kind}] (${entry.id})${entry.block ? ` ${entry.block}:` : ""} ${entry.text}`);
    console.log("\nApply the ones you agree with in the map, then close them: `cantus suggestions dismiss <id>...|all`.");
  }
  return 0;
}

function cmdDiff(root: string, base: string | undefined, head: string | undefined, json: boolean, failOn?: string): number {
  if (failOn !== undefined && failOn !== "breaking" && failOn !== "strict") throw new UsageError('diff --fail-on takes "breaking" or "strict".');
  const delta = compareProject(root, { base, head });
  process.stdout.write(json ? `${JSON.stringify(delta, null, 2)}\n` : renderDelta(delta));
  if (!failOn) return 0;
  const failures = deltaFailures(delta, failOn);
  if (failures.length === 0) return 0;
  console.error(`cantus diff --fail-on ${failOn}: the change does not pass.\n${failures.map((line) => `  - ${line}`).join("\n")}`);
  return 1;
}

function cmdTests(root: string, base: string | undefined, json: boolean): number {
  const model = loadModel(root);
  const analysis = analyze(root, { model });
  const changes = readChanges(root, base ? mergeBase(root, resolveRef(root, base), "HEAD") : undefined);
  const selection = selectTests(analysis, changes.git ? changes.files : undefined);
  if (json) process.stdout.write(`${JSON.stringify(selection, null, 2)}\n`);
  else {
    if (selection.tests.length > 0) process.stdout.write(`${selection.tests.join("\n")}\n`);
    console.error(describeSelection(selection).join("\n"));
  }
  return 0;
}

function cmdMermaid(root: string, markdown: boolean): number {
  const { model, analysis, findings } = load(root);
  const graph = renderMermaid(analysis, model, findings);
  process.stdout.write(markdown ? `\`\`\`mermaid\n${graph}\`\`\`\n` : graph);
  return 0;
}

function cmdContext(root: string, request: { group?: string; blocks?: string[] }, full = false): number {
  const { model, analysis, findings } = load(root);
  const { scope, notes } = resolveScope(analysis, model, request);
  notes.forEach((note) => console.error(note));
  const pack = buildScopePack(analysis, scope, model, findings);
  const briefing = renderContextPrompt(pack, { root, ...(full ? { fullNeighbors: true, neighborFiles: true } : { maxTokens: BRIEFING_TOKENS }) });
  process.stdout.write(briefing);
  console.error(`\nThis briefing: ~${formatTokens(Math.ceil(briefing.length / 4))} tokens. The scope itself: own code ~${formatTokens(pack.ownedTokens)}, other blocks' API ~${formatTokens(pack.contractTokens)}, of ~${formatTokens(pack.repoTokens)} in the repo.`);
  return 0;
}

function cmdImpact(root: string, target: string, full: boolean): number {
  const { model, analysis } = load(root);
  const isBlock = analysis.blocks.some((info) => info.block.id === target);
  const { scope } = resolveScope(analysis, model, isBlock ? { block: target } : { file: target });
  console.log(describeImpact(analysis, scope.blocks[0], { full }));
  return 0;
}

function cmdStats(root: string, days: string | undefined, json: boolean): number {
  const count = days === undefined ? undefined : Number(days);
  if (count !== undefined && !(count > 0)) throw new UsageError("--days must be a positive number.");
  const since = count ? new Date(Date.now() - count * 86_400_000) : undefined;
  const stats = summarizeUsage(root, readUsage(root, since), loadModel(root)?.blocks ?? readProjectIndex(root)?.blocks ?? [], since);
  console.log(json ? JSON.stringify(stats, null, 2) : renderStats(stats));
  return 0;
}

async function cmdWorktrees(root: string, json: boolean, clean: boolean): Promise<number> {
  const model = loadModel(root);
  const registry = readRegistry(root);
  const overview = worktreeOverview(root, model?.blocks ?? readProjectIndex(root)?.blocks ?? [], model?.agent?.worktree?.base, registry);
  if (!overview) {
    console.error("Not a git repository with a first commit: there are no worktrees to compare.");
    return 1;
  }
  if (clean) {
    // Only what can go without losing anything: merged worktrees with nothing uncommitted, and entries whose folder is gone.
    const gone = await new TaskManager(new ProjectState(root), claudeCodeRunner).cleanupWorktrees();
    for (const branch of gone.removed) console.log(`Removed ${branch}`);
    for (const one of gone.left) console.log(`Left ${one.branch}: ${one.why}`);
    if (!gone.removed.length && !gone.left.length) console.log("Nothing to clean: no worktree Cantus made is merged or gone.");
    return gone.left.length ? 1 : 0;
  }
  console.log(json ? JSON.stringify(overview, null, 2) : renderOverview(overview));
  return 0;
}

function cmdGroups(root: string): number {
  const model = loadModel(root);
  if (!model?.groups?.length) {
    console.log("No saved groups. Save one with `cantus group save <id> <block>...`.");
    return 0;
  }
  for (const group of model.groups) console.log(`  ${group.id.padEnd(24)} ${group.blocks.join(", ")}${group.name !== group.id ? `  (${group.name})` : ""}`);
  return 0;
}

function cmdGroup(root: string, args: string[], options: { name?: string; description?: string }): number {
  const [action, id, ...blocks] = args;
  const model = loadModel(root);
  if (!model) throw new UsageError("No map saved yet: run `cantus analyze --write` first.");
  if (action === "save") {
    if (!id || blocks.length === 0) throw new UsageError("Usage: cantus group save <id> <block>... [--name <name>] [--description <text>]");
    const group = { id, name: options.name ?? id, blocks, ...(options.description ? { description: options.description } : {}) };
    saveModel(root, saveGroup(model, group));
    console.log(`Saved group ${group.name} (${id}): ${blocks.join(", ")}.`);
    return 0;
  }
  if (action === "delete") {
    if (!id) throw new UsageError("Usage: cantus group delete <id>");
    saveModel(root, deleteGroup(model, id));
    console.log(`Deleted group ${id}.`);
    return 0;
  }
  throw new UsageError("Usage: cantus group save|delete …");
}

function cmdDocs(root: string): number {
  console.log(describeDocs(root, loadModel(root)));
  return 0;
}

function cmdDoc(root: string, args: string[], options: { block?: string; group?: string; common?: boolean; description?: string }): number {
  const [action, docPath] = args;
  const model = loadModel(root);
  if (!model) throw new UsageError("No map saved yet: run `cantus analyze --write` first.");
  const list = (value?: string) => (value ? value.split(",").map((id) => id.trim()).filter(Boolean) : undefined);
  const targets = { blocks: list(options.block), groups: list(options.group), common: options.common || undefined };
  if (action === "add" || action === "new") {
    if (action === "add" && !docPath) throw new UsageError("Usage: cantus doc add <path> --block <id> | --group <id> | --common");
    if (!targets.blocks && !targets.groups && !targets.common) throw new UsageError("Say who the document is for: --block <id>, --group <id> or --common.");
    const result = addDoc(root, model, { ...targets, path: docPath, description: options.description, create: action === "new" });
    saveModel(root, result.model);
    console.log(`${result.created ? "Created" : "Assigned"} ${result.path}.${result.created ? " Fill it in: it is a template." : ""}\n${describeDocs(root, result.model)}`);
    if (action === "new" && !result.created) console.log(`(${result.path} already existed: it was assigned as it is.)`);
    return 0;
  }
  if (action === "remove") {
    if (!docPath) throw new UsageError("Usage: cantus doc remove <path> [--block <id>] [--group <id>] [--common]");
    const next = unassignDoc(model, docPath, targets);
    saveModel(root, next);
    console.log(describeDocs(root, next));
    return 0;
  }
  throw new UsageError("Usage: cantus doc add|new|remove …");
}

/** The runner named on the command line (a built-in name or a module file), else none: the map decides. */
async function runnerOption(value: string | undefined): Promise<Runner | undefined> {
  if (!value) return undefined;
  return builtInRunner(value) ?? loadRunner(path.resolve(value));
}

async function cmdServe(root: string, port?: number, runnerName?: string, options: { open?: boolean } = {}): Promise<number> {
  // One analysis, shared with the server: it used to analyze once here and once more inside.
  const state = new ProjectState(root);
  const { analysis } = state.get();
  reportDiagnostics(root, analysis);
  const runner = await runnerOption(runnerName);
  const server = await startMapServer(state, { port, ...(runner ? { runner } : {}) });
  console.log(`Cantus live map of ${analysis.name}: ${server.url}\nIt updates as the code changes. Ctrl+C to stop.`);
  if (options.open) openBrowser(server.url);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.close();
  return 0;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`Invalid port "${value}".`);
  return port;
}

function cmdNotes(root: string): number {
  const { analysis, model } = load(root);
  const result = writeNotes(analysis, model);
  console.log(`Notes: ${describeNotes(result)}. Unchanged: ${result.unchanged.length}.`);
  if (result.skipped.length) console.log(`Blocks without a folder of their own (no notes): ${result.skipped.join(", ")}.`);
  return 0;
}

/** Blocks per refine session: enough context for the agent to see the neighbors, short enough to read their files. */
const REFINE_BATCH = 8;

async function cmdRefine(root: string, only: string | undefined, options: Record<string, string | boolean | undefined>): Promise<number> {
  const { analysis, model } = load(root);
  if (!model) throw new UsageError("No map saved yet: run `cantus analyze --write` first, then refine it.");
  const ids = blocksToRefine(analysis, model, { all: !!options.all, only: only?.split(",").map((id) => id.trim()).filter(Boolean) });
  if (ids.length === 0) {
    console.log("Every block is refined and unchanged since. `cantus refine --all` refines them again.");
    return 0;
  }
  const budget = options.budget === undefined ? undefined : Number(options.budget);
  if (budget !== undefined && !(budget > 0)) throw new UsageError("--budget must be a positive number.");
  const runner = (await runnerOption(options.runner as string | undefined)) ?? builtInRunner(model.agent?.runner) ?? claudeCodeRunner;
  const agentModel = (options.model as string | undefined) ?? model.agent?.model;
  let current = model;
  const total: Omit<RefineResult, "model"> = { applied: [], rejected: [], shortened: [], suggestions: [] };
  let costUsd = 0;
  let sessions = 0;
  // Fixed before the first session, so every batch is written in the same language.
  const language = (options.language as string | undefined)?.trim() || undefined;
  for (const batch of refineBatches(analysis, ids, REFINE_BATCH)) {
    console.error(`Refining ${batch.join(", ")}…`);
    const refinement = await requestRefinement(runner, { cwd: root, analysis, map: current, blocks: batch, ...(language ? { language } : {}), onCost: (usd) => (costUsd += usd), ...(agentModel ? { model: agentModel } : {}), ...(budget ? { maxBudgetUsd: budget } : {}) });
    sessions++;
    const result = applyRefinement(current, analysis, refinement, batch);
    current = result.model;
    // Saved after every session: a failure later keeps what is done.
    saveModel(root, current);
    total.applied.push(...result.applied);
    total.rejected.push(...result.rejected);
    total.shortened.push(...result.shortened);
    total.suggestions.push(...result.suggestions);
  }
  // Kept after the run: the terminal is gone by the time anyone decides, and an agent may never have read it.
  addSuggestions(root, total.suggestions);
  const cost = costUsd > 0 ? ` Estimated cost: $${costUsd.toFixed(2)} (${sessions} session${sessions === 1 ? "" : "s"}).` : "";
  if (options.json) console.log(JSON.stringify({ blocks: ids, sessions, ...(costUsd > 0 ? { costUsd } : {}), ...total }, null, 2));
  else console.log(describeRefinement(total, ids.length) + (cost ? `\n\n${cost.trim()}` : ""));
  const refreshed = analyze(root, { model: current });
  const rootNotes = ["AGENTS.md", "CLAUDE.md"].map((name) => path.join(root, name)).find((file) => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(NOTES_START));
  if (rootNotes) {
    // Only the blocks just refined: the notes of the others are not touched by a run that did not look at them.
    const notes = writeNotes(refreshed, current, { only: ids });
    if (notes.written.length || notes.removed.length) console.error(`Notes: ${describeNotes(notes)}.`);
  }
  const agents = refreshClaudeAgents(refreshed, current);
  if (agents?.written.length) console.error(`Subagents updated: ${agents.written.join(", ")}.`);
  return 0;
}

async function cmdMcp(root: string, options: { ui: boolean; readOnly?: boolean; channels?: boolean; port?: number; runner?: string }): Promise<number> {
  const state = new ProjectState(root);
  let mapUrl: string | undefined;
  let mapServer: MapServer | undefined;
  // Binding the live map does not analyze the project. The browser's first request needs the analysis.
  const startMap = async () => {
    try {
      const runner = await runnerOption(options.runner);
      mapServer = await startMapServer(state, { port: options.port, session: true, warm: false, ...(runner ? { runner } : {}) });
      mapUrl = mapServer.url;
      console.error(`Cantus live map: ${mapUrl}`);
    } catch (error) {
      console.error(`Cantus: live map not started (${error instanceof Error ? error.message : String(error)}).`);
    }
  };
  let starting: Promise<void> | undefined;
  const ensureMap = () => starting ??= startMap();
  await runStdioServer(root, {
    state, readOnly: options.readOnly, channels: options.channels, mapUrl: () => mapUrl, mapToken: () => mapServer?.token,
    ...(options.ui ? {
      startMap: ensureMap,
      onInitialized: () => {
        if (fs.existsSync(modelPath(root))) void ensureMap();
      },
    } : {}),
  });
  // Serve until the client closes the connection (or the process is told to stop); stdout belongs to the protocol.
  await new Promise<void>((resolve) => {
    process.stdin.on("end", resolve);
    process.stdin.on("close", resolve);
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
  // Leave no `serve.json` pointing at a process that is gone: the hooks would talk to nothing.
  await starting;
  await mapServer?.close();
  return 0;
}

function cmdReroot(root: string, from: string, write: boolean): number {
  const oldRoot = path.resolve(root, from);
  const old = loadModel(oldRoot);
  if (!old) throw new UsageError(`No map in ${path.relative(root, oldRoot) || from}/.cantus/model.json.`);
  const target = path.join(root, MODEL_DIR, "model.json");
  if (fs.existsSync(target)) throw new UsageError(`${path.relative(root, target)} already exists: move or delete it first, reroot does not overwrite a map.`);
  const result = rerootModel(old, from);
  console.log(`Map of ${from}/ (${old.blocks.length} blocks) as the map of ${path.basename(path.resolve(root))}: every path gets \`${from.replace(/\\/g, "/").replace(/\/+$/, "")}/\` in front; ids, arrows, layers, groups and rules are unchanged.`);
  result.warnings.forEach((warning) => console.log(`  - ${warning}`));
  if (!write) {
    console.log("Nothing written. Run again with --write to save it.");
    return 0;
  }
  const file = saveModel(root, result.model);
  console.log(`Saved ${path.relative(root, file)}. The old map in ${from}/.cantus is untouched. Next: add the folders that were not part of it to analysis.include, then \`cantus analyze --write\`.`);
  return 0;
}

function cmdAgents(root: string): number {
  const { analysis, model } = load(root);
  const result = exportClaudeAgents(analysis, model);
  if (result.blocked) {
    console.error(`Nothing written: .claude in this project is a link to ${result.blocked}, outside it, shared with other checkouts. Agents written through it would show up in every session there. Make .claude a real folder here (or point the link inside the project) and run \`cantus agents\` again.`);
    return 1;
  }
  console.log(`Claude Code subagents: ${result.written.length} written, ${result.unchanged.length} unchanged, ${result.removed.length} removed.`);
  [...result.written, ...result.removed.map((file) => `${file} (removed)`)].forEach((file) => console.log(`  ${file}`));
  if (result.createdFolder) console.log("The .claude/agents folder is new: a Claude Code session that is already open loads these agents only after a restart (`claude --continue` keeps the conversation). Later ones are picked up while it runs.");
  return 0;
}

async function cmdHook(root: string, event: string, rootIsExplicit: boolean): Promise<number> {
  if (!["session-start", "pre-edit", "post-edit", "user-prompt", "tool-use", "stop", "permission", "subagent-start", "subagent-stop"].includes(event)) throw new UsageError(`Unknown hook event "${event}".`);
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    const input = (raw.trim() ? JSON.parse(raw) : {}) as HookInput;
    const projectRoot = rootIsExplicit ? root : path.resolve(input.cwd ?? root);
    if (event === "permission") {
      await reportPermission(input, projectRoot);
      return 0;
    }
    if (event === "user-prompt" || event === "tool-use" || event === "stop") {
      if (event === "tool-use") reportRead(input, projectRoot);
      const taken = await takeRequests(input, projectRoot, event === "user-prompt" ? "prompt" : event === "tool-use" ? "tool" : "stop");
      if (taken) process.stdout.write(JSON.stringify(taken));
      return 0;
    }
    if (event === "subagent-start" || event === "subagent-stop") {
      await reportAgent(event, input, projectRoot);
      return 0;
    }
    await reportEdit(event as HookEvent, input, projectRoot);
    const result = handleHook(event as HookEvent, input, projectRoot);
    if (result) process.stdout.write(JSON.stringify(result));
  } catch (error) {
    // A hook must never break the agent's work: log and stay silent.
    try {
      const file = path.join(root, MODEL_DIR, "hooks.log");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${event}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    } catch {
      // nothing else to do
    }
  }
  return 0;
}

async function cmdVerify(root: string, options: Record<string, string | boolean | undefined>): Promise<number> {
  if (options.head === undefined) return verifyIn(root, options);
  if (options.head === true || !String(options.head).trim()) throw new UsageError("--head needs a branch, tag or commit.");
  // A branch nobody has checked out: verified in a temporary checkout of it, where nothing is installed yet.
  const ref = String(options.head);
  if (options.request) throw new UsageError("--head and --request both choose the work: give one.");
  if (!options.tests && !options["no-tests"]) console.error("· --head: the temporary checkout of the branch has no installed dependencies, so the tests are not run. Give --tests \"<command>\" to run one anyway.");
  return withCheckout(root, ref, (folder) => verifyIn(folder, { ...options, head: undefined, local: true, ...(options.tests ? {} : { "no-tests": true }) }));
}

async function verifyIn(root: string, options: Record<string, string | boolean | undefined>): Promise<number> {
  const number = (name: string) => {
    if (options[name] === undefined) return undefined;
    const value = Number(options[name]);
    if (!(value > 0)) throw new UsageError(`--${name} must be a positive number.`);
    return value;
  };
  // The report is printed once, on stdout: the result event repeats the last text of the session.
  let lastText = "";
  const show = (event: TaskEvent) => {
    if (event.kind === "result" && event.text === lastText) return;
    if (event.kind === "text") lastText = event.text;
    console.error(formatEvent(event));
  };
  // In a worktree Cantus made, with nothing said about the work: the reviewer gets the task, the lead's report and the base from the worktree.
  const worktree = !options.about && !options.request && !options.base ? worktreeVerifyContext(root) : undefined;
  if (worktree) console.error(`· A worktree Cantus made: the reviewer gets its task${worktree.claims ? ", the lead's report" : ""} and compares with where it started (give --about or --base to say otherwise).`);
  const verify = {
    ...(options.base ? { base: String(options.base) } : worktree ? { base: worktree.base } : {}),
    ...(options.about ? { about: String(options.about) } : worktree?.about ? { about: worktree.about } : {}),
    ...(worktree?.claims ? { claims: worktree.claims } : {}),
    tests: options["no-tests"] ? (false as const) : (options.tests as string | undefined),
  };

  if (!options["no-tests"] && !options.tests && !options.head && !loadModel(root)?.agent?.verifyCommand?.trim()) {
    console.error("· No test command: the map has no agent.verifyCommand and --tests was not given, so the tests are NOT run (the reviewer is told, and the report says so). To have them run first, set agent.verifyCommand in .cantus/model.json or pass --tests \"<command>\".");
  }
  if (!options["dry-run"] && !options.local && !options.tests && !options.runner) {
    // A live map for this project is running (the open session's): the review runs there, shows on the map, and its findings can reach the session.
    const serve = readServeInfo(root);
    if (serve?.token) {
      const remote = await verifyThroughMap({ url: serve.url, token: serve.token }, {
        ...(options.request ? { request: String(options.request) } : {}),
        ...(options.base ? { base: String(options.base) } : {}),
        ...(options.about ? { about: String(options.about) } : {}),
        ...(options.model ? { model: String(options.model) } : {}),
        ...(number("max-turns") ? { maxTurns: number("max-turns") } : {}),
        ...(number("budget") ? { maxBudgetUsd: number("budget") } : {}),
        ...(options["no-tests"] ? { tests: false } : {}),
        ...(options["no-deliver"] ? { deliver: false } : {}),
      }, show);
      if (remote) {
        const note = { session: worthSending(remote.verification!) ? "The findings were sent to the open Claude Code session." : "Nothing to send to the open Claude Code session.", "no-session": "No Claude Code session is attached to the map: the findings were not sent.", off: "The findings were not sent to the session (--no-deliver)." }[remote.delivery as string];
        return reportVerification(remote, options, note);
      }
      console.error("· The live map did not answer: verifying here.");
    }
  }
  if (options.request) throw new UsageError("--request needs the live map of the open session (start it from the session).");
  if (!options["dry-run"] && !options.local && (options.tests || options.runner) && readServeInfo(root)?.token) {
    // Said at the start, not in the last line: a review costs money, and these findings would be lost.
    console.error(`· A live map is running, but ${options.tests ? "--tests (a command from the command line is never run by the map)" : "--runner"} makes this verification run here, so its findings will NOT reach the open Claude Code session.${options.tests ? " To have them delivered, leave --tests out and set agent.verifyCommand in the map." : ""} Stop now (Ctrl+C) if that is not what you want.`);
  }

  const state = new ProjectState(root);
  const { model } = state.get();
  if (options["dry-run"]) {
    const plan = planVerification(state, verify);
    const prepared = await prepareVerification(state, plan, { log: (text) => console.error(`· ${text}`), runTests: false });
    console.log(prepared.prompt);
    console.error(`\n(Dry run: ${plan.testCommand ? `the tests (\`${plan.testCommand}\`) were not run` : "no test command"}, and no agent was started.)`);
    return 0;
  }
  const runner = (await runnerOption(options.runner as string | undefined)) ?? builtInRunner(model?.agent?.runner) ?? claudeCodeRunner;
  const tasks = new TaskManager(state, runner, { onEvent: (_task, event) => show(event) });
  const task = tasks.start({
    prompt: "",
    verify,
    ...(options.model ? { model: String(options.model) } : {}),
    ...(number("max-turns") ? { maxTurns: number("max-turns") } : {}),
    ...(number("budget") ? { maxBudgetUsd: number("budget") } : {}),
  });
  const interrupt = () => {
    console.error("Stopping the verification…");
    try {
      tasks.stop(task.id);
    } catch {
      // already finished
    }
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const done = await tasks.wait(task.id);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  return reportVerification(done, options, "Run without the live map of a session, so the findings were not sent to one (see --local).");
}

/** Prints a finished verification and says how it ended: 0 when nothing serious was found. */
function reportVerification(done: TaskRecord, options: Record<string, string | boolean | undefined>, delivery?: string): number {
  const verification = done.verification!;
  if (options.json) console.log(JSON.stringify({ id: done.id, status: done.status, model: done.model, costUsd: done.costUsd, error: done.error, result: verification.review ? undefined : done.result, verification }, null, 2));
  else process.stdout.write(renderReviewText(verification, { costUsd: done.costUsd, model: done.model }));
  if (done.error) console.error(`Error: ${done.error}`);
  console.error(`\nVerification ${done.id}: ${done.status}${done.costUsd ? ` · ~$${done.costUsd.toFixed(2)}` : ""}. Record: ${path.join(RUNS_DIR, `${done.id}.json`)}${delivery ? `\n${delivery}` : ""}`);
  return done.status === "done" && verification.review && verification.review.verdict !== "incomplete" && !needsAction(verification.review) ? 0 : 1;
}

/**
 * Starts the verification on the project's live map and follows it until it ends, printing its events.
 * Undefined when the map cannot be reached (a stale file left by a server that is gone).
 */
async function verifyThroughMap(serve: { url: string; token: string }, body: Record<string, unknown>, show: (event: TaskEvent) => void): Promise<(TaskRecord & { delivery?: string }) | undefined> {
  const headers = { "content-type": "application/json", "x-cantus-token": serve.token };
  let started: Response;
  try {
    started = await fetch(new URL("api/verify", serve.url), { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  } catch {
    return undefined;
  }
  const first = (await started.json()) as TaskRecord & { delivery?: string; error?: string };
  if (!started.ok) throw new Error(first.error ?? `The live map answered ${started.status}.`);
  console.error(`· Running on the live map ${serve.url}`);
  const seen = new Set<string>();
  const key = (event: TaskEvent) => `${event.at}|${event.kind}|${event.text}`;
  const pump = (task: TaskRecord) => {
    for (const event of task.events) {
      if (seen.has(key(event))) continue;
      seen.add(key(event));
      show(event);
    }
  };
  let stopping = false;
  const interrupt = () => {
    if (stopping) return;
    stopping = true;
    console.error("Stopping the verification…");
    fetch(new URL(`api/tasks/${first.id}/stop`, serve.url), { method: "POST", headers, body: "{}" }).catch(() => undefined);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    let task = first;
    for (;;) {
      pump(task);
      if (task.finishedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const response = await fetch(new URL(`api/tasks/${first.id}`, serve.url), { headers, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`The live map stopped answering (${response.status}); the verification may still be running there.`);
      task = (await response.json()) as TaskRecord;
    }
    return { ...task, ...(first.delivery ? { delivery: first.delivery } : {}) };
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

async function cmdTask(root: string, args: string[], options: Record<string, string | boolean | undefined>): Promise<number> {
  const usage = 'task <block>[,<block>...] "<prompt>" | task --group <id> "<prompt>" | task --all "<prompt>" | task --build ["<notes>"]';
  const whole = !!options.all || !!options.group;
  const build = !!options.build;
  const scope = build ? { build: true } : options.all ? { orchestrate: true } : options.group ? { group: String(options.group) } : { blocks: requireArg(args[0], usage).split(",").map((id) => id.trim()).filter(Boolean) };
  const prompt = build ? (args[0] ?? "") : requireArg(whole ? args[0] : args[1], usage);
  const shell = (options.shell ?? "verify") as string;
  if (!["none", "verify", "all"].includes(shell)) throw new UsageError(`--shell must be none, verify or all, not "${shell}".`);
  if (options.merge && !options.worktree) throw new UsageError("--merge needs --worktree.");
  const number = (name: string) => {
    if (options[name] === undefined) return undefined;
    const value = Number(options[name]);
    if (!(value > 0)) throw new UsageError(`--${name} must be a positive number.`);
    return value;
  };
  const retries = options.retries === undefined ? undefined : Number(options.retries);
  if (retries !== undefined && !(Number.isInteger(retries) && retries >= 0 && retries <= 5)) throw new UsageError("--retries must be a whole number from 0 to 5.");

  const state = new ProjectState(root);
  const { model } = state.get();
  if (build) refreshClaudeAgents(state.get().analysis, model);
  const runner = (await runnerOption(options.runner as string | undefined)) ?? builtInRunner(model?.agent?.runner) ?? claudeCodeRunner;
  const setup = options.worktree ? (model?.agent?.worktree?.setup ?? []) : [];
  let confirmSetup = !!options["run-setup"];
  if (setup.length && !confirmSetup) {
    const commands = setup.map((command) => `  ${command}`).join("\n");
    if (!process.stdin.isTTY) throw new UsageError(`The map's worktree rules run commands on this machine:\n${commands}\nAdd --run-setup to agree: nothing can ask here.`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question(`The map's worktree rules run these commands in the new worktree:\n${commands}\nRun them? [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.error("Not confirmed: nothing started.");
      return 1;
    }
    confirmSetup = true;
  }
  if (options.check !== undefined && options.verify !== undefined) throw new UsageError("--check and --verify both choose the check: give one.");
  let verifyCommand = (options.verify as string | undefined) ?? model?.agent?.verifyCommand;
  if (options.check !== undefined) {
    try {
      verifyCommand = resolveCheck(model, String(options.check));
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
  }
  const tasks = new TaskManager(state, runner, {
    policy: autonomousPolicy({ allowOutsideScope: !!options["allow-outside"], shell: shell as "none" | "verify" | "all", verifyCommand, trustTools: !!options.trust, mcpDeny: model?.agent?.mcp?.deny }),
    onEvent: (_task, event) => console.error(formatEvent(event)),
  });
  const task = tasks.start({
    ...scope,
    prompt,
    mode: options.plan ? "plan" : "edit",
    isolation: options.worktree ? "worktree" : "in-place",
    ...(confirmSetup ? { confirmSetup } : {}),
    ...(options["no-gate"] ? { gate: false as const } : verifyCommand ? { gate: verifyCommand } : {}),
    ...(retries !== undefined ? { retries } : {}),
    ...(options.model ? { model: String(options.model) } : {}),
    ...(number("max-turns") ? { maxTurns: number("max-turns") } : {}),
    ...(number("budget") ? { maxBudgetUsd: number("budget") } : {}),
  });
  const interrupt = () => {
    console.error("Stopping the task…");
    try {
      tasks.stop(task.id);
    } catch {
      // already finished
    }
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const done = await tasks.wait(task.id);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);

  let mergeFailed = false;
  if (done.status === "done" && options.merge && done.worktree) {
    try {
      await tasks.merge(done.id);
    } catch (error) {
      mergeFailed = true;
      console.error(`${error instanceof Error ? error.message : String(error)}\nThe work stays on ${done.worktree.branch} (worktree ${done.worktree.path}).`);
    }
  }
  if (options.json) console.log(JSON.stringify(done, null, 2));
  else if (done.result) console.log(done.result);
  console.error(summarizeTask(done));
  return (done.status === "done" || done.status === "merged") && !mergeFailed ? 0 : 1;
}

async function loadRunner(file: string): Promise<Runner> {
  const module = (await import(pathToFileURL(file).href)) as { default?: Runner; runner?: Runner };
  const runner = module.default ?? module.runner;
  if (typeof runner !== "function") throw new UsageError(`${file} must export a runner function (default export or \`runner\`).`);
  return runner;
}

function formatEvent(event: TaskEvent): string {
  const denied = event.kind === "decision" && event.text.startsWith("Denied");
  const mark = denied ? "✗ " : { text: "  ", tool: "→ ", approval: "? ", decision: "✓ ", result: "= ", error: "✗ ", info: "· ", user: "> " }[event.kind];
  return mark + event.text.split("\n").join("\n  ");
}

function summarizeTask(task: TaskRecord): string {
  const lines = [`\nTask ${task.id}: ${task.status}${task.costUsd ? ` · ~$${task.costUsd.toFixed(2)}` : ""} · scope ${task.scope.name}`];
  if (task.changedFiles.length) lines.push(`Changed: ${task.changedFiles.join(", ")}`);
  const outside = task.events.filter((event) => event.kind === "decision" && /^Denied/.test(event.text));
  if (outside.length) lines.push(`Refused: ${outside.length} step(s), see the record.`);
  if (task.worktree && task.status !== "merged" && task.status !== "discarded") lines.push(`Branch: ${task.worktree.branch} (worktree ${task.worktree.path}); merge it with \`git merge ${task.worktree.branch}\`.`);
  if (task.gate?.passed) lines.push(`Check: \`${task.gate.command}\` passed (${task.gate.seconds}s).`);
  if (task.error) lines.push(`Error: ${task.error}`);
  lines.push(`Record: ${path.join(RUNS_DIR, `${task.id}.json`)}`);
  return lines.join("\n");
}

function cmdIndex(root: string): number {
  const model = loadModel(root);
  const analysis = analyze(root, { model });
  writeAnalysisLog(root, analysis, LOG_FILE);
  writeProjectIndex(root, analysis, model);
  return 0;
}

function printAnalysis(analysis: Analysis, findings: Finding[]) {
  const total = Object.values(analysis.fileTokens).reduce((sum, tokens) => sum + tokens, 0);
  console.log(`${analysis.name}: ${analysis.blocks.length} blocks, ${Object.keys(analysis.fileTokens).length} files, ~${formatTokens(total)} tokens${analysis.blocksInferred ? " (blocks inferred from directories)" : ""}\n`);
  for (const info of analysis.blocks) {
    const out = analysis.dependencies.filter((dep) => dep.from === info.block.id).map((dep) => dep.to);
    console.log(`  ${info.block.id.padEnd(28)} ${info.block.layer.padEnd(15)} ${String(info.files.length).padStart(4)} files ~${formatTokens(info.tokens).padStart(5)} tok  ${out.length ? "→ " + out.join(", ") : ""}`);
  }
  if (findings.length) {
    console.log("");
    printFindings(renderFindings(findings, analysis), findings.length);
  }
}

function printFindings(lines: FindingLine[], total: number) {
  if (lines.length === 0) {
    console.log("No findings: the code matches the map.");
    return;
  }
  const marks = { error: "✗", warning: "!", info: "·" };
  for (const line of lines) console.log(`  ${marks[line.severity]} [${line.kind}] ${line.message}`);
  if (lines.length < total) console.log(`\n${total} finding(s) in ${lines.length} line(s); \`cantus check --full\` lists each one.`);
}

function requireArg(value: string | undefined, usage: string): string {
  if (!value) throw new UsageError(`Missing argument. Usage: cantus ${usage}`);
  return value;
}

async function cmdPlan(root: string, args: string[], options: Record<string, string | boolean | undefined>): Promise<number> {
  const usage = "plan <add <file|->|list|show <id>|run <id>|accept <id> <task>>";
  const sub = args[0];
  const store = new PlanStore(root);
  const state = new ProjectState(root);
  if (sub === "add") {
    const source = requireArg(args[1], "plan add <file|->");
    let text: string;
    if (source === "-") {
      text = "";
      for await (const chunk of process.stdin) text += chunk;
    } else {
      text = fs.readFileSync(path.resolve(source), "utf8");
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new UsageError(`The plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const { analysis, model } = state.get();
    const { plan, check } = readPlan(raw, analysis, model);
    for (const warning of check.warnings) console.error(`· ${warning}`);
    if (!plan || check.errors.length) {
      console.error(check.errors.map((line) => `✗ ${line}`).join("\n"));
      return 1;
    }
    const stored = store.add(plan, { kind: "person" });
    console.log(renderPlanText(stored, store.state(stored.id), orderPlan(stored, analysis, model)));
    console.log(`\nStored as ${stored.id}; it is not approved. \`cantus plan run ${stored.id}\` approves it and runs it.`);
    return 0;
  }
  if (sub === "list") {
    const all = store.list();
    if (options.json) console.log(JSON.stringify(all, null, 2));
    else if (!all.length) console.log("No plans. `cantus plan add <file>` stores one.");
    else for (const { plan, state: s } of all) console.log(`${plan.id}  ${s.status.padEnd(11)} ${Object.values(s.tasks).filter((task) => task.status === "merged").length}/${plan.tasks.length} merged · $${s.costUsd.toFixed(2)} · ${plan.goal.slice(0, 80)}`);
    return 0;
  }
  const id = requireArg(args[1], usage);
  if (sub === "show") {
    const plan = store.get(id);
    const current = store.state(id);
    const { analysis, model } = state.get();
    if (options.json) console.log(JSON.stringify({ plan, state: current, order: orderPlan(plan, analysis, model) }, null, 2));
    else console.log(renderPlanText(plan, current, orderPlan(plan, analysis, model)));
    return 0;
  }
  if (sub === "accept") {
    const taskId = requireArg(args[2], "plan accept <id> <task>");
    store.accept(id, taskId);
    console.log(`Accepted: the findings of the review of "${taskId}" no longer hold plan ${id}. \`cantus plan run ${id}\` goes on.`);
    return 0;
  }
  if (sub !== "run") throw new UsageError(`Usage: cantus ${usage}`);
  const plan = store.get(id);
  const current = store.state(id);
  const { analysis, model } = state.get();
  console.error(renderPlanText(plan, current, orderPlan(plan, analysis, model)));
  const setup = model?.agent?.worktree?.setup ?? [];
  if (setup.length && !options["run-setup"]) throw new UsageError(`The map's worktree rules run commands on this machine for every task:\n${setup.map((command) => `  ${command}`).join("\n")}\nAdd --run-setup to agree.`);
  if (current.approvedRevision !== plan.revision) {
    if (!options.yes) {
      if (!process.stdin.isTTY) throw new UsageError("The plan is not approved. Add --yes to approve it (nothing can ask here).");
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      const answer = await rl.question(`\nApprove this plan and run it? Each task runs an agent unattended, in a worktree, and is merged into the current branch. [y/N] `);
      rl.close();
      if (!/^y(es)?$/i.test(answer.trim())) {
        console.error("Not approved: nothing started.");
        return 1;
      }
    }
  }
  const runner = (await runnerOption(options.runner as string | undefined)) ?? builtInRunner(model?.agent?.runner) ?? claudeCodeRunner;
  let allowed: string[] = [];
  const tasks = new TaskManager(state, runner, {
    policy: autonomousPolicy({ shell: ((options.shell as string | undefined) ?? "verify") as "none" | "verify" | "all", verifyCommand: () => allowed, mcpDeny: model?.agent?.mcp?.deny }),
    onEvent: (task, event) => console.error(`[${task.id}] ${formatEvent(event)}`),
  });
  const planRunner = new PlanRunner(state, tasks, store);
  allowed = planRunner.checkCommands(plan);
  planRunner.approve(id);
  const stop = () => {
    console.error("Stopping the plan…");
    planRunner.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const finished = await planRunner.run(id, { confirmSetup: !!options["run-setup"], log: (line) => console.error(line) });
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  console.error(`\n${renderPlanText(plan, finished, orderPlan(plan, analysis, model))}`);
  if (finished.status === "blocked" || finished.status === "stopped") console.error(`\n\`cantus plan run ${id}\` picks it up from the task it stopped at.`);
  return finished.status === "finished" ? 0 : 1;
}

class UsageError extends Error {}

main(process.argv.slice(2)).then(
  // Exit only once stdout is flushed: a large --json output piped to another program would be cut.
  (code) => exitAfterFlush(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    if (!(error instanceof UsageError)) logCrash(error);
    exitAfterFlush(error instanceof UsageError ? 2 : 1);
  },
);
