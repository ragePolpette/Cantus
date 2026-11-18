// How much a real agent uses Cantus's tools on its own: which ones, and whether it looked before it edited.
// Nothing here judges: the scenarios report it as an observation, and the rounds show whether the
// instructions, the hooks and the session-start outline are enough or the agent ignores the tools.
const CANTUS_TOOL = /^mcp__(?:plugin_)?cantus(?:_cantus)?__(.+)$/;
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const ORIENT = new Set(["map", "block_context", "find_api", "callers", "impact", "diff"]);
const BEFORE_CHANGING_AN_EXPORT = new Set(["callers", "impact"]);
const CLOSING = new Set(["review_changes", "check", "diff", "update_map", "update_notes"]);

/** `mcp__plugin_cantus_cantus__find_api` → `find_api`; undefined for any other tool. */
export function cantusToolName(tool) {
  return CANTUS_TOOL.exec(String(tool ?? ""))?.[1];
}

/**
 * @param calls  [{ tool, parent? }] in the order the agent made them (a stream or a task's events);
 *               `parent` is set for calls made by a subagent.
 */
export function summarizeToolUse(calls) {
  const cantus = {};
  const firstEdit = calls.findIndex((call) => WRITE_TOOLS.has(call.tool));
  const lastEdit = calls.map((call) => WRITE_TOOLS.has(call.tool)).lastIndexOf(true);
  const before = [];
  const after = [];
  let bySubagents = 0;
  calls.forEach((call, index) => {
    const name = cantusToolName(call.tool);
    if (!name) return;
    cantus[name] = (cantus[name] ?? 0) + 1;
    if (call.parent) bySubagents++;
    if (firstEdit >= 0 && index < firstEdit && !before.includes(name)) before.push(name);
    if (lastEdit >= 0 && index > lastEdit && CLOSING.has(name) && !after.includes(name)) after.push(name);
  });
  return {
    calls: calls.length,
    edits: calls.filter((call) => WRITE_TOOLS.has(call.tool)).length,
    cantus,
    cantusCalls: Object.values(cantus).reduce((sum, count) => sum + count, 0),
    bySubagents,
    /** Cantus tools called before the first edit, each once, in order. */
    beforeFirstEdit: before,
    /** Read the map or a briefing, or searched, before the first edit. */
    oriented: before.some((name) => ORIENT.has(name)),
    /** Asked who calls what (callers, impact) before the first edit. */
    checkedCallers: before.some((name) => BEFORE_CHANGING_AN_EXPORT.has(name)),
    /** Reviewed the work (review_changes, check, diff...) after the last edit. */
    closedTheLoop: after,
  };
}

/** One line for the round report. */
export function describeToolUse(summary) {
  const used = Object.entries(summary.cantus).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ×${count}`);
  if (summary.cantusCalls === 0) return `nessuno strumento Cantus su ${summary.calls} chiamate (${summary.edits} modifiche)`;
  return [
    `${summary.cantusCalls} chiamate Cantus su ${summary.calls}: ${used.join(", ")}`,
    summary.edits === 0 ? "nessuna modifica" : `prima della prima modifica: ${summary.beforeFirstEdit.join(", ") || "niente"}; callers/impact prima: ${summary.checkedCallers ? "sì" : "no"}`,
    summary.closedTheLoop.length ? `dopo l'ultima: ${summary.closedTheLoop.join(", ")}` : "",
    summary.bySubagents ? `${summary.bySubagents} dagli specialisti` : "",
  ].filter(Boolean).join("; ");
}
