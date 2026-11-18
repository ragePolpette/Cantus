#!/usr/bin/env bash
# Prova dell'arresto di un piano (solo Linux/macOS/WSL): lancia un piano con un runner lento, manda Ctrl+C (SIGINT),
# controlla che il piano risulti "stopped", poi lo rilancia con un runner veloce e controlla che finisca.
# Atteso: exit=1 dopo il Ctrl+C, stato "stopped {"t1":"stopped"}", seconda esecuzione exit=0 con t1 [merged].
set -u
KIT=${2:-$(cd "$(dirname "$0")" && pwd)}
CLI=${1:?uso: bash prova-arresto.sh <percorso di dist/cli.js> [cartella del kit]}
D=$(mktemp -d "${TMPDIR:-/tmp}/cantus-arresto-XXXX"); cd $D
git init -q -b main . && git config user.email a@b.c && git config user.name p && git config commit.gpgsign false
mkdir -p src/calc .cantus && echo 'export const a=1;' > src/calc/calc.js
echo '{"version":1,"name":"p4","blocks":[{"id":"src-calc","name":"Calc","layer":"domain","include":["src/calc"],"description":"x"}],"agent":{"checks":{"ok":"node -e \"process.exit(0)\""}}}' > .cantus/model.json
printf '.cantus/cache/\n.cantus/runs/\n' > .gitignore
echo '{"goal":"slow","tasks":[{"id":"t1","blocks":["src-calc"],"prompt":"Do t1.","check":"ok","retries":0}]}' > ../$(basename $D)-plan.json
git add -A && git commit -q -m init
node $CLI plan add ../$(basename $D)-plan.json -C . | tail -2
ID=$(ls .cantus/runs/plans | grep -v state | head -1 | sed 's/.json//')
node $CLI plan run $ID --yes --runner $KIT/runner-lento.mjs -C . > out.txt 2> err.txt &
PID=$!
sleep 8; kill -INT $PID; wait $PID; echo "exit=$?"
tail -5 err.txt
node -e "const s=require('./.cantus/runs/plans/$ID.state.json');console.log(s.status,JSON.stringify(Object.fromEntries(Object.entries(s.tasks).map(([k,v])=>[k,v.status]))))"
git worktree list | wc -l; git status --short | head
echo "--- seconda esecuzione"
node $CLI plan run $ID --yes --runner $KIT/runner-finto.mjs -C . 2>&1 > second.txt 2>&1; echo "exit=$?"; tail -4 second.txt
