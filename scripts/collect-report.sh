#!/usr/bin/env bash
# Runs Cantus on a project and collects what is needed to judge the result.
# Usage: scripts/collect-report.sh <project-dir> [report-dir]
# It writes .cantus/ in the project and AGENTS.md notes in its folders: run it on a branch.
set -u
CANTUS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$(cd "${1:?Usage: collect-report.sh <project-dir> [report-dir]}" && pwd)"
REPORT="$(mkdir -p "${2:-$PROJECT/cantus-report}" && cd "${2:-$PROJECT/cantus-report}" && pwd)"
AF="node $CANTUS_DIR/dist/cli.js"

step() { echo "== $1"; }
timed() { # timed <name> <command...>: stdout+stderr to <name>.txt, time and exit code to <name>.time
  local name="$1"; shift
  local start end
  start=$(date +%s%N 2>/dev/null || date +%s)
  "$@" >"$REPORT/$name.txt" 2>&1
  local code=$?
  end=$(date +%s%N 2>/dev/null || date +%s)
  if [ ${#start} -gt 12 ]; then echo "exit=$code ms=$(( (end - start) / 1000000 ))" >"$REPORT/$name.time"; else echo "exit=$code s=$(( end - start ))" >"$REPORT/$name.time"; fi
  echo "   $name: $(cat "$REPORT/$name.time")"
}

timed_json() { # timed_json <name> <command...>: like timed, but stderr apart so <name>.txt stays valid JSON
  local name="$1"; shift
  local start end
  start=$(date +%s%N 2>/dev/null || date +%s)
  "$@" >"$REPORT/$name.txt" 2>"$REPORT/$name.stderr.txt"
  local code=$?
  end=$(date +%s%N 2>/dev/null || date +%s)
  if [ ${#start} -gt 12 ]; then echo "exit=$code ms=$(( (end - start) / 1000000 ))" >"$REPORT/$name.time"; else echo "exit=$code s=$(( end - start ))" >"$REPORT/$name.time"; fi
  echo "   $name: $(cat "$REPORT/$name.time")"
}

step "Environment"
{
  echo "date: $(date -u +%FT%TZ)"
  echo "os: $(uname -a 2>/dev/null)"
  echo "node: $(node --version)"
  echo "cantus commit: $(git -C "$CANTUS_DIR" rev-parse --short HEAD 2>/dev/null)"
  echo "project: $PROJECT"
  echo "project commit: $(git -C "$PROJECT" rev-parse --short HEAD 2>/dev/null || echo 'not a git repo')"
  echo "claude: $(claude --version 2>/dev/null || echo 'not installed')"
  echo "codex: $(codex --version 2>/dev/null || echo 'not installed')"
  echo "files (git ls-files, ts/js): $(git -C "$PROJECT" ls-files 2>/dev/null | grep -cE '\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$')"
  echo "tsconfig files: $(git -C "$PROJECT" ls-files 2>/dev/null | grep -c 'tsconfig.*\.json$')"
  echo "package.json files: $(git -C "$PROJECT" ls-files 2>/dev/null | grep -c 'package\.json$')"
  [ -d "$PROJECT/node_modules" ] && echo "node_modules: present" || echo "node_modules: missing"
} >"$REPORT/environment.txt"
cat "$REPORT/environment.txt"

step "Analysis (before saving a map)"
[ -f "$PROJECT/.cantus/model.json" ] && cp "$PROJECT/.cantus/model.json" "$REPORT/model.before.json"
timed analyze $AF analyze -C "$PROJECT" --verbose
timed_json analyze-json $AF analyze -C "$PROJECT" --json

step "Saving the map"
timed analyze-write $AF analyze --write -C "$PROJECT"
cp "$PROJECT/.cantus/model.json" "$REPORT/model.json" 2>/dev/null
timed check $AF check -C "$PROJECT"
timed_json check-json $AF check --json -C "$PROJECT"
timed check-strict $AF check --strict -C "$PROJECT"
cp "$PROJECT/.cantus/analysis.log" "$REPORT/analysis.log" 2>/dev/null

step "Notes, subagents, view"
timed notes $AF notes -C "$PROJECT"
cp "$PROJECT/AGENTS.md" "$REPORT/root-AGENTS.md" 2>/dev/null || cp "$PROJECT/CLAUDE.md" "$REPORT/root-CLAUDE.md" 2>/dev/null
timed agents $AF agents -C "$PROJECT"
timed view $AF view -C "$PROJECT" --out "$REPORT/view.html"

step "Briefing of the largest block"
BIGGEST=$(node -e '
  const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).analysis;
  const b = [...a.blocks].sort((x, y) => y.tokens - x.tokens)[0];
  console.log(b ? b.block.id : "");' "$REPORT/analyze-json.txt" 2>/dev/null)
if [ -n "$BIGGEST" ]; then
  echo "   largest block: $BIGGEST"
  timed context-largest $AF context "$BIGGEST" -C "$PROJECT"
fi

step "MCP tools: time and size of every answer"
timed mcp-probe node "$CANTUS_DIR/scripts/mcp-probe.mjs" "$PROJECT" "$REPORT/mcp-probe.json"

step "Hooks (simulated input)"
FILE=$(node -e '
  const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).analysis;
  const sites = a.callSites || [];
  const counts = {};
  for (const s of sites) counts[s.targetFile] = (counts[s.targetFile] || 0) + 1;
  const best = Object.entries(counts).sort((x, y) => y[1] - x[1])[0];
  console.log(best ? best[0] : (a.blocks[0]?.files[0] ?? ""));' "$REPORT/analyze-json.txt" 2>/dev/null)
echo "   most called file: $FILE"
echo "{\"cwd\":\"$PROJECT\"}" | (timed hook-session-start $AF hook session-start -C "$PROJECT")
[ -n "$FILE" ] && echo "{\"cwd\":\"$PROJECT\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$PROJECT/$FILE\"}}" | (timed hook-pre-edit $AF hook pre-edit -C "$PROJECT")
cp "$PROJECT/.cantus/hooks.log" "$REPORT/hooks.log" 2>/dev/null

step "Task records (if you ran tasks)"
if [ -d "$PROJECT/.cantus/runs" ]; then mkdir -p "$REPORT/runs" && cp "$PROJECT"/.cantus/runs/*.json "$REPORT/runs/" 2>/dev/null; fi

if [ ! -f "$REPORT/NOTE.md" ]; then cat >"$REPORT/NOTE.md" <<'NOTE'
# Note sulla prova (compila tu)

## Progetto
- Che progetto è (dominio, dimensione, monorepo?, framework):
- Perché è "disordinato":

## Mappa
- I blocchi hanno senso? Quali sono sbagliati, troppo grandi, troppo piccoli, mancanti?
- Le dipendenze e i chiamanti mostrati corrispondono a quello che sai del codice?
- Cosa hai dovuto correggere a mano in .cantus/model.json?

## Mappa live (cantus serve)
- Leggibile con questo numero di blocchi? Screenshot in questa cartella.
- Gruppi: salvati e riaperti senza problemi?

## Claude Code con il plugin
- Il contesto di inizio sessione e quello prima delle modifiche sono arrivati? Utili o rumore?
- Claude ha usato block_context / find_api / callers da solo?
- Ha riscritto qualcosa che esisteva già?

## Task dalla mappa / cantus task
- Sequenza: piano mostrato → approvato → richieste di modifica → diff → merge: dove si è rotto?
- Copia qui i passi che non sono andati come previsto.

## Codex
- Strumenti cantus visibili? Usati? Errori?

## Altro
NOTE
fi

echo
echo "Report in $REPORT. Zip it and attach it, with your notes, to the next session:"
echo "  (cd \"$(dirname "$REPORT")\" && zip -qr cantus-report.zip \"$(basename "$REPORT")\")"
