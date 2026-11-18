// Reports of the loop, in Italian: one per round and a summary of the whole run.
const tick = (ok) => (ok ? "✓" : "✗");

/** The phase 1 exit criteria, per target, from the scenarios that prove them. */
export function exitCriteria(results, targets) {
  const passed = (scenario, target) => {
    const run = results.find((result) => result.scenario === scenario && result.target === target);
    return run ? run.checks.every((check) => check.kind !== "assert" || check.ok) : undefined;
  };
  const rows = [];
  for (const target of targets) {
    const block = [passed("task-mappa", target), passed("task-autonomo", target)];
    rows.push({ criterion: "Task su un blocco fino al merge, senza interventi fuori dalla mappa", target, ok: block.includes(true) ? true : block.includes(false) ? false : undefined });
    rows.push({ criterion: "Task su tutto il progetto fino al merge", target, ok: passed("task-tutto", target) });
  }
  rows.push({ criterion: "Gli hook avvisano davvero di un breaking change", target: "toy", ok: passed("plugin", "toy") });
  const crash = results.flatMap((result) => result.checks).filter((check) => /crash/.test(check.name));
  rows.push({ criterion: "Nessun crash aperto", target: "tutti", ok: crash.length ? crash.every((check) => check.ok) && results.every((result) => !result.error) : undefined });
  return rows;
}

export function roundReport({ round, results, criteria, spent, artifactsDir }) {
  const lines = [`# Giro ${round}`, "", `Spesa stimata finora: $${spent.toFixed(2)}. Artefatti: \`${artifactsDir}\`.`, "", "## Criteri di uscita della fase 1", "", "| Criterio | Progetto | Esito |", "|---|---|---|"];
  for (const row of criteria) lines.push(`| ${row.criterion} | ${row.target} | ${row.ok === undefined ? "non provato" : tick(row.ok)} |`);
  lines.push("", "## Scenari", "", "| Scenario | Progetto | Verifiche | Durata |", "|---|---|---|---|");
  for (const result of results) {
    const asserts = result.checks.filter((check) => check.kind === "assert");
    lines.push(`| ${result.scenario} | ${result.target} | ${result.error ? "errore" : `${asserts.filter((check) => check.ok).length}/${asserts.length}`} | ${result.seconds}s |`);
  }
  const failed = results.flatMap((result) => [
    ...(result.error ? [{ result, name: "lo scenario si è interrotto", detail: result.error }] : []),
    ...result.checks.filter((check) => check.kind === "assert" && !check.ok).map((check) => ({ result, ...check })),
  ]);
  lines.push("", "## Verifiche fallite", "");
  if (!failed.length) lines.push("Nessuna.");
  for (const failure of failed) lines.push(`- **${failure.result.scenario} / ${failure.result.target}** — ${failure.name}${failure.detail ? `\n  \`${oneLine(failure.detail)}\`` : ""}\n  artefatti: \`${failure.result.outDir}\``);
  lines.push("", "## Osservazioni (domande aperte, non giudicate)", "");
  const observed = results.flatMap((result) => result.checks.filter((check) => check.kind === "observe").map((check) => ({ result, ...check })));
  if (!observed.length) lines.push("Nessuna.");
  for (const item of observed) lines.push(`- ${tick(item.ok)} ${item.result.scenario} / ${item.result.target}: ${item.name}${item.detail ? ` — ${oneLine(item.detail)}` : ""}`);
  return lines.join("\n") + "\n";
}

export function summaryReport({ rounds, fixes, stopReason, spent, environment, cantusBranch, bundle }) {
  const lines = ["# Loop di prova della fase 1 — riepilogo", "", `Fine: ${stopReason}. Giri: ${rounds.length}. Spesa stimata: $${spent.toFixed(2)}.`, ""];
  lines.push("## Ambiente", "", "```", ...Object.entries(environment).map(([key, value]) => `${key}: ${value}`), "```", "");
  lines.push("## Verifiche per giro", "", `| Verifica | ${rounds.map((round) => `G${round.round}`).join(" | ")} |`, `|---|${rounds.map(() => "---").join("|")}|`);
  const names = new Map();
  for (const round of rounds) {
    for (const result of round.results) {
      for (const check of result.checks) names.set(`${result.scenario} / ${result.target} — ${check.name}${check.kind === "observe" ? " (oss.)" : ""}`, true);
      if (result.error) names.set(`${result.scenario} / ${result.target} — lo scenario si è interrotto`, true);
    }
  }
  for (const name of names.keys()) {
    const cells = rounds.map((round) => {
      for (const result of round.results) {
        if (name === `${result.scenario} / ${result.target} — lo scenario si è interrotto`) return result.error ? "✗" : "✓";
        const check = result.checks.find((candidate) => name === `${result.scenario} / ${result.target} — ${candidate.name}${candidate.kind === "observe" ? " (oss.)" : ""}`);
        if (check) return tick(check.ok);
      }
      return "–";
    });
    lines.push(`| ${name} | ${cells.join(" | ")} |`);
  }
  lines.push("", "## Correzioni del loop", "");
  if (!fixes.length) lines.push("Nessuna (correzione automatica spenta, o niente da correggere).");
  for (const fix of fixes) lines.push(`- Giro ${fix.round}: ${fix.kept ? "tenute" : "non tenute"} — ${fix.reason}${fix.commits.length ? `\n${fix.commits.map((commit) => `  - ${commit}`).join("\n")}` : ""}`);
  if (bundle) {
    lines.push("", "Le correzioni tenute sono nel bundle qui accanto. Per portarle nel tuo clone di Cantus, rivederle e aprire le PR (una per correzione):", "", "```bash", `git fetch <percorso>/${bundle.split(/[\\/]/).pop()} ${cantusBranch}:${cantusBranch}`, `git log --oneline main..${cantusBranch}`, "```");
  }
  return lines.join("\n") + "\n";
}

const oneLine = (text) => String(text).replace(/\s+/g, " ").replace(/`/g, "'").slice(0, 400);
