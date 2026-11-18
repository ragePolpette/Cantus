# `cantus init` — cosa deve fare

Come inizializzare Cantus in un progetto.

## Da dove si parte (i passi manuali)

Su un progetto nuovo, puoi lanciare a mano, con `-C <cartella>` quando non è nella cartella del progetto:

1. `cantus analyze --write -C <progetto>`: crea o aggiorna `.cantus/model.json` (nomi, descrizioni, livelli e regole scritti a mano restano).
2. `cantus check -C <progetto>`: confronta codice e mappa; esce 1 se ci sono errori.
3. `cantus serve -C <progetto>`: la mappa live su `http://127.0.0.1:4321` (prossima porta libera). **Non apre il browser**; l'indirizzo va copiato.

In più, per chi usa un agente: `cantus notes`, `cantus agents`, registrare l'MCP (`claude mcp add --scope project cantus -- node /percorso/dist/cli.js mcp`, oppure il blocco `[mcp_servers.cantus]` di Codex) o installare il plugin. Sono sei-otto comandi da conoscere, con percorsi assoluti, prima di vedere la mappa.

## Cosa fa `cantus init [-C <progetto>]`

Un solo comando, nell'ordine, **idempotente** (rilanciato non cambia niente di ciò che è già a posto e non sovrascrive ciò che l'utente ha scritto). Ogni passo stampa una riga: fatto, già a posto, saltato (perché) o fallito (cosa fare).

**0. Controlli iniziali, senza scrivere niente.**
- Node 20.19+ della serie 20.x oppure Node 22.12+; se no, dice quale ha trovato e si ferma (exit 1) prima di importare parser, hook e SDK.
- `git` nel PATH e cartella dentro un repository: se manca, **continua** (mappa, briefing e `check` funzionano) e dice cosa si perde (`diff`, `verify`, worktree, compiti isolati). Se `-C` è una sottocartella del repository, lo dice e indica la radice.
- Quanti file sono leggibili e in che linguaggi. Se sono **zero**, si ferma con exit 1 senza creare niente e dice cosa ha trovato (es. «solo Kotlin e Ruby: non letti, vedi i linguaggi supportati»). Se il progetto è enorme (migliaia di file) avvisa che la prima analisi è lunga e che le successive usano la cache.
- `.archflow/` di una versione vecchia: la migrazione a `.cantus/` è quella già automatica.
- Errori di lettura o parsing: exit 1 prima di salvare mappa, note o specialisti, anche con `--yes`. Un avvio normale può aggiornare cache e log diagnostici; `--dry-run` non scrive nemmeno quelli. Mappa e note già presenti restano intatte. I finding architetturali sono un caso diverso e non fanno fallire l'inizializzazione.

**1. Mappa** (= `analyze --write`). Crea `.cantus/model.json` se manca, altrimenti lo aggiorna come oggi. Scrive anche `.cantus/.gitignore` (già automatico: cache, log, run e pagine generate fuori da git; `model.json` e le note restano tracciabili). **Non tocca il `.gitignore` della radice.** Stampa file letti, blocchi, linguaggi e il tempo.

**2. Controllo** (= `check`). Stampa il riepilogo (errori, avvisi, informazioni) e le prime tre righe, con rimando a `cantus check --full`. **Non fa fallire `init`**: su un progetto appena mappato i finding sono attesi. Fallisce solo se l'analisi stessa non finisce.

**3. Scritture nel progetto fuori da `.cantus/`: chiede, non le dà per scontate.** Toccano file tracciati e in un progetto grande sono decine di file (con 78 blocchi, 78 note), quindi senza `--yes` si dice quanti e dove e si chiede conferma (in un terminale non interattivo: no, a meno di `--yes`).
- Note per blocco (= `notes`: `AGENTS.md`, o `CLAUDE.md` se la radice ne ha uno, nelle cartelle dei blocchi, e il puntatore alla radice).
- Specialisti di Claude Code (= `agents`: `.claude/agents/block-*.md`), solo se `claude` è nel PATH o c'è già una cartella `.claude`.

**4. Agente: registra l'accesso a Cantus, una volta sola.**
- **Claude Code.** Se il plugin `cantus` è già installato non registra l'MCP (il plugin ha il suo, due copie duplicano gli strumenti). Se non lo è, stampa i due comandi del plugin (`claude plugin marketplace add ragePolpette/Cantus`, `claude plugin install cantus@cantus`: sono il percorso consigliato, danno anche hook e skill) e, a richiesta (`--mcp`), registra solo l'MCP con `claude mcp add --scope local`, **per l'utente e non in `.mcp.json`**: il comando contiene il percorso assoluto di questa macchina e non va nel repository. `--scope project` solo se lo chiede l'utente.
- **Codex**, se `codex` è nel PATH: la sua configurazione è globale, quindi un solo progetto per voce. Stampa il blocco `[mcp_servers.cantus]` con `mcp --read-only -C <progetto>` e **non lo scrive**: la configurazione è globale e la modifica la fa la persona.
- Il comando registrato è quello con cui è partito `init` (percorso di `dist/cli.js` o `cantus` se è nel PATH). Finché non c'è npm questo è il pezzo più fragile; i test lo coprono con un percorso con spazi e, su Windows, con `claude.exe`/`codex.cmd`.

**5. Apre la mappa live.** Avvia `serve` (come `cantus serve`, resta in primo piano, Ctrl+C per fermarlo), stampa l'indirizzo **e apre il browser** quando c'è un terminale interattivo. Se per quel progetto c'è già un server vivo (`.cantus/serve.json` con un processo attivo) non ne avvia un secondo: stampa l'indirizzo di quello. `--no-serve` salta il passo (per script e CI).

**6. Riepilogo finale.** I file scritti (con percorso), cosa è stato saltato e perché, i tre comandi per proseguire (`cantus context <blocco>`, `cantus impact <blocco>`, `cantus diff`), e la riga per installare il plugin se manca.

## Opzioni

| Opzione | Effetto |
|---|---|
| `-C <cartella>` | Il progetto (come negli altri comandi). |
| `--dry-run` | Stampa cosa farebbe, **senza scrivere niente** e senza avviare il server. |
| `--yes` | Dà per accettate le scritture del punto 3 (note e specialisti), non la registrazione MCP. |
| `--mcp` | Registra l'MCP in Claude Code, per l'utente e questo progetto (punto 4). Per Codex stampa solo il blocco. |
| `--no-serve` | Non avvia la mappa. |
| `--no-open` | Avvia la mappa ma non apre il browser. |

Exit code: 0 completato (anche con finding o passi saltati); 1 controlli iniziali non superati o analisi non finita; 2 uso sbagliato.

## Cosa non fa

Non pubblica, non crea il repository git, non committa, non modifica il `.gitignore` della radice né il codice del progetto, non installa il plugin né Node (stampa i comandi). Non lancia agenti né spende crediti: niente `refine`, niente compiti. Non fa il confronto con la mappa di un altro progetto.

## Come si prova (criteri di accettazione)

1. **Progetto di prova pulito** (il negozio dimostrativo dei test): `cantus init --yes --no-serve` crea mappa, note e specialisti; un secondo giro **non cambia `git status`** né `.cantus/model.json`.
2. `--dry-run` non scrive nemmeno un file (confronto del filesystem prima/dopo).
3. Cartella **senza git**: completa, con l'avviso di cosa manca. Cartella **senza file letti**: exit 1, niente creato. **`.archflow/` presente**: migrata.
4. **Plugin già installato**: nessuna registrazione MCP doppia. **Server già vivo**: nessun secondo `serve`.
5. Percorso con **spazi** e, su Windows, `claude.exe` e `codex.cmd`: prova su Windows nativo.
6. **Cinque minuti**: da un clone pulito, `pnpm install && pnpm build && npm link && cantus init` fino alla mappa live con i blocchi in meno di cinque minuti su un progetto di 50-300 file, cronometrato.

Provati in `tests/init.test.mjs` con un finto `claude` nel PATH (punti 1-4); restano i punti 5 e 6 (compatibilità e tempo di avvio) su Windows nativo. Una PR piccola per questi punti, con il runner finto dove serve un agente; la registrazione MCP si prova con un finto `claude` e un finto `codex` nel PATH.
