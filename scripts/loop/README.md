# Loop di prova della fase 1

Un ciclo **prova → verifica → nuovo giro** che porta Cantus davanti a un Claude Code vero senza che tu stia alla tastiera. Ogni giro:

1. lancia gli scenari (sotto) su copie dei progetti, con un Claude Code reale in modalità non interattiva (`claude -p`, Agent SDK);
2. verifica ogni passo con controlli deterministici (stream e trascrizioni di Claude Code, un hook sonda che registra quale agente fa cosa, record dei task, git, test);
3. scrive un report del giro con i criteri di uscita della fase 1;
4. se lo accendi, chiede a Claude Code di correggere Cantus (su un clone del loop, un commit con test per correzione, tenuto solo se `npm test` passa) e rifà il giro.

Si ferma quando due giri di fila passano, quando finiscono i giri o il budget, o quando una correzione non regge.

## In un container che hai già

Il loop è un solo programma Node (`node scripts/loop/loop.mjs --config <file>`). Va bene qualsiasi container con:

- Node 22 (Claude Code da npm lo chiede; Cantus vuole almeno il 20), `git`, `sh`; `pnpm` facoltativo (altrimenti `npm install`);
- Claude Code nel `PATH`, installato una volta dall'utente del container e senza root: `curl -fsSL https://claude.ai/install.sh | bash` (finisce in `~/.local/bin`), oppure `"claudeBin"` nella configurazione;
- il login, fatto una volta da te nel container: `claude setup-token` stampa un link, lo apri nel browser del PC, incolli il codice, e il token (valido un anno) va in un file leggibile solo da te, per esempio `~/.config/cantus-loop/token` con `chmod 600`. Nella configurazione: `"auth": { "tokenFile": "/home/<utente>/.config/cantus-loop/token" }`. Il loop lo legge all'avvio e lo passa a Claude Code come `CLAUDE_CODE_OAUTH_TOKEN`; non finisce in nessun log né nei report. In alternativa `CLAUDE_CODE_OAUTH_TOKEN` nell'ambiente, o `"credentialsFile"` (sconsigliato: il login normale rinnova i token e la copia può invalidare l'originale);
- lettura su Cantus e sui progetti (il loop lavora su cloni), scrittura su `work` e `reports`. Tienili fuori dal checkout condiviso da altri agenti: i cloni e i worktree del loop sono suoi.

Il loop non usa chiavi SSH né remoti: non fa `fetch`, `pull` o `push` (i target `"repo"` con un URL sono l'unica eccezione, e un repository pubblico non chiede credenziali). Le correzioni escono come bundle git da portare dove hai le tue credenziali.

Per lanciarlo dal PC senza entrare nel container:

```bash
docker exec <container> node <percorso-di-Cantus>/scripts/loop/loop.mjs --config <percorso>/loop.config.json
```

Ogni giro usa una cartella di configurazione di Claude Code nuova (`CLAUDE_CONFIG_DIR`): niente dei tuoi plugin, impostazioni o `CLAUDE.md` personali entra nelle prove, e le trascrizioni stanno in un posto noto.

## Con l'immagine di esempio (Docker)

Sul PC (una volta):

```bash
claude setup-token          # login nel browser; stampa un token valido un anno, non lo salva
```

Poi, da `scripts/loop/docker/`, crea un file `.env` (è nel `.gitignore`):

```bash
CLAUDE_CODE_OAUTH_TOKEN=<il token>
LEGACY_DIR=C:/percorso/del/progetto-legacy     # oppure /home/… su Linux
REPORTS_DIR=./reports
```

Copia la configurazione e riempi il target `legacy` (blocco e compiti):

```bash
cp ../loop.config.example.json ../loop.config.json
docker compose build
docker compose run --rm loop                       # tutto, come in loop.config.json
docker compose run --rm loop --only istruzioni,plugin --rounds 1   # un giro corto per cominciare
```

I report arrivano in `scripts/loop/docker/reports/run-<data>/`: `round-N.md` per ogni giro, `SUMMARY.md` alla fine, e per ogni scenario stream, trascrizioni e record dei task. Copie, clone e worktree restano nel volume Docker `loop-work`.

Consiglio di partire con `--only istruzioni,plugin --rounds 1` e `"model": "sonnet"` (o `haiku`): pochi minuti e pochi centesimi, e ti dice subito se login, plugin e hook funzionano nel tuo container.

## Gli scenari

| Scenario | Cosa prova | Progetti |
|---|---|---|
| `istruzioni` | Metodo dei marcatori degli Esperimenti 1-2, ripetuto a ogni giro: quali file arrivano al principale e allo specialista `block-src-billing`, con e senza `CLAUDE.md` alla radice, incluse le note scritte da `cantus notes`. Risponde a: **`AGENTS.md` di cartella senza `CLAUDE.md` alla radice** | toy |
| `plugin` | Prova C: plugin installato dal marketplace (`claude plugin marketplace add` + `install`), server MCP connesso e nomi degli strumenti, hook di avvio, pre-edit e post-edit, avviso di breaking change al principale; poi la stessa modifica fatta dallo specialista del blocco: **gli hook scattano nei sotto-agenti?** L'avviso arriva allo specialista? | toy, e i target con `"plugin"` |
| `task-mappa` | Prova D tramite l'API della mappa live, con un "utente" scriptato: piano approvato, poi chiede prima di modificare, modifica fuori perimetro negata, "Accept edits for the rest", diff, merge, test dopo il merge, Stop e Discard su un secondo task | tutti |
| `task-mappa-cli` | Lo stesso con il runner `claude-cli`, più un'attesa lunga (`longWaitMin`) prima della prima risposta: la richiesta non deve scadere | tutti |
| `task-autonomo` | Prova E: `cantus task <blocco> … --worktree --merge --verify`; rifiuto fuori perimetro, solo il comando di verifica consentito | tutti |
| `task-tutto` | `cantus task --all … --worktree --merge --verify`: deleghe ai `block-*`, merge, test, nessun errore nuovo in `cantus check` | tutti |
| `build-plan` | "Build the plan" sul toy con due blocchi senza codice (catalog, cart): costruiti, uniti, test verdi; **deleghe ad agenti generici** (punto aperto di `src/run/tasks.ts`); ordine delle ondate | toy |

Il progetto **toy** lo genera il loop: 4 blocchi (pricing, billing, users, api) in moduli ES, test accanto al codice, nessuna dipendenza. Per i tuoi progetti il loop fa un clone (l'originale non viene toccato), lancia `setup` se c'è, li mappa con Cantus se non hanno già `.cantus/model.json`, e committa la mappa nel clone. I compiti li scrivi tu nella configurazione: il loop non può inventare un compito sensato sul tuo codice.

### Nel tuo repository, con un worktree

Con `"worktree": true` il target non viene clonato: il loop lavora in worktree del tuo repository (`"path"`, la cartella che contiene `.git`), così il codice non esce da lì. Per ogni scenario:

- crea un worktree in `"worktreeDir"` (predefinita: accanto al repository, `<path>-cantus-loop`) su un branch nuovo `cantus-loop/<giro>/r<N>-<scenario>`, partendo dallo stesso commit per tutto il giro (`"ref"`, predefinito `HEAD`);
- i task di Cantus lavorano nei loro worktree (dentro `.git/cantus-worktrees`) e si uniscono a quel branch;
- a fine scenario toglie la cartella del worktree e **lascia il branch**: lo guardi dal tuo checkout con `git diff <ref>...cantus-loop/...` e lo cancelli quando vuoi (`git branch -D cantus-loop/...`).

La mappa (`.cantus/model.json` nella cartella del progetto) resta fuori dai branch: git la ignora solo per il loop, e Cantus la copia nei worktree dei suoi task. Così il branch contiene il lavoro degli agenti e la mappa non finisce in una cartella servita dal sito. Specialisti e note di blocco finiscono nel branch solo se il repository non li ignora già.

Se Cantus deve lavorare su una cartella del repository e non su tutto (per esempio `webroot/`), aggiungi `"subdir": "webroot"`: il worktree contiene comunque tutto il repository, ma mappa, task e verifiche partono da quella cartella, e i task di Cantus lavorano nella stessa cartella del loro worktree. Vale anche senza worktree.

Con `"refine": true` (o `{ "model": "sonnet", "budget": 2 }`) il loop lancia `cantus refine` sulla mappa prima del commit della mappa, per confrontare la mappa grezza con quella rifinita: due target con lo stesso `repo` e `ref` e nomi diversi, uno con il flag. Lo fa una volta per target e giro; gli altri scenari ripartono dalla stessa mappa rifinita. Il costo (`costUsd` di `refine --json`) conta nella spesa, e in `refine.json` accanto a `map-steps.json` trovi campi scritti e scartati.

Se la mappa che Cantus deduce dalle cartelle è troppo grossa per il compito, aggiungi i blocchi come faresti a mano: `"addBlocks": [{ "id": "js-listini", "name": "Listini", "include": ["js/listini"], "description": "…" }]`. Vince l'`include` più lungo, quindi il blocco nuovo si prende i suoi file e il resto resta dov'era.

Il tuo checkout, i file non committati, `.git/config` e `.git/info/exclude` non cambiano: identità dei commit (`Cantus loop`), `core.fileMode=false`, i file di Cantus da ignorare e i `safe.directory` arrivano a git dall'ambiente, solo per i processi del loop. Il test `loop: in worktree mode…` lo verifica.

Due cose da sapere:

- **Cartelle montate da Windows.** Se nel container le cartelle create sul montaggio non risultano del tuo utente, git rifiuta i worktree (`dubious ownership`). Il loop aggiunge da sé il repository e i propri worktree; quelli dei task di Cantus hanno nomi che nascono durante la prova e si possono coprire solo con un prefisso, che git legge dalla 2.46. Il loop controlla all'avvio e, se serve un git più nuovo, si ferma con un messaggio chiaro invece di fallire a metà.
- **Branch e worktree nascono nel container.** Durante la prova `git worktree list` dal tuo Windows mostra percorsi Linux: è normale, spariscono a fine scenario. Non lanciare `git worktree prune` da Windows mentre il loop gira.

I report e le trascrizioni (che contengono pezzi del tuo codice letti da Claude) vanno in `"reports"`: mettilo su una cartella che vedi. Restano anche in `"work"`, che puoi cancellare a fine prova.

Per il secondo progetto della roadmap (un repository TypeScript open source) aggiungi un target con `"repo": "<url git>"`, `"ref"` facoltativo, `"setup": "npm ci"`, `"verify": "npm test"` e i compiti.

Per provare il plugin su un target, scrivi quale API cambiare: `"plugin": { "file": "src/error.ts", "block": "h3", "change": "change the exported function createError in src/error.ts so that …" }`. Il file deve avere chiamanti in altri blocchi, altrimenti non c'è nessun avviso da aspettarsi; `block` è il blocco del file, il cui specialista fa la seconda modifica.

## Come leggere i risultati

- **Verifiche** (✓/✗): decidono se uno scenario passa e cosa vede il correttore. Alcune servono solo a dire che la prova è valida (per esempio "il principale ha delegato davvero allo specialista", "nessun plugin estraneo caricato"): se falliscono, l'esito di quel giro non dice niente.
- **Osservazioni**: rispondono alle domande aperte (hook nei sotto-agenti, `AGENTS.md`, deleghe a un agente generico, ordine delle ondate) senza giudicarle. Le risposte si leggono su più giri: `SUMMARY.md` ha una colonna per giro.
- **Uso spontaneo degli strumenti Cantus** (scenari plugin e task): quante chiamate `map`, `block_context`, `find_api`, `callers`... fa l'agente senza che nessuno glielo ordini, se ha guardato prima della prima modifica e se ha riletto il lavoro dopo l'ultima. È un'osservazione, non un giudizio: serve a capire se istruzioni, hook e riepilogo all'avvio bastano o se l'agente ignora gli strumenti.
- **Marcatori:** contano sia la trascrizione (il marcatore compare in ciò che è arrivato al modello, prima della delega per il principale) sia la dichiarazione dell'agente. La trascrizione vale di più: la dichiarazione può essere sbagliata.
- **Criteri di uscita** (in cima a ogni `round-N.md`): task su un blocco fino al merge e task su tutto il progetto fino al merge, per progetto; avviso di breaking change; nessun crash.

## La correzione automatica

Spenta per impostazione (`"fix": { "enabled": true }` o `--fix` per accenderla). Quando un giro ha verifiche fallite, una sessione di Claude Code lavora sul clone di Cantus del loop con queste regole: fase 1, quindi solo correzioni; un commit per correzione con un test di regressione; niente modifiche a `scripts/loop/`, niente test indeboliti, niente push; i fallimenti che non dipendono da Cantus (ambiente, comportamento di Claude Code, progetto di prova) e le scelte che spettano a te (`AGENTS.md` o `CLAUDE.md`, soglia di delega) finiscono in `LOOP-NOTES.md`, non nel codice. Bash è limitato a `npm test`, `npm run build`, `node` e ai comandi git di lettura e commit.

Dopo la sessione il loop rilancia `npm test` da sé: se è rosso annulla le correzioni (restano sul branch `loop/rejected-round-N`) e si ferma. Se è verde, il giro dopo usa il Cantus corretto, plugin compreso. Le correzioni tenute finiscono in `loop-fixes.bundle` nella cartella dei report: le porti nel tuo clone con `git fetch`, le rivedi e apri una PR per ciascuna. Il loop non pubblica niente.

## Costi e tempi

Ogni sessione ha un tetto (`budgetPerSession`, passato a `--max-budget-usd` e ai task) e tutto il loop si ferma a `budgetUsd`. Con l'abbonamento i dollari sono una stima di Claude Code, ma consumano comunque i limiti del piano. Un giro di prova in cloud sul toy con `haiku`: `istruzioni` + `plugin` circa $0,05 in un minuto e mezzo; `task-tutto` e `build-plan` circa $1,50 in tre minuti; i task dalla mappa un paio di minuti ciascuno. Sul progetto legacy e con un modello più grande costerà parecchio di più e non l'ho misurato: guarda la spesa nel primo `round-1.md` prima di lanciare tre giri.

## Cosa il loop non verifica (serve il tuo occhio)

- **La mappa nel browser:** chip, blocchi blu e ambra, riquadri, righe viola degli agenti. Il loop usa la stessa API della pagina, ma non guarda la pagina.
- **La qualità del lavoro:** controlla test, merge, perimetro e `cantus check`, non se il piano ha senso o se il codice è buono. Leggi i diff nei record dei task.
- **Windows nativo** (`claude.exe`, percorsi, hook fuori da WSL): il container è Linux. Il loop è Node puro e in teoria gira anche su Windows, ma non l'ho provato lì.
- **Le prove A, B, F, G** di HANDOFF (analisi, mappa live a mano, Codex, documenti del team): restano manuali (`scripts/collect-report.sh` per la A).
- **Le decisioni:** se "Accept edits for the rest" debba lasciar passare anche le modifiche fuori perimetro (oggi sì: dopo quel clic Cantus non chiede più nessuna modifica), se usare sempre `CLAUDE.md` per le note, la soglia di delega. Il loop ti dà i dati, non sceglie.
- **Le correzioni:** le rivedi tu prima di aprire le PR.

## Opzioni

```
node scripts/loop/loop.mjs [--config <file>] [--rounds n] [--only a,b] [--targets a,b] [--fix | --no-fix] [--work <dir>]
```

Tutte le chiavi di configurazione con i valori predefiniti sono in `DEFAULTS` in `loop.mjs`; `loop.config.example.json` ha quelle che di solito si cambiano. `"model"` sceglie il modello di tutte le sessioni (predefinito: quello di Claude Code); `"runner"` sostituisce l'Agent SDK con un modulo (lo usano i test del loop, `tests/loop.test.mjs`).
