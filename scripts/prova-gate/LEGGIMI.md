# Prove del cancello, del ritentativo, dei controlli con nome e dei piani

`prova-gate.mjs` crea progetti-giocattolo usa-e-getta in una cartella temporanea e ci lancia `cantus task` e `cantus plan` con un agente. Scrive `prova-gate-report.md` e `.json` nella cartella da cui lo lanci. Esiti: OK, KO (da correggere in Cantus), INCONCLUSIVA (l'agente ha fatto un'altra cosa: si rilancia), INFO (misura, non giudizio).

```
node scripts/prova-gate/prova-gate.mjs --cli dist/cli.js --runner scripts/prova-gate/runner-finto.mjs --yes   # agente finto: costo zero, gira anche in CI (tests/prova-gate.test.mjs)
node scripts/prova-gate/prova-gate.mjs --cli dist/cli.js                                                     # Claude Code vero: costa quota, chiede conferma
```

Opzioni: `--only s1,p2`, `--model`, `--budget`, `--keep`, `--dry-run`. Prove: s1 cancello verde, s2a/s2b ritentativo, s3 stesso errore due volte, s4 worktree bloccato, s5 controlli con nome, s6 shell (virgolette e `&&`, importante su Windows), s7 MISURA (l'agente tocca il test sbagliato?), p1/p2/p3 piano (ordine, ripresa, piani rifiutati), p4 verificatore separato.

Con l'agente finto le prove s2b, s7 e il verdetto di p4 non misurano nessun modello: solo con un agente vero dicono qualcosa su Claude. `runner-lento.mjs` e `prova-arresto.sh` provano l'arresto di un piano con Ctrl+C (solo Linux/macOS/WSL; su Windows a mano).
