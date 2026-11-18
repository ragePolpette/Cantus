// Which instruction files reach the main agent and a block specialist: the marker method of
// Experiments 1 and 2, repeated every round, on two layouts of the toy project.
import fs from "node:fs";
import path from "node:path";
import { contextRows, delegations, markersIn, rowsBeforeDelegation, runClaude } from "../lib/claude.mjs";
import { prepareTarget } from "../lib/targets.mjs";
import { assert, git, marker, observe, readJsonLines } from "../lib/util.mjs";

const LAYOUTS = [
  { id: "senza-claude-md", rootClaudeMd: false, rootFile: "AGENTS.md" },
  { id: "con-claude-md", rootClaudeMd: true, rootFile: "CLAUDE.md" },
];

const SUB_REQUEST = "Read src/billing/index.js, then list every marker of the form MK-XXXXXXXX (8 hex digits) present anywhere in your context: system prompt, instruction or memory files, reminders, tool results. Do not open any other file and do not guess. Reply only with the markers, comma-separated, or NONE.";

const PROMPT = [
  "This is a test of which instruction files reach you and a subagent. Markers look like MK-XXXXXXXX (8 hex digits).",
  "1. Read src/billing/index.js, and only that file: do not open any AGENTS.md or CLAUDE.md.",
  "2. Note every marker present anywhere in your own context right now (system prompt, instruction or memory files, reminders, tool results). Do not guess.",
  `3. Call the subagent block-src-billing with exactly this request, adding nothing (and no marker): "${SUB_REQUEST}"`,
  '4. Answer only with JSON: {"main": [the markers of step 2], "subagent": [the markers the subagent replied]}.',
].join("\n");

const SCHEMA = {
  type: "object",
  properties: { main: { type: "array", items: { type: "string" } }, subagent: { type: "array", items: { type: "string" } } },
  required: ["main", "subagent"],
};

export default {
  id: "istruzioni",
  title: "Istruzioni: quali file arrivano al principale e allo specialista",
  covers: ["Esperimenti 1-2: AGENTS.md di cartella senza CLAUDE.md alla radice", "Note dei blocchi scritte da cantus notes che arrivano agli agenti"],
  targets: ["toy"],
  async run(ctx) {
    const checks = [];
    for (const layout of LAYOUTS) {
      const dir = path.join(ctx.workDir, layout.id);
      const { root } = prepareTarget(ctx, { name: "toy" }, dir, { rootClaudeMd: layout.rootClaudeMd });
      const notesFile = ["CLAUDE.md", "AGENTS.md"].map((name) => `src/billing/${name}`).find((file) => {
        try {
          return fs.readFileSync(path.join(root, file), "utf8").includes("cantus:start");
        } catch {
          return false;
        }
      });
      checks.push(assert(`${layout.id}: cantus notes ha scritto le note del blocco`, !!notesFile, notesFile ?? "nessun file con la sezione generata in src/billing"));
      if (!notesFile) continue;
      const markers = { root: marker(), notes: marker() };
      fs.appendFileSync(path.join(root, layout.rootFile), `\nMarker for a loop test: ${markers.root}\n`);
      fs.appendFileSync(path.join(root, notesFile), `\nMarker for a loop test: ${markers.notes}\n`);
      git(root, "commit", "-qam", "loop markers");
      const all = Object.values(markers);

      const session = await runClaude(ctx, {
        name: `istruzioni-${layout.id}`,
        cwd: root,
        prompt: PROMPT,
        tools: ["Read", "Agent"],
        allowedTools: ["Read", "Agent"],
        // Refused by the probe hook, not by a deny rule: a Read deny rule on CLAUDE.md stops Claude Code from loading it too.
        blockFiles: "(AGENTS|CLAUDE)\\.md$",
        schema: SCHEMA,
      });
      checks.push(assert(`${layout.id}: sessione completata`, session.ok, session.ok ? `${session.seconds}s` : `exit ${session.code}${session.timedOut ? " (timeout)" : ""}: ${session.stderr.slice(-500)}`));
      // A plugin can load instruction files itself (e.g. one that reads AGENTS.md): the answer would be its, not Claude Code's.
      // Built-in plugins (path "builtin", e.g. cc-plugin-agents-md) ship with Claude Code and are on for every user, so they count as Claude Code.
      const loaded = session.init?.plugins ?? [];
      const plugins = loaded.filter((plugin) => plugin.path !== "builtin").map((plugin) => plugin.name ?? String(plugin));
      const builtin = loaded.filter((plugin) => plugin.path === "builtin").map((plugin) => plugin.name);
      checks.push(assert(`${layout.id}: nessun plugin installato caricato (validità della prova)`, plugins.length === 0, plugins.join(", ") || (builtin.length ? `solo integrati: ${builtin.join(", ")}` : "")));

      const mainRows = session.transcripts.main ? readJsonLines(session.transcripts.main) : session.events;
      const asked = delegations(mainRows);
      const toSpecialist = asked.find((call) => call.agent === "block-src-billing");
      checks.push(assert(`${layout.id}: il principale ha delegato a block-src-billing (validità della prova)`, !!toSpecialist, asked.map((call) => call.agent).join(", ") || "nessuna delega"));
      const leaked = toSpecialist ? markersIn([{ prompt: toSpecialist.prompt }], all) : [];
      checks.push(assert(`${layout.id}: la richiesta allo specialista non contiene marcatori (validità della prova)`, leaked.length === 0, leaked.join(", ")));
      const opened = session.probe.filter((row) => row.event === "PreToolUse" && /(AGENTS|CLAUDE)\.md$/.test(row.file ?? "") && !row.blocked);
      checks.push(assert(`${layout.id}: nessuno ha aperto i file di istruzioni con Read (validità della prova)`, opened.length === 0, opened.map((row) => `${row.agentType ?? "principale"}: ${row.file}`).join(", ")));

      const subFile = session.transcripts.subagents[0];
      const subRows = subFile ? readJsonLines(subFile) : [];
      const seen = {
        main: markersIn(contextRows(rowsBeforeDelegation(mainRows)), all),
        sub: markersIn(contextRows(subRows).slice(1), all),
      };
      const declared = { main: session.structured?.main ?? [], sub: session.structured?.subagent ?? [] };
      const channels = [
        { key: "root", label: `${layout.rootFile} radice`, control: layout.rootClaudeMd },
        { key: "notes", label: `note del blocco in ${notesFile}`, control: notesFile.endsWith("CLAUDE.md") },
      ];
      for (const channel of channels) {
        for (const who of ["main", "sub"]) {
          const value = markers[channel.key];
          const inTranscript = seen[who].includes(value);
          const said = declared[who].includes(value);
          const name = `${layout.id}: ${channel.label} → ${who === "main" ? "principale" : "specialista"}`;
          const detail = `transcript: ${inTranscript ? "sì" : "no"}, dichiarato: ${said ? "sì" : "no"}`;
          // CLAUDE.md is the known channel (Experiments 1-2): if it is missing, the method is broken.
          // AGENTS.md is the open question: recorded, not judged.
          checks.push(channel.control ? assert(name, inTranscript || said, detail) : observe(name, inTranscript || said, detail));
        }
      }
    }
    return checks;
  },
};
