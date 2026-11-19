# Verificare un candidato al rilascio

Questa procedura verifica un candidato prima del rilascio.

## Giro ripetibile

Partire da un clone completo del branch candidato, con i WASM originali tracciati in `grammars/`. Servono Git e Node 20.19+ della serie 20.x oppure Node 22.12+, come dichiarato in `package.json`.

```sh
pnpm install --frozen-lockfile
npm run verify:release
```

`verify:release` esegue controllo dei tipi, build, suite, controllo pacchetto e prova di installazione. Il controllo pacchetto carica le sei grammatiche Tree-sitter e analizza un esempio per ognuna. La prova di installazione crea un tarball temporaneo, lo installa in un progetto nuovo, verifica il comando e l'API pubblica, analizza esempi JS, TS, Vue, Python, Go, Java, C#, Rust e PHP e prova `init` dal pacchetto installato.

L'installazione usa il registro npm con gli script di installazione disattivati. Le cartelle temporanee vengono eliminate anche in caso di errore. Per ripetere soltanto questa prova dopo una build:

```sh
npm run smoke:package
# Solo se le dipendenze sono già nella cache npm:
npm run smoke:package -- --offline
```

La prova deve risolvere `cantus` e le dipendenze nel progetto nuovo. Estrarre il tarball e collegarlo alle dipendenze dello sviluppo è una prova diagnostica: non dimostra che un'installazione pulita riesca.

## Verifiche separate

- **Interfaccia:** i test browser usano Playwright quando è disponibile. Se sono saltati o il browser non parte, il risultato non verifica l'interfaccia. In un ambiente con Playwright, installare il suo Chromium (`npx playwright install chromium`) e ripetere la suite; controllare anche il riepilogo.
- **Runtime e Windows:** eseguire il giro sulle versioni Node supportate e su Windows nativo. Le versioni simulate nei test verificano il controllo iniziale, non la compatibilità dei parser nativi.
- **Primo uso reale:** su un progetto di 50–300 file, cronometrare installazione → mappa; controllare chiamanti e un cambio di API conosciuto. `init --dry-run` non deve scrivere; un secondo `init` senza modifiche deve essere idempotente. Con errori di lettura deve fermarsi senza aggiornare mappa e note.
- **Agenti:** registrare flussi, versioni ed esiti delle prove con Claude Code o Codex reali. I runner simulati dimostrano proprietà del ciclo, non la qualità del codice generato.

Annotare commit, OS, versione Node, comandi, risultati e limiti nel resoconto della release.

Se il browser standard non è disponibile, i test accettano `CANTUS_TEST_BROWSER_PATH` (percorso dell'eseguibile) e `CANTUS_TEST_BROWSER_ARGS` (array JSON di argomenti). Senza queste variabili usano il browser di Playwright. Registrare sempre versione e configurazione realmente provate; queste opzioni riguardano solo i test.

## Prima di pubblicare

Allineare README, esempi e limiti al candidato provato. Non presentare risparmio di token o miglioramento della qualità come dimostrati senza un confronto misurato. Fissare versione e changelog, verificare licenza e attribuzioni, controllare i file del pacchetto e i riferimenti da rendere pubblici.

Pubblicazione npm e cambio di visibilità restano azioni distinte del manutentore. `prepublishOnly` ripete `verify:release`; non sostituisce le prove manuali sopra.

## Evidenza del candidato del 19 novembre 2026

| Ambiente | Prova | Esito |
|---|---|---|
| Linux x64, Node 24.22.3, Chromium headless 153.0.8010.0 | `npm run verify:release` con `CANTUS_TEST_BROWSER_PATH` | 818 su 818, inclusi i test browser. 23 file richiesti nel pacchetto. Installazione pulita e nove smoke test linguistici riusciti. |
| Linux x64, Node 20.20.2 | `init`, `diff`, MCP e integrità del pacchetto | 35 su 35 |
| Linux x64, Node 22.23.5 | Stesse prove mirate | 35 su 35 |
| Windows nativo | Supporto runtime e sessioni agenti | Verifica pendente |
| Codex CLI in sandbox read-only | Pilot A/B su h3 e ohash | 12 tentativi fermati all'avvio del sandbox. Nessuna risposta o metrica di consumo. |

I [dati del benchmark](../benchmark/publication/README.md) includono tempi di primo uso, riferimenti TypeScript e il controllo delle rinomine. Il [pilot agenti](../benchmark/agent-workflows/README.md) contiene i comandi e i criteri per ripetere il confronto.
