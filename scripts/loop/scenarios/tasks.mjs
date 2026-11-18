// Tasks run by Cantus with a real Claude Code: from the live map (prova D, driven through its API as
// a scripted user), unattended (prova E), on the whole project, and "Build the plan".
import fs from "node:fs";
import path from "node:path";
import { claudeEnv } from "../lib/claude.mjs";
import { sketchToyModel } from "../lib/fixture.mjs";
import { driveTask, startServe } from "../lib/serve.mjs";
import { checkErrors, crashes, latestRunRecord, prepareTarget, runVerify, taskBranches } from "../lib/targets.mjs";
import { describeToolUse, summarizeToolUse } from "../lib/usage.mjs";
import { assert, git, observe, sleep, spawnAsync } from "../lib/util.mjs";

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** How much the agent of a task used Cantus's tools on its own, from the task's recorded events. */
function useObservation(events) {
  const use = summarizeToolUse((events ?? []).filter((event) => event.kind === "tool").map((event) => ({ tool: event.tool })));
  return observe("uso spontaneo degli strumenti Cantus", use.cantusCalls > 0, describeToolUse(use));
}

function needs(tasks, ...keys) {
  const missing = keys.filter((key) => !tasks[key]);
  if (missing.length) throw new Error(`Manca nella configurazione del target: ${missing.join(", ")}`);
}

/** Checks shared by every task that should end merged in the target's branch. */
function mergedChecks(ctx, root, label, { verify, before }) {
  const checks = [];
  checks.push(assert(`${label}: nessun branch cantus/task-* rimasto`, taskBranches(root).length === 0, taskBranches(root).join(", ")));
  const tests = runVerify(ctx, root, verify);
  checks.push(assert(`${label}: verifica dopo il merge (${verify ?? "nessuna"})`, tests.code === 0, tests.output.slice(-800)));
  const after = checkErrors(ctx, root);
  if (before?.errors !== undefined && after.errors !== undefined) checks.push(assert(`${label}: nessun errore nuovo in cantus check`, after.errors <= before.errors, `prima ${before.errors}, dopo ${after.errors}`));
  const crashed = crashes(root);
  checks.push(assert(`${label}: nessun crash di Cantus`, crashed.length === 0, crashed.slice(0, 3).join(" | ")));
  return checks;
}

function mapTaskScenario(runner) {
  const cli = runner === "claude-cli";
  return {
    id: cli ? "task-mappa-cli" : "task-mappa",
    title: `Task dalla mappa, runner ${runner}: piano, permessi, worktree, merge, stop`,
    covers: cli ? ["Runner claude-cli: permessi nella mappa, attese lunghe, uscita dalla modalità piano"] : ["Prova D", "Criterio: task su un blocco fino al merge"],
    targets: "all",
    async run(ctx, target) {
      const checks = [];
      const { root, tasks } = prepareTarget(ctx, target, ctx.workDir);
      needs(tasks, "block", "blockPrompt");
      const before = checkErrors(ctx, root);
      const api = await startServe(ctx, root, { runner: cli ? "claude-cli" : ctx.runner, logFile: path.join(ctx.outDir, "serve.log"), env: { MCP_TOOL_TIMEOUT: String(ctx.longWaitMs + 10 * 60_000) } });
      try {
        const started = await api.start({ block: tasks.block, prompt: tasks.blockPrompt, mode: "plan", isolation: "worktree", maxBudgetUsd: ctx.budgetPerSession });
        let firstEdit;
        const { task, log } = await driveTask(api, started.id, {
          verify: tasks.verify,
          timeoutMs: ctx.taskTimeoutMs + (cli ? ctx.longWaitMs : 0),
          waitBeforeFirstMs: cli ? ctx.longWaitMs : 0,
          inspect: (approval, current) => {
            if (firstEdit || approval.kind !== "tool" || !WRITE_TOOLS.has(approval.tool)) return;
            const where = current.worktree?.path ?? root;
            firstEdit = { file: approval.file, dirty: git(where, "status", "--porcelain").stdout.trim() };
          },
        });
        ctx.spend(task.costUsd ?? 0);
        fs.writeFileSync(path.join(ctx.outDir, "task.json"), JSON.stringify(task, null, 2));
        fs.writeFileSync(path.join(ctx.outDir, "decisions.json"), JSON.stringify(log, null, 2));
        const decided = log.filter((row) => row.approval);
        checks.push(assert("piano chiesto in approvazione", decided.some((row) => row.approval.kind === "plan"), decided.map((row) => row.approval.kind + ":" + row.approval.tool).join(", ")));
        const plan = decided.find((row) => row.approval.kind === "plan");
        if (plan) checks.push(assert("il riquadro del piano mostra il piano", plan.approval.summary.length > 40 && !/^The agent finished planning\.$/.test(plan.approval.summary), plan.approval.summary.slice(0, 200)));
        checks.push(assert("dopo l'approvazione del piano chiede prima di modificare", !!firstEdit && firstEdit.dirty === "", firstEdit ? (firstEdit.dirty ? `il worktree era già cambiato: ${firstEdit.dirty}` : `prima richiesta: ${firstEdit.file}`) : "nessuna richiesta di modifica arrivata alla mappa"));
        const accepted = log.findIndex((row) => row.action === "accept-edits");
        const askedAfter = accepted < 0 ? [] : log.slice(accepted + 1).filter((row) => row.approval && WRITE_TOOLS.has(row.approval.tool) && !row.approval.outsideScope);
        checks.push(assert("\"Accept edits for the rest\": le modifiche dopo non chiedono più", accepted >= 0 && askedAfter.length === 0, accepted < 0 ? "accept-edits non usato (una sola modifica?)" : `${askedAfter.length} richieste dopo`));
        const outside = decided.filter((row) => row.approval.outsideScope);
        checks.push(observe("modifica fuori perimetro chiesta e negata", outside.length > 0, outside.map((row) => row.approval.file).join(", ") || "l'agente non l'ha chiesta"));
        if (outside.length) checks.push(assert("il rifiuto compare nell'attività del task", task.events.some((event) => event.kind === "decision" && /^Denied/.test(event.text)), ""));
        if (cli) checks.push(assert("attesa lunga prima di rispondere: la richiesta non scade", log.some((row) => row.action === "long-wait") && task.status === "done", `${Math.round(ctx.longWaitMs / 1000)} s, stato ${task.status}`));
        checks.push(assert("task finito (done)", task.status === "done", `${task.status}${task.error ? `: ${task.error}` : ""}`));
        checks.push(useObservation(task.events));
        const diff = task.status === "done" ? await api.diff(task.id).catch(() => "") : "";
        checks.push(assert("Show diff non vuoto", diff.trim().length > 0, `${diff.split("\n").length} righe`));
        if (task.status === "done") {
          const merged = await api.merge(task.id).catch((error) => ({ status: "error", error: String(error) }));
          checks.push(assert("Merge into your branch", merged.status === "merged", merged.error ?? merged.status));
          checks.push(assert("worktree rimosso dopo il merge", !task.worktree || !fs.existsSync(task.worktree.path), task.worktree?.path ?? ""));
          checks.push(...mergedChecks(ctx, root, "merge", { verify: tasks.verify, before }));
        }

        // Stop on another task.
        const other = await api.start({ block: tasks.block, prompt: "Read every file of this block and write a detailed explanation of each function. Take your time.", mode: "edit", isolation: "worktree", maxBudgetUsd: ctx.budgetPerSession });
        // Stopped as soon as the agent is at work: on a small project it can finish this prompt in a few seconds.
        let current = await api.get(other.id);
        for (const deadline = Date.now() + 15_000; ["running", "waiting"].includes(current.status) && !current.events.some((event) => event.kind === "text" || event.kind === "tool") && Date.now() < deadline; current = await api.get(other.id)) await sleep(500);
        if (["running", "waiting"].includes(current.status)) {
          const stopped = await api.stop(other.id).catch((error) => ({ status: "error", error: String(error) }));
          checks.push(assert("Stop su un altro task", stopped.status === "stopped", stopped.error ?? stopped.status));
        } else checks.push(observe("Stop su un altro task", false, `il task è finito prima dello stop (${current.status})`));
        const discarded = await api.discard(other.id).catch((error) => ({ status: "error", error: String(error) }));
        checks.push(observe("Discard del task fermato", discarded.status === "discarded", discarded.error ?? discarded.status));
      } finally {
        await api.close();
      }
      return checks;
    },
  };
}

async function cantusTask(ctx, root, args, name) {
  const out = path.join(ctx.outDir, `${name}.out.txt`);
  const err = path.join(ctx.outDir, `${name}.err.txt`);
  const run = await spawnAsync(process.execPath, [ctx.cantusCli, "task", ...args, ...(ctx.runner ? ["--runner", ctx.runner] : []), "--budget", String(ctx.budgetPerSession), "-C", root], { cwd: root, env: claudeEnv(ctx), timeoutMs: ctx.taskTimeoutMs, stdoutFile: out, stderrFile: err });
  const record = latestRunRecord(root);
  if (record) fs.writeFileSync(path.join(ctx.outDir, `${name}.record.json`), JSON.stringify(record, null, 2));
  ctx.spend(record?.costUsd ?? 0);
  return { ...run, record };
}

const autonomous = {
  id: "task-autonomo",
  title: "cantus task su un blocco senza supervisione (--worktree --merge --verify)",
  covers: ["Prova E", "Criterio: task su un blocco fino al merge"],
  targets: "all",
  async run(ctx, target) {
    const { root, tasks } = prepareTarget(ctx, target, ctx.workDir);
    needs(tasks, "block", "blockPrompt");
    const before = checkErrors(ctx, root);
    const run = await cantusTask(ctx, root, [tasks.block, tasks.blockPrompt, "--worktree", "--merge", ...(tasks.verify ? ["--verify", tasks.verify] : [])], "task");
    const checks = [assert("exit 0", run.code === 0, run.timedOut ? "timeout" : run.stderr.slice(-800)), assert("stato merged nel record", run.record?.status === "merged", run.record?.status ?? "nessun record")];
    const outside = (run.record?.events ?? []).filter((event) => event.kind === "decision" && /outside your scope/.test(event.text));
    checks.push(observe("modifica fuori perimetro rifiutata e citata", outside.length > 0 && /Refused/.test(run.stderr), outside.map((event) => event.file ?? event.text.slice(0, 120)).join("; ") || "nessuna richiesta fuori perimetro"));
    const shell = (run.record?.events ?? []).filter((event) => event.kind === "decision" && event.tool === "Bash");
    const allowedOther = shell.filter((event) => /^Allowed/.test(event.text) && !(tasks.verify && event.text.includes(`Bash: ${tasks.verify}`)));
    checks.push(assert("comandi di shell consentiti: solo la verifica", allowedOther.length === 0, allowedOther.map((event) => event.text.slice(0, 120)).join("; ") || `${shell.length} comandi decisi`));
    checks.push(useObservation(run.record?.events));
    checks.push(...mergedChecks(ctx, root, "merge", { verify: tasks.verify, before }));
    return checks;
  },
};

const wholeProject = {
  id: "task-tutto",
  title: "cantus task --all: il progetto intero con gli specialisti, fino al merge",
  covers: ["Orchestratore su tutto il progetto", "Criterio: task su tutto il progetto fino al merge"],
  targets: "all",
  async run(ctx, target) {
    const { root, tasks } = prepareTarget(ctx, target, ctx.workDir);
    needs(tasks, "allPrompt");
    const before = checkErrors(ctx, root);
    const run = await cantusTask(ctx, root, ["--all", tasks.allPrompt, "--worktree", "--merge", ...(tasks.verify ? ["--verify", tasks.verify] : [])], "task-all");
    const delegated = run.record?.delegations ?? [];
    const checks = [
      assert("exit 0", run.code === 0, run.timedOut ? "timeout" : run.stderr.slice(-800)),
      assert("stato merged nel record", run.record?.status === "merged", run.record?.status ?? "nessun record"),
      assert("ha delegato ad almeno uno specialista block-*", delegated.some((call) => /^block-/.test(call.agent)), delegated.map((call) => call.agent).join(", ") || "nessuna delega"),
      observe("deleghe solo a specialisti (nessun agente generico)", delegated.length > 0 && delegated.every((call) => /^(block|group)-/.test(call.agent)), delegated.map((call) => call.agent).join(", ")),
      useObservation(run.record?.events),
    ];
    checks.push(...mergedChecks(ctx, root, "merge", { verify: tasks.verify, before }));
    return checks;
  },
};

const buildPlan = {
  id: "build-plan",
  title: "Build the plan: due blocchi senza codice (catalog, cart) costruiti a ondate",
  covers: ["\"Build the plan\" su un progetto di 4-6 blocchi", "Deleghe ad agenti generici (aperto, src/run/tasks.ts:637)"],
  targets: ["toy"],
  async run(ctx, target) {
    const { root, tasks } = prepareTarget(ctx, target, ctx.workDir, { modelPatch: sketchToyModel });
    const before = checkErrors(ctx, root);
    const run = await cantusTask(ctx, root, ["--build", "--worktree", "--merge", ...(tasks.verify ? ["--verify", tasks.verify] : [])], "build");
    const delegated = run.record?.delegations ?? [];
    const firstFor = (block) => delegated.find((call) => call.blocks?.includes(block) || call.agent === `block-${block}`);
    const catalog = firstFor("src-catalog");
    const cart = firstFor("src-cart");
    const checks = [
      assert("exit 0", run.code === 0, run.timedOut ? "timeout" : run.stderr.slice(-800)),
      assert("stato merged nel record", run.record?.status === "merged", run.record?.status ?? "nessun record"),
      assert("src/catalog e src/cart hanno codice", fs.existsSync(path.join(root, "src/catalog")) && fs.existsSync(path.join(root, "src/cart")), ""),
      assert("nessun blocco affidato a un agente generico", delegated.length > 0 && delegated.every((call) => /^(block|group)-/.test(call.agent)), delegated.map((call) => call.agent).join(", ") || "nessuna delega"),
      observe("ondate: catalog (fornitore) parte prima di cart", !!catalog && !!cart && catalog.startedAt <= cart.startedAt, catalog && cart ? `${catalog.startedAt} / ${cart.startedAt}` : "deleghe non trovate"),
    ];
    checks.push(...mergedChecks(ctx, root, "merge", { verify: tasks.verify, before }));
    const check = checkErrors(ctx, root);
    checks.push(observe("cantus check dopo la costruzione: 0 errori (API coerenti, frecce nel codice)", check.errors === 0, `errori: ${check.errors}`));
    return checks;
  },
};

export default [mapTaskScenario("sdk"), mapTaskScenario("claude-cli"), autonomous, wholeProject, buildPlan];
