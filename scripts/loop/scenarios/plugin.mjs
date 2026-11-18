// Prova C without a person: the plugin installed from the marketplace, its hooks and MCP tools,
// and the breaking-change warning, for the main agent and for a block specialist. On the toy, and
// on every target that names an API change in "plugin": { file, block, change }.
import path from "node:path";
import { claudeEnv, contextRows, delegations, runClaude, toolCalls } from "../lib/claude.mjs";
import { describeToolUse, summarizeToolUse } from "../lib/usage.mjs";
import { prepareTarget } from "../lib/targets.mjs";
import { assert, observe, readJsonLines, sh } from "../lib/util.mjs";

const ONLY_THAT_FILE = "Edit only that file: do not update its callers or the tests (this is a test of the warnings you get).";
const REPORT = '{"warned": true or false (did a message tell you that other blocks call this function?), "call_sites": [the call sites that message listed, as file:line], "session_start_map": true or false (did a Cantus map summary reach you when the session started?)}';
const SCHEMA = {
  type: "object",
  properties: { warned: { type: "boolean" }, call_sites: { type: "array", items: { type: "string" } }, session_start_map: { type: "boolean" }, delegated_to: { type: "string" } },
  required: ["warned"],
};
const SESSION_START = /This project has an? Cantus map/;
const EXPECTED_TOOLS = ["map", "block_context", "callers", "find_api"];

export default {
  id: "plugin",
  title: "Plugin dal marketplace: hook, strumenti MCP, avviso di breaking change",
  covers: ["Prova C", "Criterio: gli hook avvisano davvero di un breaking change", "Hook nei sotto-agenti (aperto)"],
  targets: "all",
  appliesTo: (target) => target.name === "toy" || !!target.plugin,
  async run(ctx, target) {
    const checks = [];
    const env = claudeEnv(ctx);
    const claude = (...args) => sh(ctx.claudeBin, args, { env, timeoutMs: 5 * 60_000 });
    const added = claude("plugin", "marketplace", "add", ctx.cantusDir);
    checks.push(assert("claude plugin marketplace add", added.code === 0 || /already/i.test(added.stdout + added.stderr), (added.stdout + added.stderr).trim().slice(-500)));
    const installed = claude("plugin", "install", "cantus@cantus");
    checks.push(assert("claude plugin install cantus@cantus", installed.code === 0, (installed.stdout + installed.stderr).trim().slice(-500)));
    const listed = claude("plugin", "list");
    checks.push(assert("claude plugin list mostra cantus", /cantus/.test(listed.stdout), listed.stdout.trim().slice(-500)));

    // 1. The main agent edits the API itself. Two working copies, so each a worktree of its own.
    const main = prepareTarget({ ...ctx, slug: `${ctx.slug}-principale` }, target, path.join(ctx.workDir, "principale"));
    const { file, block, change } = main.tasks.plugin;
    const CHANGE = `${change} ${ONLY_THAT_FILE}`;
    const PRE_EDIT = `other blocks use exports of ${file}`;
    const POST_EDIT = `changes the API of ${file}`;
    const specialist = `block-${block}`;
    const edited = (row) => row.file?.endsWith(`/${file}`);
    const first = await runClaude(ctx, {
      name: "plugin-principale",
      cwd: main.root,
      prompt: `Please ${CHANGE}\nThen answer only with JSON: ${REPORT}`,
      tools: ["Read", "Edit", "Write", "Glob", "Grep"],
      schema: SCHEMA,
    });
    checks.push(assert("principale: sessione completata", first.ok, first.ok ? `${first.seconds}s` : `exit ${first.code}: ${first.stderr.slice(-500)}`));
    const plugins = (first.init?.plugins ?? []).map((plugin) => plugin.name ?? plugin);
    checks.push(assert("init: plugin cantus caricato", plugins.some((name) => /cantus/.test(name)), plugins.join(", ") || "nessun plugin"));
    const servers = (first.init?.mcp_servers ?? []).filter((server) => /cantus/.test(server.name));
    checks.push(assert("init: server MCP di cantus connesso", servers.some((server) => server.status === "connected"), servers.map((server) => `${server.name}: ${server.status}`).join(", ") || "nessun server cantus"));
    const tools = (first.init?.tools ?? []).filter((tool) => /cantus/.test(tool));
    const missing = EXPECTED_TOOLS.filter((name) => !tools.some((tool) => tool.endsWith(`__${name}`)));
    checks.push(assert("init: strumenti MCP map, block_context, callers, find_api", missing.length === 0, missing.length ? `mancano ${missing.join(", ")}; nomi: ${tools.join(", ")}` : tools.join(", ")));
    // The autonomous policy approves mcp__cantus__* and mcp__plugin_cantus*: anything else would be refused in `cantus task`.
    const unknownPrefix = tools.filter((tool) => !tool.startsWith("mcp__cantus__") && !tool.startsWith("mcp__plugin_cantus"));
    checks.push(assert("nomi degli strumenti coperti dalla policy di cantus task", tools.length > 0 && unknownPrefix.length === 0, unknownPrefix.join(", ") || tools[0] || "nessuno"));

    const mainRows = first.transcripts.main ? readJsonLines(first.transcripts.main) : first.events;
    const mainText = JSON.stringify(contextRows(mainRows)) + JSON.stringify(first.hookEvents);
    checks.push(assert("hook di avvio: la mappa arriva al principale", SESSION_START.test(mainText), first.structured?.session_start_map === undefined ? "" : `dichiarato: ${first.structured.session_start_map}`));
    const edits = first.probe.filter((row) => row.event === "PreToolUse" && /Edit|Write/.test(row.tool ?? "") && edited(row));
    checks.push(assert(`il principale ha modificato ${file}`, edits.length > 0, `${edits.length} modifiche`));
    checks.push(assert("hook pre-edit: blocco e chiamanti prima della modifica", mainText.includes(PRE_EDIT), ""));
    checks.push(assert("hook post-edit: avviso di breaking change al principale", mainText.includes(POST_EDIT), `dichiarato: ${first.structured?.warned}; call site: ${(first.structured?.call_sites ?? []).join(", ")}`));

    // Without being asked to, does the agent look with Cantus's tools before it changes an export?
    const mainUse = summarizeToolUse(toolCalls(first.events));
    checks.push(observe("uso spontaneo degli strumenti Cantus (principale)", mainUse.cantusCalls > 0, describeToolUse(mainUse)));

    // 2. A block specialist edits it: do the hooks run inside subagents, and does the warning reach it?
    const sub = prepareTarget({ ...ctx, slug: `${ctx.slug}-specialista` }, target, path.join(ctx.workDir, "specialista"));
    const second = await runClaude(ctx, {
      name: "plugin-specialista",
      cwd: sub.root,
      prompt: [
        `Delegate this change to the ${specialist} subagent and do not edit any file yourself:`,
        CHANGE,
        "Ask it to report, at the end, whether it received a message saying that other blocks call the function it changed, quoting that message.",
        `Then answer only with JSON: {"delegated_to": the subagent you used, "warned": true or false (did the subagent report such a message?), "call_sites": [the call sites it quoted]}`,
      ].join("\n"),
      tools: ["Read", "Edit", "Write", "Glob", "Grep", "Agent"],
      schema: SCHEMA,
    });
    checks.push(assert("specialista: sessione completata", second.ok, second.ok ? `${second.seconds}s` : `exit ${second.code}: ${second.stderr.slice(-500)}`));
    const secondRows = second.transcripts.main ? readJsonLines(second.transcripts.main) : second.events;
    const asked = delegations(secondRows);
    checks.push(assert(`il principale ha delegato a ${specialist} (validità della prova)`, asked.some((call) => call.agent === specialist), asked.map((call) => call.agent).join(", ") || "nessuna delega"));
    const subEdits = second.probe.filter((row) => row.event === "PreToolUse" && /Edit|Write/.test(row.tool ?? "") && row.agentType);
    const mainEdits = second.probe.filter((row) => row.event === "PreToolUse" && /Edit|Write/.test(row.tool ?? "") && !row.agentType);
    checks.push(observe("hook PreToolUse scattano dentro lo specialista", subEdits.length > 0, subEdits.map((row) => `${row.agentType}: ${row.tool} ${row.file}`).join("; ") || (mainEdits.length ? "ha modificato il principale" : "nessuna modifica vista dagli hook")));
    const posts = second.probe.filter((row) => row.event === "PostToolUse" && /Edit|Write/.test(row.tool ?? "") && row.agentType);
    checks.push(observe("hook PostToolUse scattano dentro lo specialista", posts.length > 0, `${posts.length}`));
    const subText = second.transcripts.subagents.map((file) => JSON.stringify(contextRows(readJsonLines(file)))).join("\n");
    const hookText = JSON.stringify(second.hookEvents);
    checks.push(observe("avviso post-edit nel contesto dello specialista", subText.includes(POST_EDIT), `transcript dello specialista: ${subText.includes(POST_EDIT) ? "sì" : "no"}; eventi hook: ${hookText.includes(POST_EDIT) ? "sì" : "no"}; dichiarato: ${second.structured?.warned}`));
    const subUse = summarizeToolUse(toolCalls(second.events));
    checks.push(observe("uso spontaneo degli strumenti Cantus (con delega allo specialista)", subUse.cantusCalls > 0, describeToolUse(subUse)));
    return checks;
  },
};
