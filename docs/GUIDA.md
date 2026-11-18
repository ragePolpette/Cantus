# Cantus — guida d'uso

Come si usa Cantus, dall'installazione al lavoro di tutti i giorni. È scritta per chi lo usa; la descrizione tecnica completa (in inglese) in [REFERENCE.md](REFERENCE.md).

Cantus è ancora un progetto in corso, senza una versione pubblica: dove una cosa non è provata, la guida lo dice. I limiti generali sono nel [README](../README.md).

## Indice

1. [A cosa serve](#1-a-cosa-serve)
2. [Installare](#2-installare)
3. [Il primo giro nel tuo progetto](#3-il-primo-giro-nel-tuo-progetto)
4. [Usarlo con Claude Code](#4-usarlo-con-claude-code)
5. [La mappa viva](#5-la-mappa-viva)
6. [Dare lavoro dalla mappa](#6-dare-lavoro-dalla-mappa)
7. [Un progetto nuovo](#7-un-progetto-nuovo)
8. [Prima di una pull request](#8-prima-di-una-pull-request)
9. [Sistemare la mappa](#9-sistemare-la-mappa)
10. [Capire i problemi segnalati](#10-capire-i-problemi-segnalati)
11. [Se qualcosa non funziona](#11-se-qualcosa-non-funziona)

## 1. A cosa serve

Cantus legge il codice e lo divide in **blocchi** (moduli), con le **frecce** che dicono quale blocco usa quale. Per ogni blocco sa cosa esporta e chi lo chiama, anche dal front end al backend (una `fetch` è collegata all'endpoint che la serve). Da qui nascono tre cose:

- **una mappa** che vedi nel browser, per avere in testa com'è fatto il progetto mentre gli agenti scrivono codice;
- **un briefing per blocco** (al massimo circa 14k token) che l'agente legge prima di lavorarci, al posto di una `CLAUDE.md` enorme;
- **avvisi** quando una modifica rimuove o cambia un export che altri blocchi usano, con i punti da aggiornare.

Cosa **non** è: non è un altro agente di programmazione. Dà struttura e contesto agli agenti che già usi (Claude Code soprattutto) e a te. La mappa è una guida, non un vincolo: se il codice la supera, è un'informazione e non un errore.

## 2. Installare

Servono Node 20.19+ della serie 20.x oppure Node 22.12+ e `git`, come richiesto dai parser OXC. Cantus non è su npm: si installa dal repository.

```bash
git clone https://github.com/ragePolpette/Cantus.git && cd Cantus
pnpm install && pnpm build      # `pnpm install` compila da solo
npm link                        # mette `cantus` nel PATH
cantus --help
```

Se non vuoi `npm link`: `alias cantus="node $(pwd)/dist/cli.js"`. Per aggiornare: `git pull`, poi `pnpm install` (ricompila).

**Il plugin di Claude Code** chiama il comando `cantus`, quindi installa prima quello:

```bash
claude plugin marketplace add ragePolpette/Cantus
claude plugin install cantus@cantus
```

Dopo un aggiornamento del repository: `claude plugin update cantus@cantus` e riapri la sessione.

**Il nome del repository.** Dal 29/10 il repository si chiama `cantus`. Se hai un checkout fatto quando si chiamava `ArchFlow`, GitHub reindirizza il vecchio indirizzo, ma conviene aggiornare il remote: `git remote set-url origin https://github.com/ragePolpette/Cantus.git`.

**Windows.** In PowerShell, con pnpm alla versione fissata dal progetto (altre versioni rovinano il lockfile):

```powershell
npm install -g pnpm@10.34.6
git clone https://github.com/ragePolpette/Cantus.git C:\Tools\cantus
cd C:\Tools\cantus
pnpm install
npm link
claude plugin marketplace add C:\Tools\cantus
claude plugin install cantus@cantus
```

Se `cantus` non viene trovato, controlla che `%APPDATA%\npm` sia nel PATH e riapri il terminale. Aggiungere il marketplace da un percorso locale significa che il plugin arriva da quella cartella: dopo un `git pull` esegui `claude plugin update cantus@cantus` e riapri la sessione. Il lanciatore del plugin (`plugin/scripts/cantus.mjs`) è fatto apposta per Windows, dove Claude Code non sa avviare un `cantus.cmd`, ma Windows nativo con un Claude Code vero **non è ancora provato**: la strada provata è Linux, anche WSL2 o un container.

## 3. Il primo giro nel tuo progetto

Fallo **prima** di aprire Claude Code nel progetto:

```bash
cd il-tuo-progetto
cantus analyze --write    # deduce i blocchi dalle cartelle e salva la mappa (.cantus/model.json)
cantus check              # segnalazioni e problemi incontrati leggendo il codice
cantus notes              # note per blocco, in AGENTS.md nella cartella di ogni blocco
cantus agents             # uno specialista Claude Code per blocco, in .claude/agents/
```

La radice del progetto, per Cantus, è la cartella da cui lanci il comando (o `-C <cartella>`). Se il tuo repository è grande e il codice che ti interessa sta in una sottocartella, lanciali da lì, oppure limita l'analisi con `analysis.include` (vedi [sezione 9](#9-sistemare-la-mappa)).

Cosa è successo:

- **`.cantus/model.json`** è la mappa: blocchi, frecce, livelli, i nomi e le descrizioni che scrivi tu. Quando rilanci `cantus analyze --write` aggiorna la mappa dal codice e **tiene quello che hai scritto**. I blocchi nuovi arrivano come "non assegnati" a un livello.
- **`.cantus/analysis.log`** raccoglie tutto quello che l'analisi ha incontrato (errori di sintassi, import che non si risolvono, file non letti). Un file rotto non ferma mai l'analisi.
- **Le note** (`cantus notes`) sono una sezione generata dentro l'`AGENTS.md` di ogni blocco (o nel suo `CLAUDE.md`, se la cartella ne ha uno con testo tuo). Se il progetto ha un `CLAUDE.md` alla radice, Claude Code non legge nessun `AGENTS.md`: Cantus crea in ogni cartella un `CLAUDE.md` di una riga (`@AGENTS.md`) che lo importa, così le note stanno in un posto solo e le vedono sia Claude Code sia Codex. Quello che scrivi tu fuori dai marcatori non viene toccato. Claude Code e Codex le caricano solo quando lavorano in quella cartella.
- **Gli specialisti** sono sotto-agenti `block-<id>`, ognuno col briefing del proprio blocco. `cantus analyze --write` crea anche la cartella `.claude/agents`: serve che esista **prima** dell'avvio della sessione, perché Claude Code carichi a caldo gli specialisti scritti dopo.

**Cosa mettere in git.** `.cantus/model.json` e le note sì, se la squadra deve condividerli; `.cantus/cache/` e `.cantus/*.log` no (si ricostruiscono, e altrimenti contano come lavoro non committato). Cantus scrive da solo `.cantus/.gitignore` (`cache/`, `runs/`, `*.log`, `*.html`) la prima volta che salva qualcosa di ricostruibile; se il file c'è già non lo tocca. Se il tuo repository tracciava già la cache, `check` segnala `tracked-cache` con il comando per smettere (`git rm -r --cached .cantus/cache .cantus/runs`): senza, due worktree che si uniscono vanno in conflitto su quei file.

**Raffinare con l'AI (facoltativo).** `cantus refine` chiede a Claude Code, in sola lettura, una descrizione per blocco, un livello per i blocchi non assegnati e qualche nota. È sperimentale: su due progetti non ha mostrato vantaggi misurabili, quindi guarda sempre cosa ha cambiato. Non parte mai da solo. I cambiamenti che propone ma non applica (dividere, unire, escludere un blocco, un livello) non si perdono: restano in `.cantus/cache/refine-suggestions.json` (fuori da git) e `check` e la mappa li mostrano come segnalazioni `refine-suggestion`, ognuna con un id, finché non li chiudi con `cantus suggestions dismiss <id>...|all` (`cantus suggestions` elenca quelli aperti). Un agente li vede e può applicare, con gli strumenti della mappa, quelli che approvi, poi li chiude con `dismiss_suggestion`.

## 4. Usarlo con Claude Code

Con il plugin installato e la mappa fatta, **apri `claude` nella cartella del progetto** e lavori come sempre. Cantus lavora in due modi.

### Da solo, con gli hook

- **All'avvio della sessione** l'agente riceve un riassunto della mappa (se è piccola: cosa fa e cosa usa ogni blocco) e la regola su chi lavora: un compito che tocca più blocchi va agli specialisti dei blocchi, uno dentro un solo blocco può farlo l'agente principale.
- **Prima di una modifica**: a quale blocco appartiene il file, quali altri blocchi ne chiamano gli export, quali file di solito cambiano insieme a questo nella storia git. La stessa nota per lo stesso file compare una volta per sessione.
- **Dopo una modifica**: se un export usato da altri blocchi è stato tolto o cambiato, un avviso con i punti di chiamata da aggiornare.

Gli hook aggiungono solo contesto: non bloccano mai una modifica e non ne approvano nessuna.

### Su richiesta, con gli strumenti MCP

L'agente può chiamare gli strumenti di Cantus (`map`, `block_context`, `find_api`, `callers`, `trace`, `impact`, `diff`, `check`, `review_changes` e gli altri: elenco in [REFERENCE.md](REFERENCE.md)). Quelli che contano di più:

- `map` per orientarsi invece di leggere l'albero;
- `block_context` prima di lavorare su un blocco;
- `find_api` prima di scrivere un helper, perché potrebbe esistere già;
- `callers` e `impact` prima di cambiare la firma di un export.

La skill `cantus` del plugin insegna all'agente quando usarli. Se vuoi che lo faccia, dillo: *"usa lo strumento `block_context` di Cantus per `src-orders`, poi aggiungi…"*.

### Lavoro che attraversa più blocchi

L'agente principale coordina e gli specialisti `block-<id>` lavorano: prima i blocchi che forniscono, poi quelli che li usano, in parallelo dove sono indipendenti, nella cartella del progetto (senza `isolation: "worktree"`: il lavoro di uno specialista in un worktree resta non committato lì e la mappa non lo vede). Per un lavoro isolato avvia un compito dalla mappa con l'opzione worktree. Se hai aggiunto blocchi dopo l'avvio della sessione, lancia **`/cantus:agents`**: scrive gli specialisti mancanti. Se la cartella `.claude/agents` era nuova, la sessione li carica solo dopo un riavvio (`claude --continue` tiene la conversazione); nel frattempo lo strumento `specialist_prompt` dà il testo di uno specialista da passare a un sotto-agente generico.

### Con Codex o un altro client MCP

`cantus mcp` parla MCP su stdio. Per Claude Code senza plugin: `claude mcp add --scope project cantus -- node /percorso/di/cantus/dist/cli.js mcp`. Per Codex c'è la configurazione in [REFERENCE.md](REFERENCE.md#use-it-from-a-coding-cli-mcp). **Codex non è mai stato provato davvero**: l'unico agente verificato è Claude Code.

## 5. La mappa viva

```bash
cantus serve        # http://127.0.0.1:4321 (o la prima porta libera)
```

Con il plugin attivo non serve lanciarlo: l'agente apre la mappa con lo strumento `open_map` e te ne dà l'indirizzo. Il server ascolta solo su `127.0.0.1`, e le modifiche alla mappa richiedono un token che ha solo la pagina servita.

**Leggerla.** Ogni blocco è una scheda, raggruppata per livello, con le frecce di dipendenza. Un clic apre il briefing del blocco e i suoi file; un doppio clic mostra i file dentro il blocco, con le frecce fra file. Shift o Ctrl+clic su più blocchi li tratta come un unico ambito (budget di contesto, cosa usano da fuori, chi li chiama) e puoi salvarlo come **gruppo**. La mappa si aggiorna da sola quando il codice cambia, e non si ricarica mentre hai un campo, un form o un trascinamento a metà.

**Le modifiche.** La scheda **Modifiche** accanto a **Mappa** elenca i file cambiati dall'ultimo commit, per blocco, con il numero di righe, l'agente che ci ha scritto (le righe degli agenti sono evidenziate in viola) e i punti di chiamata da controllare. Un clic su un file (o il pulsante **Apri** sulla sua scheda dentro un blocco, e nel pannello del file selezionato) lo apre in tre modi: **Differenze** (solo i cambiamenti), **Affiancato** (vecchio a sinistra, nuovo a destra), **File** (com'è adesso). I tasti `p` e `n` vanno al file precedente e al successivo. Da qui:

- **Apri in VS Code** apre il file alla prima modifica (non funziona se Cantus gira in un container o in WSL e VS Code sta sull'host);
- **Chiedi a Claude** (o la ✎ accanto al numero di riga, anche con una selezione) scrive alla sessione aperta una richiesta su quelle righe, sul blocco che possiede il file.

La voce "N modifiche all'API · M punti di chiamata da controllare" nei **Segnali** apre l'elenco degli export cambiati o tolti che altri blocchi usano.

**Chi ha scritto cosa.** Gli hook del plugin avvisano la mappa prima e dopo ogni modifica, e i compiti avviati dalla mappa riportano le proprie. Il registro sta in `.cantus/cache/edit-ledger.json` (fuori da git): una nuova sessione lo rilegge, e un commit lo svuota delle righe commesse. Segue le righe solo a mappa aperta: quelle scritte a mappa chiusa, da te o da comandi di shell, appaiono come modifiche semplici, e un commit modificato, annullato o messo da parte non restituisce i crediti. Un robottino con un bagliore verde segna i blocchi dove sta lavorando uno specialista (gli eventi di avvio e fine dello specialista non sono ancora stati provati con un Claude Code vero; la mappa ricava lo stesso segnale anche dalle sue modifiche).

**Statistiche.** La scheda **Statistiche** (7, 30 o 90 giorni) e `cantus stats [--days n] [--json]` dicono come vengono usati i briefing e dove mancano: in cima «Dove aggiungere contesto» (per esempio un file che uno specialista apre fuori dal suo blocco tre volte o più, o una ricerca di `find_api` senza risultato), poi blocchi, strumenti e compiti dalla mappa (token e costo reali, da `.cantus/runs`). Il registro è `.cantus/cache/usage.jsonl` (fuori da git, ruota a 2 MB): strumenti, dimensioni in token (stimate), percorsi di file e le prime parole di una nota; mai prompt né contenuto dei file. `CANTUS_STATS=off` non registra nulla.

**L'intestazione e la barra in basso.** L'intestazione resta su una riga: progetto e worktree, le schede *Mappa*, *Modifiche* e *Statistiche*, il pulsante **Worktree**, il pulsante **Segnali** e l'ingranaggio delle impostazioni. **Segnali** raccoglie in un solo posto, con un numero (rosso se c'è un errore, ambra altrimenti), quello che prima erano chip separati: drift ed errori, avvisi, mappa dedotta, modifiche all'API e problemi d'analisi. Il clic apre nel pannello l'elenco: gli avvisi con i loro blocchi (un clic apre il blocco) e un collegamento alle liste delle modifiche all'API e dei problemi d'analisi. I numeri informativi (blocchi, dipendenze, file modificati, token, data, *live*) stanno nella barra in basso. La legenda dei colori e delle linee è dietro il **?** a destra.

**Lingua e aspetto.** Nelle impostazioni (l'ingranaggio in alto a destra) c'è il selettore **Lingua** (italiano e inglese; per default quella del browser, la scelta resta in quel browser). Le segnalazioni dell'analisi sono tradotte; non lo sono gli errori grezzi dei compilatori, la riga di comando, gli strumenti MCP e i briefing. Lo stile è "Disegno tecnico"; sopra la lingua c'è il selettore **Tema** (Sistema, Chiaro, Scuro): per default segue il sistema, la scelta resta in quel browser.

**Senza server.** `cantus view` scrive una mappa statica in `.cantus/view.html` (senza compiti né aggiornamenti dal vivo): utile da condividere. `cantus view --svg` scrive invece un'immagine, `.cantus/map.svg`: le corsie, i blocchi larghi quanto il loro codice, le frecce, le segnalazioni, i punti caldi e i blocchi che la modifica in corso tocca (contorno blu); un solo file senza script né font da caricare, che GitHub mostra in un README (`--width <px>` per la larghezza, `--base main` per segnare ciò che il ramo ha cambiato rispetto a `main`, utile per una pull request). `cantus mermaid --markdown` stampa il grafo dei blocchi in Mermaid, da incollare in una pull request o in un README.

## 6. Dare lavoro dalla mappa

Tre parole bastano: **worktree** (dove si lavora), **capo** (la sessione Claude Code aperta in quel worktree, con gli specialisti dei blocchi come sub) e **richiesta** (cosa chiedi al capo). La mappa è uno specchio di questo: **non lancia agenti, non apre terminali, non approva permessi e non legge le conversazioni**. Il ciclo senza presidio (compiti, piani, cancello, verificatore) vive solo da riga di comando (6.3 e 6.4).

### 6.1 Una pagina: dove va il lavoro

Il pulsante **Worktree** in intestazione apre una colonna con una scheda per ogni worktree del repository: quello della mappa che guardi per primo (*questa mappa*), poi gli altri per urgenza. Il nome è un collegamento alla mappa di quel worktree, se è aperta, e porta con sé il blocco selezionato. Ogni scheda ha uno stato:

| Stato | Vuol dire |
|---|---|
| **lavora** | il capo è nel mezzo di un suo turno: l'ultimo segno è un tuo messaggio o una chiamata a uno strumento, anche se tace da minuti (una suite di test lunga non lo ferma). Dopo 15 minuti di silenzio passa a *aspetta te · in silenzio da N min* |
| **appena aperto** | la sessione c'è ma non ha ancora fatto niente che la mappa abbia sentito: non tocca a te |
| **aspetta te** | il capo ha finito il suo turno senza un resoconto valido, o ha fatto un commit dopo averlo dato; vale anche per un'approvazione di setup in attesa (in cima alla colonna) |
| **chiede un permesso** | Claude Code ha mostrato al capo (o a un suo specialista) la richiesta di permesso per uno strumento e dopo non è successo niente: tocca a te rispondere nel terminale. Torna *lavora* appena il capo usa il prossimo strumento |
| **da rivedere** | il capo ha finito il suo turno e il resoconto di `worktree_done` riguarda il commit su cui il worktree si trova adesso; oppure nessun capo aperto e ci sono commit o file non committati. La scheda dà il comando di verifica anche a capo aperto |
| **unito** | tutto è già nel ramo principale |
| **spento** | nessun capo e niente da rivedere (*spento · pronto* se Cantus l'ha appena creato) |

Lo stato viene da **ciò che il capo ha fatto**, non dal silenzio: gli hook del plugin dicono alla mappa se il capo ha ricevuto un messaggio (`prompt`), ha usato uno strumento (`tool`) o ha chiuso il turno (`stop`), e la mappa legge il resoconto che il capo dà con `worktree_done`. Un nuovo messaggio dopo il resoconto riporta il worktree a *lavora*. Se il plugin è vecchio e non dice cosa ha fatto, vale la regola di prima: *lavora* se si è fatto sentire nell'ultimo minuto e mezzo, altrimenti *aspetta te*. Un permesso lo dice l'hook `PermissionRequest` del plugin, che Claude Code esegue nel momento in cui mostra la richiesta (l'hook `Notification` della stessa richiesta aspetta circa sei secondi e, in un terminale, scatta solo se non stai scrivendo: per questo non è stato usato). **Limiti:** il permesso per la richiesta di rete di un comando in sandbox non passa da quell'hook; e `Stop`, per la documentazione di Claude Code, non scatta quando interrompi tu il turno: un capo interrotto resta *lavora* fino ai 15 minuti, finché non scrivi un nuovo messaggio. Ogni server si annuncia in `<cartella git>/cantus-servers/` (fuori dal progetto, senza token); un worktree è «acceso» se ha una sessione col plugin, anche fuori da `.cantus/worktrees`; una mappa aperta con `cantus serve` non accende niente.

**Per dare un lavoro**, seleziona un blocco, un gruppo o più blocchi, scrivi cosa serve e scegli dove:

- **Qui, in questo worktree**: richiesta in coda al capo di questa mappa (richiede il plugin con la mappa aperta dalla sessione). Il capo la dà allo specialista del blocco, o la fa da sé se è una modifica di poche righe.
- **In «ramo»**: una voce per ogni altro worktree con un capo aperto. La richiesta va alla mappa di quella sessione, che la mette in coda.
- **In un nuovo worktree**: Cantus lo crea con le regole di 6.2, scrive il compito e dà **due righe da incollare in un terminale** (`cd` nella cartella e `claude "Leggi … e fai il compito"`). La sessione che apri lì è il capo di quel worktree. La scheda di un worktree senza capo ha *Copia per il terminale*: le stesse due righe finché nessuno ha aperto la sessione, poi `cd` e `claude --continue`.

**La richiesta e il capo.** Il capo la riceve col tuo messaggio successivo, dopo la sua prossima chiamata a uno strumento, quando sta per fermarsi o subito, se c'è il canale. La conferma (`request_accept`, una riga su cosa ha capito) e la chiusura (`request_done`) le dà lui, con i **suoi** permessi e il **suo** contesto. Stati: *In coda*, *Consegnata*, *Presa*, *Fatta*; se in un minuto non c'è conferma compare **Reinvia**. **Limite:** un capo fermo, in attesa di te e senza canale, non si sveglia dall'esterno; la richiesta aspetta il tuo prossimo messaggio. Per la consegna immediata: `claude --dangerously-load-development-channels plugin:cantus@cantus` (anteprima di ricerca, solo sessioni interattive; su Team ed Enterprise lo abilita un amministratore). Il canale e la consegna col messaggio successivo sono provati con un Claude Code vero; la consegna a metà lavoro e a fine turno e la conferma automatica **non ancora**.

**Un worktree per la tua sessione.** Il file del compito dice alla sessione chi è (il capo), come consegnare (commit sul ramo, `check`, poi `worktree_done` con riassunto e test fatti) e dove ritrova la richiesta. Prima di delegare, a meno di un cambio di poche righe, gli chiede di scrivere in `.cantus/cache/session-plan.md` (la cartella è ignorata da git) i criteri di accettazione, ognuno controllabile con un comando o leggendo un file, un pezzo per blocco con le firme esatte che i blocchi si scambiano e cosa non va toccato, e di dare a ogni specialista il suo pezzo; dopo una verifica, un finding confermato torna allo specialista del blocco. Cantus **non controlla** che il piano sia stato scritto né il suo formato; se c'è, la verifica lo riceve come «criteri che il capo ha scritto prima del lavoro» e li controlla nei due sensi (il lavoro li rispetta? coprono ciò che era stato chiesto?). Il compito «Costruisci il piano» non ha questa sezione. Alla consegna Cantus aggiunge al resoconto **chi ha scritto cosa**: quanti file distinti ha modificato il capo e quanti ciascuno specialista, letti dal registro d'uso del worktree (`.cantus/cache/usage.jsonl`, scritto dagli hook; `agent` è valorizzato quando a modificare è uno specialista). La scheda mostra una riga, *Scritto da: capo 2 file · block-pricing 5 file*, senza avvisi, e la stessa riga va al verificatore. **Limiti:** le modifiche fatte con la shell (`sed`, script) non passano dagli hook e non sono contate; una modifica rifiutata può risultare nel registro; il registro si scrive solo dopo la prima analisi del worktree (la prima chiamata di uno strumento Cantus), quindi le modifiche prima non ci sono; con `CANTUS_STATS=off` o senza registro la riga non compare. Il resoconto compare nella scheda e il worktree passa a «da rivedere»; se la sessione non lo chiama, lo stato lo danno i commit. Dal pannello del worktree *Unisci nel tuo ramo* lo porta nel tuo ramo e lo toglie, *Scarta* lo butta; Cantus rifiuta entrambi se c'è lavoro non committato. L'unica domanda che la pagina fa è il sì ai comandi di setup. Se non indichi `path`, la cartella è `.cantus/worktrees/<nome>` (ignorata da git con `.git/info/exclude`, non scansionata dall'analisi): Claude Code non scrive dentro `.git`.

**Più worktree sullo stesso progetto.** `cantus worktrees` li elenca con ramo, commit avanti, blocchi modificati (anche non committati), indirizzo della mappa e i blocchi toccati da più di un worktree, dove i merge si incontreranno. Il modulo del compito avverte se un altro worktree creato da Cantus lavora già sugli stessi blocchi. I worktree creati da Cantus sono ricordati in `<cartella git>/cantus-worktrees.json` (mai nei commit); `cantus worktrees --clean`, o *Ripulisci* nella colonna, toglie solo gli **uniti** e le voci orfane, mai lavoro non unito o non committato.

**Il pannello del blocco.** Risponde prima a tre domande: *Chi ci lavora* (i worktree che lo toccano, con lo stato), i *Findings* del blocco e il campo per chiedere un lavoro lì. Il briefing che l'agente riceve (budget, documenti, codice, vicini, chiamanti, raggio d'azione, pacchetti esterni, comando per il tuo agente) sta in una piega chiusa, *Cosa vede l'agente · briefing ~N token*.

### 6.2 Le regole del nuovo worktree

Senza regole, un worktree parte dal ramo principale del repository (non da dove sei: il lavoro non si porta dietro le tue modifiche in corso). Nel riquadro chiuso *Regole del nuovo worktree*, in fondo alla colonna, si cambiano *Parte da*, il modello del ramo e della cartella, i file da copiare e da collegare (*Scegli una cartella…* scrive la regola di `path`). I comandi (`setup`, `script`) lì si vedono soltanto: si cambiano solo nel file `.cantus/model.json`.

```json
"agent": {
  "worktree": {
    "base": "default",
    "branch": "agent/{block}/{slug}",
    "path": "../{project}-wt/{slug}",
    "copy": [".env"],
    "link": ["packages"],
    "setup": ["pnpm install --offline"]
  }
}
```

- `base`: `default` (il ramo principale: `origin/HEAD`, poi `main`, poi `master`), `HEAD`, o un ramo, un tag, un commit. Cantus non fa `fetch`.
- `branch` e `path`: modelli con `{id} {block} {slug} {user} {date} {project} {repo}`; `path` parte dalla cartella principale del repository. Un nome già preso diventa `-2`, `-3`. Se il `path` ha virgolette, apici inversi o `$`, Cantus lo rifiuta (finisce nelle righe `cd` da incollare).
- `copy`: file e cartelle copiati nel worktree (ciò che git ignora e serve, come `.env`); Cantus legge anche `.worktreeinclude` (sintassi `.gitignore`, solo file ignorati).
- `link`: collegati ai tuoi invece che copiati (giunzione su Windows), per cartelle grosse e statiche. Non metterci dove il `setup` scrive; Cantus li toglie prima di cancellare il worktree.
- `setup`: comandi lanciati nel nuovo worktree (`setupTimeoutSeconds`, 600 per ciascuno). **Ogni volta chiedono conferma** (in cima alla colonna): girano sul tuo computer e la mappa si condivide. Da riga di comando `--run-setup`.
- `script`: un tuo eseguibile (`.ps1`, `.sh`, `.cmd`, `.mjs`…) che **crea lui il worktree** al posto delle regole di Cantus; con lo script `copy`, `link` e `setup` non valgono. Riceve il **nome del worktree** (`name`, predefinito `{slug}`) e il **nome del ramo**, e nell'ambiente `CANTUS_BASE`, `CANTUS_BASE_REF`, `CANTUS_PATH`, `CANTUS_TASK`, `CANTUS_BLOCKS`, `CANTUS_ROOT`. Parte nella cartella principale e deve stampare come **ultima riga** la cartella del worktree (se no, Cantus cerca il worktree con quel ramo). Chiede conferma ogni volta. Un `.ps1` parte con `pwsh` o, su Windows, `powershell.exe`; un `.sh` su Windows con il bash di Git for Windows, non con quello del PATH (spesso il lanciatore di WSL).
- `scriptArgs`: argomenti dello script, se non vuole nome e ramo in quest'ordine; segnaposto `{name}`, `{branch}`, `{base}`, `{baseRef}`, `{path}`. Per un `.ps1` con parametri con nome: `["-Branch", "{branch}", "-BaseBranch", "{baseRef}"]`.
- `removeScript` e `removeArgs` (predefinito `["{path}"]`): uno script che **toglie** il worktree quando si unisce o si scarta. Se fallisce, il worktree non viene tolto e l'errore si legge. Cantus stacca da solo i collegamenti prima dello script: se lo script controlla il lavoro non salvato, servono i suoi flag di forza.

### 6.3 Da riga di comando, senza presidio

```bash
cantus task src-pricing "Aggiungi l'IVA al preventivo" --worktree --merge --verify "npm test"
cantus task --group flusso-ordine "Supporta i codici sconto" --plan --budget 5
cantus task --all "Allinea i messaggi d'errore" --worktree
```

Per script e CI. Una politica risponde al posto tuo: piano e strumenti di lettura approvati; modifiche dentro l'ambito consentite (e test e documenti che nessun blocco possiede); shell limitata al comando di verifica; i tuoi server MCP consentiti salvo `"agent": { "mcp": { "deny": [...] } }`; ogni altro strumento rifiutato. Le modifiche ad altri blocchi, ai manifesti e ai sorgenti senza blocco sono rifiutate e l'agente riferisce cosa serve lì. Progressi su stderr, relazione su stdout, tutta l'esecuzione in `.cantus/runs/<id>.json`; codice di uscita 1 se fallisce, è bloccato o `--merge` non riesce. `--all` dà a Claude Code la mappa e lo fa delegare agli specialisti `block-<id>` (`cantus agents`). La sessione parte con l'SDK (predefinito) o con `claude -p` (`claude-cli`, provato solo in parte, usa il login del tuo `claude`).

**Il cancello.** A fine lavoro Cantus lancia da sé il comando di verifica (`--verify`, poi il controllo con nome, poi `agent.verifyCommand`) nella cartella dove l'agente ha lavorato e decide dall'exit code: 0 → `done`, altrimenti (o se non parte, o supera dieci minuti) → `blocked`, con comando, exit code e coda dell'output nel record. L'agente non può segnare da solo che i test passano. Un compito bloccato in worktree tiene il lavoro sul suo ramo: non si unisce, solo si scarta o si sistema a mano. `--no-gate` salta il controllo.

**Ritentativi.** Se il controllo è rosso, Cantus rimanda l'agente al lavoro in una sessione nuova nella stessa cartella, con il compito originale, l'output del controllo e il divieto di cambiare il controllo o indebolire i test: fino a `--retries <n>` volte (0-5; `agent.retries`, altrimenti 2). Si ferma prima se torna lo stesso errore, se il budget (`--budget`, unico per tutti i giri) è finito o se una sessione finisce in errore. `attempts` e `blockReason` nel record dicono com'è andata.

**Controlli con nome.** `"agent": { "checks": { "unit": "npm test", "lint": "npm run lint" } }`. Un compito sceglie un controllo **per nome**, mai per comando (`--check unit`, `"check": "unit"` in una richiesta); `none` è riservato. Un nome sconosciuto è rifiutato con l'elenco. I comandi di una mappa condivisa girano sul computer di chi avvia il compito: leggili prima di accettare una mappa altrui. Il comando non arriva mai da una richiesta al server della mappa.

**Piani.** Un piano è un lavoro su più blocchi scritto prima di partire: obiettivo, budget e compiti (`id`, `blocks`, `prompt`, `check` per nome, `dependsOn`, `model`, `budgetUsd`, `retries`). `cantus plan add <file>` lo valida (blocchi esistenti, controlli per nome, niente cicli, al massimo 30 compiti) e lo salva in `.cantus/runs/plans/`; `plan list` e `plan show <id>` mostrano ordine e avvisi, e la spesa e il tempo di lavoro delle sessioni (non le attese), per piano e per compito; `plan run <id>` chiede l'approvazione di questa revisione (`--yes` la salta). L'ordine viene dalla mappa più i `dependsOn`; i compiti girano uno alla volta, ciascuno in un worktree da `HEAD`, uniti prima del successivo, con il controllo che rigira sul risultato unito. Si ferma al primo compito non riuscito, a budget finito o con Ctrl+C; rilanciandolo riprende dai compiti non uniti.

**Chi progetta, chi esegue, chi controlla.** In un piano i ruoli sono separati e registrati: chi ha proposto il piano, l'esecutore (sessione nuova nel worktree del compito), il cancello (senza modello) e, con `"verify": true` (`"verifyModel"` sceglie il modello), un verificatore a sola lettura diverso dall'esecutore. Un finding `blocker` o `major` ferma il piano; lo sciolgono solo una nuova verifica pulita o `cantus plan accept <id> <compito>`, che fa solo una persona. `agent.independence`: `warn` (predefinito) o `require`. Un modello diverso aiuta contro i punti ciechi condivisi, ma è un'ipotesi da misurare.

**Dal capo.** Il capo scrive un piano con `plan_propose` (un compito per blocco, controlli per nome, `replaces` per rivedere un piano non ancora partito): Cantus lo salva **non approvato**; lo approvi e lo lanci tu con `cantus plan run <id>`. `plan_status` gli fa seguire l'esito e `task_retry` aggiungere **parole** a un compito fermo. Non può lanciare, approvare, unire o scartare un piano, né accettare i finding. Dal 10/11 non ha più strumenti per avviare compiti o verifiche: sono della riga di comando.

**Consiglio onesto:** i compiti non presidiati provali prima senza `--merge`. Cantus non misura la qualità del codice degli agenti: verifica che il compito finisca in un'unione, resti nell'ambito e lasci `cantus check` pulito, non che il risultato sia buono.

### 6.4 Far rivedere il lavoro da un altro agente

Quando la tua sessione (o un compito) ha finito, un agente **separato**, in sola lettura, può guardare il lavoro: riceve la richiesta, le modifiche, il briefing dei blocchi toccati, l'esito dei test che Cantus lancia da sé e il resoconto dell'autore (come «dichiarazioni da controllare»), e dice se il lavoro fa ciò che si chiedeva.

- **Dalla mappa:** la riga di un worktree *da rivedere* dà il comando da incollare (`cantus verify -C "<cartella del worktree>"`), con *Copia il comando di verifica*. La mappa non lancia la verifica. Lanciato dentro un worktree fatto da Cantus, e senza `--about`, `--request` né `--base`, il verificatore riceve da solo il testo del compito per cui il worktree è stato fatto, il resoconto che il capo ha dato con `worktree_done` (come dichiarazione da controllare) e il confronto con il punto da cui il worktree è partito; se il capo di quel worktree ha la mappa aperta, la verifica gira lì e i findings tornano a lui. `--about` e `--base` dati da te vincono sempre. `--head <ramo>` resta per un ramo senza worktree: copia temporanea, niente dipendenze, test saltati e nessuna richiesta.
- **Da riga di comando:** `cantus verify --about "<cosa doveva fare>"`. Senza altro confronta il lavoro non salvato con l'ultimo commit; con l'albero pulito su un branch, con il punto in cui ha lasciato `main`; `--base <ref>` lo sceglie tu. Esce con 1 se trova un `blocker` o un `major`, se non ha potuto controllare qualcosa di importante (`incomplete`) o se non finisce.
- **Dalla sessione:** `/cantus:verify`. Con la mappa della sessione accesa i findings tornano alla sessione come richiesta, con la scritta che non sono parole tue né ordini: il capo li controlla uno per uno, corregge i veri e spiega perché scarta gli altri. Se non trova niente, non ti disturba.

**Cosa aspettarti, onestamente.** Provato su un progetto giocattolo con difetti seminati (4 findings sensati, nessun falso positivo, circa $0,24 con Sonnet) e su un progetto vero (nessun falso positivo, $0,68): due prove, non una misura. Un revisore a modello trova sempre qualcosa, quindi i findings sono segnalazioni da verificare. Se lo stesso modello scrive e rivede, può avere gli stessi punti ciechi (`agent.models.verify` ne sceglie un altro; che aiuti è un'ipotesi). Tetto $1,50 e 40 giri (`--budget`, `--max-turns`). Nessuna riverifica automatica dopo le correzioni.

**Sola lettura per costruzione:** gli strumenti di modifica sono spenti nel runner, la shell è limitata a `git diff/show/log` e al comando dei test, i tuoi server MCP e il web sono rifiutati, e a fine corsa Cantus confronta i file prima e dopo e avvisa se qualcosa è cambiato. Gira nella cartella in cui lo lanci (con `-C`, anche un worktree), non in una copia: così vede il lavoro non salvato. **Il comando dei test** è `agent.verifyCommand` (`--no-tests` lo salta); un comando passato con `--tests`, o un `--runner` tuo, fa girare la verifica in locale e non sulla mappa viva: Cantus lo dice come prima riga.

## 7. Un progetto nuovo

Cantus può disegnare il progetto prima del codice.

1. Apri `cantus serve` in una cartella vuota (o in un progetto esistente) e premi **Modifica la mappa** (nelle impostazioni, l'ingranaggio in alto a destra; mentre modifichi, in intestazione c'è **Fine modifica**).
2. Disegna a mano, oppure **Descrivi il progetto** e Claude Code propone livelli, blocchi e frecce (sola lettura: la bozza si vede in anteprima e non si salva finché non premi **Tienila**). Su un progetto che ha già codice la bozza aggiunge soltanto.
3. In un livello, **+ Blocco** chiede nome, cartella (`src/<nome>` per default) e una riga su cosa fa; una scheda si trascina in un altro livello e le frecce si tracciano dalla maniglia →.
4. I blocchi senza codice sono **previsti** (tratteggiati). La cartella la crea il primo agente che ci scrive.
5. **Costruisci il piano** (o `cantus task --build`) lancia un compito su tutto il progetto che costruisce i blocchi previsti a ondate, quelli usati dagli altri per primi, ognuno dal proprio specialista, che decide l'API del blocco. In un progetto nuovo l'agente coordinatore posa prima lo scheletro (manifesto, build, test).

Lo stesso si fa dall'agente con lo strumento `sketch_map` (e `add_block`, `edit_block`, `add_dependency`… per i passi singoli). Lo schizzo è leggero di proposito: è una cornice, la mappa legge le API dal codice man mano che arriva.

## 8. Prima di una pull request

```bash
cantus diff               # cosa cambia questo ramo nella mappa
cantus impact src-orders  # cosa può toccare una modifica a quel blocco
cantus view --svg         # la mappa come immagine (SVG), per un README o un post
cantus mermaid --markdown # il grafo dei blocchi
cantus check              # esce con 1 se ci sono errori
```

- **`cantus diff [base] [head]`** dice a chi rivede la PR quello che un diff di righe non mostra: blocchi e frecce nuovi o spariti, problemi nuovi o risolti, export cambiati, spostati o tolti con il codice altrui che li usava (e quali di quei punti stanno in file che la modifica non ha toccato), endpoint comparsi o scomparsi. `base` è il main di origin; `head` è la cartella di lavoro, con il non committato. Il repository non viene mai spostato di ramo. `--json` per i dati. In CI, con un clone completo: `cantus diff origin/main >> "$GITHUB_STEP_SUMMARY"`.
- **`cantus impact <blocco|file>`** elenca i blocchi che lo usano direttamente, con nomi e punti di chiamata, e quelli che lo usano tramite altri (con la catena se sono pochi, altrimenti contati per il blocco da cui passano; `--full` per tutti).
- **`check --strict`** (o `"strict": true` nella mappa) tratta la mappa come un contratto: dipendenze non dichiarate e violazioni dei livelli diventano errori. Per la CI di chi lo vuole.
- Per l'agente, lo strumento **`review_changes`** riassume il lavoro non committato per blocco: export cambiati con i punti di chiamata da aggiornare e file che di solito cambiano insieme a quelli toccati.

I limiti: il confronto è sicuro quanto l'analisi (le chiamate trovate per nome sono marcate), e un export "cambiato" vuol dire dichiarazione diversa, non comportamento diverso.

## 9. Sistemare la mappa

`.cantus/model.json` si modifica a mano, dalla mappa (**Modifica la mappa**) o dall'agente (strumenti `edit_block` e simili, che fanno gli stessi controlli dell'editor: meglio non modificare il file a mano mentre un agente lavora).

```jsonc
{
  "version": 1,
  "name": "negozio",
  "blocks": [
    { "id": "src-checkout", "name": "Checkout", "layer": "application", "include": ["src/checkout"], "description": "Trasforma un carrello in un ordine pagato." }
  ],
  "dependencies": [{ "from": "src-checkout", "to": "src-orders" }],
  "analysis": { "include": ["src"], "exclude": ["scripts"] },
  "agent": { "verifyCommand": "npm test" }
}
```

Le impostazioni che servono più spesso:

| Cosa | Dove | A cosa serve |
|---|---|---|
| Blocchi | `blocks[].include` | Un file appartiene al blocco col prefisso più lungo che lo contiene |
| Livelli | `layers`, `rules.allow` | I tuoi livelli, dall'alto in basso, e chi può usare chi. Senza `layers`: `interface`, `application`, `domain`, `infrastructure`, più `host` e `test` |
| Analizzare solo alcune cartelle | `analysis.include` | Voci come prefisso **dalla radice** (`webroot`), file singoli o glob. Utile in un repository grande con una sola parte che interessa |
| Escludere | `analysis.exclude` | Prefissi o glob (`**/*.min.js`); vince su `include` |
| File ignorati da git | `analysis.respectGitignore` (predefinito `true`) | Quello che `.gitignore` ignora e git non traccia (un `wwwroot` generato, output di build) resta fuori dall'analisi, altrimenti la copia compare come un secondo posto dove tutto è definito. Un blocco il cui `include` nomina una cartella ignorata la legge comunque; un file tracciato non viene mai escluso; `false` legge tutto |
| File minificati o di terze parti | `analysis.parseMinified`, `analysis.vendor`, `analysis.read` | Per default restano nel blocco ma non si leggono |
| Blocchi troppo grandi | `analysis.maxBlockTokens` (40000) | Sopra la soglia, un finding dice lungo quali sottocartelle dividerli |
| Cartelle fuori dalla radice | `analysis.externalRoots` | Il permesso `allow`/`deny` per le cartelle a cui il codice punta (un `ProjectReference`, un import relativo, uno `<script src>`). Per default non vengono lette: `check` e il briefing dicono all'agente di chiedertelo. Con `allow` si leggono in sola lettura, mai modificate, e i loro export si trovano con `find_api` |
| Server MCP degli agenti | `agent.mcp.deny`, `agent.mcp.specialists`, `agent.mcp.blocks.<id>` | Togliere ai compiti non presidiati o agli specialisti i tuoi server (database, CI) |
| Modello e modo di avvio | `agent.model`, `agent.models.block`, `agent.runner` | Per i compiti dalla mappa e da `cantus task` |

**Gruppi.** Un lavoro che attraversa pochi blocchi (una funzione, un flusso) si salva come gruppo: `cantus group save flusso-ordine src-checkout src-pricing src-orders --name "Flusso d'ordine"`. `cantus context --group flusso-ordine` dà un solo briefing, in cui le dipendenze fra i blocchi del gruppo sono interne. `cantus agents` scrive uno specialista `group-<id>` per gruppo e un `cantus-scope` per gli ambiti occasionali.

**Documenti di squadra.** Quello che il codice non dice (regole, decisioni, trappole, conoscenza di prodotto) va in file Markdown che dai agli agenti:

```bash
cantus doc new --block src-pricing                       # docs/blocks/src-pricing.md da un modello
cantus doc add docs/convenzioni.md --common              # per ogni agente
cantus doc add docs/pagamenti.md --block src-payments    # per i briefing di quel blocco
cantus docs                                              # cosa va dove
```

Nel briefing prima vengono i documenti comuni, poi quelli del blocco o del gruppo, poi il contesto del codice. Fino a circa 3k token si includono interi, oltre si elencano.

**Note di dominio, scritte dal capo alla chiusura.** Solo dove un blocco o un gruppo ha una particolarità, non uno per blocco. Stanno in `.cantus/domain/<id-del-blocco-o-gruppo>.md`, una cartella che Claude Code non legge da sé (così non carica note per sbaglio), e l'**indice** è quello dei documenti sopra: ogni nota è registrata con `assign_doc` (percorso dato, `create`) e il briefing di quel blocco o gruppo la porta sotto «Notes for this block», intera fino a circa 3k token e altrimenti con il rimando al file. Il file del compito chiede al capo, prima del commit, al massimo tre righe di ciò che ha dovuto scoprire e non era scritto, sotto `Invariants`, `Decisions`, `Pitfalls` o `How to test here`, ognuna con i file su cui poggia; «nothing to add» è una risposta valida; sopra circa 400 parole si fonde o si toglie prima di aggiungere; un finding confermato o una correzione tua diventa una riga in `Pitfalls`. Le righe entrano nel commit del lavoro. Il verificatore legge il diff delle note scritte (anche se `.cantus` è fuori dalle modifiche) e controlla il lavoro contro gli `Invariants`. Cantus non genera note con un modello e non controlla che il capo le scriva.

**Note di dominio scritte a mano.** Se vuoi una nota per un blocco o un gruppo, scrivi tu il file Markdown, per esempio `.cantus/domain/src-pricing.md`, e dai a Cantus l'indice in uno di questi modi, tutti verificati: nel pannello **Documenti** della mappa (la cartella `.cantus/domain` è l'unica con il punto che l'elenco dei file offre; da lì assegni, leggi e modifichi la nota), da riga di comando `cantus doc add .cantus/domain/src-pricing.md --block src-pricing` (o `--group <id>`, o `--common` per tutti), oppure con lo strumento `assign_doc` del capo. `cantus docs` elenca dove va ogni documento; `cantus doc remove <percorso>` o `unassign_doc` lo toglie dal blocco **senza cancellare il file**. Il briefing del blocco la porta sotto «Notes for this block» e `cantus notes` non la tocca.

**Note a mano.** Nelle `AGENTS.md` dei blocchi scrivi liberamente fuori dai marcatori `cantus:start` / `cantus:end`; la sezione generata è deterministica, quindi cambia in git solo quando cambia il codice.

## 10. Capire i problemi segnalati

Due cose diverse:

- **Segnalazioni** (`cantus check`, strumento `check`, la mappa): confronto fra codice e mappa. Le principali: `undeclared-dependency` (il codice usa un blocco che la mappa non elenca), `layer-violation`, `cycle` (con l'arco più debole da togliere), `unassigned-files`, `breaking-change`, `possible-duplicate`, `oversized-block`, `unreadable-files`, `uncovered-files`, `external-reference`, `unmatched-http-calls`, `refine-suggestion`. L'elenco completo con le gravità è in [REFERENCE.md](REFERENCE.md#the-map-file). Molte segnalazioni simili sono raggruppate; `--full` le elenca tutte.
- **Problemi d'analisi**: cosa non è riuscito a Cantus leggendo il progetto. La voce "problemi d'analisi da guardare" nei **Segnali** della mappa, e `check`, li raggruppano **per causa** e **per chi può agire**:
  - *Da sistemare nel tuo codice*: codice che non si analizza, tipi che il compilatore non sa scrivere (con l'export da annotare e la riga), import che non portano a nessun file;
  - *Da controllare nella tua configurazione*: pacchetti non installati, un `tsconfig.json` rifiutato dal compilatore, un lettore di linguaggio che è fallito;
  - *Limiti di Cantus, niente da fare*: errori di tipo che il compilatore segnala mentre legge i tipi (contati, non elencati).

  Contano nei colori e nei badge dei blocchi solo i primi due gruppi. Il log completo è sempre in `.cantus/analysis.log`, che comincia con i tempi dell'analisi fase per fase e i cinque file più lenti da leggere: il posto dove guardare se l'analisi diventa lenta.

Ogni punto di chiamata dice quanto è sicuro: *certo* (un import risolto), *probabile* (un solo candidato, o la rotta corrisponde per intero), *solo per nome* (più candidati). Briefing, `callers`, hook e mappa elencano prima i più sicuri.

## 11. Se qualcosa non funziona

- **`/mcp` non mostra `cantus`, o lo mostra in errore.** Lancia `node <cartella-di-cantus>/plugin/scripts/cantus.mjs --help`: se stampa l'aiuto, il lanciatore trova `cantus`; se dice che il comando non è stato trovato, il PATH da cui lanci `claude` non lo vede (su Windows controlla `%APPDATA%\npm` e riapri il terminale).
- **Il messaggio di avvio con la mappa non compare.** `cantus analyze --write` non è stato fatto in quella cartella, o hai aperto `claude` altrove: la radice è la cartella da cui parte la sessione.
- **Gli hook non scrivono niente.** Guarda `.cantus/hooks.log` nel progetto.
- **Uno specialista non viene trovato.** Vedi la [sezione 4](#4-usarlo-con-claude-code): `/cantus:agents`, riavvio se la cartella era nuova, `specialist_prompt` nel frattempo.
- **La mappa non riflette il codice.** Rilancia `cantus analyze --write` (o lo strumento `update_map`): tiene i tuoi nomi e le tue descrizioni. Ogni risposta degli strumenti che leggono finisce con data e commit dell'analisi a cui si riferisce.
- **Un file non viene letto.** Se sta in una lingua che Cantus non legge (Kotlin, Ruby, PHP, Swift, C e C++…), appartiene al suo blocco con la dimensione ma non ha né import né export nella mappa. Se è in una lingua letta, `check` dice quali file un lettore non ha potuto leggere (`unreadable-files`).
- **Un aggiornamento di Cantus ha cambiato la mappa?** Dopo un aggiornamento o una ricompilazione la cache si ricostruisce da sola, ma la mappa (`model.json`) la cambia solo `analyze --write`.

Se trovi un errore che non è qui, incolla `.cantus/analysis.log` (e, se c'è, la parte `[crash]` in fondo) nel segnalarlo.
