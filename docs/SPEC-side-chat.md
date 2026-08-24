# Side chat (`/side`) — specifica di manutenzione

> Feature persistente che aggiunge il comando `/side`: apre una finestra di
> chat speculare sul lato destro della UI web, fork temporanea della
> conversazione corrente. Ispirata alla side chat di Codex app.

## Filosofia

1. **Zero nuove RPC**: la feature riusa esclusivamente la superficie
   `session.*` esistente (`list`, `history`, `prompt`) più il comando
   `/side-close` per lo smaltimento. Nessun dominio API nuovo.
2. **Fork temporanea della main chat**: eredita il contesto (seed completo),
   graficamente nasce vuota, e poi è una chat normale con le stesse
   capacità del genitore — nessuna restrizione di tool, stessa superficie di
   permessi (workspace write). È una sessione ordinaria creata con
   `agentLoop.createAgent` e metadati solo `cwd` + `seedLength`. Niente
   `origin: 'subagent'` né `parentSession`: uno dei due marca l'identità come
   di proprietà del routing subagent e l'API proxy blocca `session.prompt`
   con `agent-busy`. Il legame col padre viaggia nel prefisso dell'id
   (`side-<parent>-…`), che la finestra usa per il discovery.
3. **Il boot non si blocca mai**: il client half non dichiara `inject`
   (che metterebbe il plugin in `pending` se un servizio ritarda) e legge i
   servizi solo con `ctx.get()` dentro un retry tollerante. Peggior caso: la
   finestra non c'è, il boot procede.
4. **Comando come unico trigger**: niente launcher grafici; `/side` crea la
   fork, la finestra compare da sola quando scopre la fork più recente.
5. **Effimera con ciclo di vita esplicito**: ogni `/side` dispose la fork
   precedente; chiudere il pannello esegue `/side-close`, che dispone
   l'agente, e il browser dimentica l'id così il discovery non si riaggancia
   mai sulla fork chiusa. Gli id portano timestamp
   (`side-<parent>-<n>-<ms>`) quindi sono univoci per sempre (la
   persistenza JSONL collide altrimenti dopo un riavvio).

## Componenti

| Percorso | Ruolo |
|---|---|
| `packages/session/command-side-chat/src/index.ts` | Host: registra `/side` (crea il fork, seed = eventi del parent meno l'ultimo `command/run`) e `/side-close` (dispose del handle); nessuna restrizione tool |
| `packages/client/ui-side-chat/src/client/index.ts` | Client: occupante `shell.overlay` (finestra fissa destra), ciclo auto-pianificato adattivo |
| `packages/bundle/base/cordis.patch.yml` | riga host `- id: command-side-chat` |
| `packages/bundle/web-app/cordis.patch.yml` | riga client `- id: ui-side-chat` |
| `tsconfig.host.json` / `tsconfig.client.json` / `tsconfig.base.json` | riferimenti progetto + paths |
| `$DSH_HOME/profiles/web/cordis.patch.yml` | righe utente `insert` degli stessi due id: montano la feature anche quando il backend parte da un'altra installazione, perché i pacchetti risolvono tramite le junction in `profiles/node_modules` |

## Flusso dati

```
/side ──▶ command-side-chat ──▶ agentLoop.createAgent(parent.ctx, {
                                   sessionId: 'side-<parent>-<n>-<ms>',
                                   seed, meta{cwd, seedLength} })
chiudi ─▶ /side-close: dispose del handle; il browser dimentica l'id
UI: ciclo auto-pianificato senza sovrapposizioni — 800 ms mentre è attesa
    una risposta, 2,5 s a pannello aperto, 6 s chiuso, sospeso a scheda
    nascosta; filtra items con sessionId.startsWith('side-' + sessione
    corrente + '-') escludendo gli id chiusi; scelta della fork per
    suffisso `-<n>-<ms>` ordinato numericamente
refresh: solo se `list` riporta `updatedAt` cambiato OPPURE mentre è attesa
         una risposta (ultima riga visibile 'user' o eco pendente: l'hint si
         muove solo sui messaggi umani, mai sull'output assistant):
         history({sessionId, maxMessages:40})
            ──▶ righe da events[].event; visibili solo quelle con seq oltre il taglio preso al bind
invio:      sessions.prompt({sessionId: childId, mode:'queue', content:[{type:'text',text}]})
            ──▶ eco ottimistica immediata della bolla utente (ritirata dalla riga confermata)
risposta:   i `text-delta` della coda finestra crescono in una riga provvisoria col cursore ▍;
            l'`assistant/message` definitivo la sostituisce
"sta scrivendo": ultima riga VISIBILE è 'user'
```

Diagnostica: la striscia sotto l'intestazione riporta per ogni tick numero progressivo, orario e fase corrente (`list`, `history…`, `fermo (upd invariato)`, `ERRORE: …`) più fork agganciata, righe ripiegate, taglio di visibilità e ultimo `updatedAt`; un tick che resta fermo su una fase indica una chiamata appesa, un contatore bloccato indica timer morti.

Connessione sempre viva: l'handle RPC si risolve con `ctx.get('connection')` a ogni chiamata (poll e invio), non una volta per render — dopo un riavvio del backend la pagina può riconnettersi con handle vecchi legati a socket morti, che appescono ogni chiamata per sempre.

Turni interrotti: se la richiesta di `prompt` cade mentre è in volo, il server chiude il turno con `turn/end` di motivo `interrupted` senza alcun output; la finestra lo riconosce e mostra «Risposta interrotta dalla connessione — rinvia il messaggio» invece di lasciare la bolla utente appesa.

Ciclo di vita: la chiusura del pannello esegue `/side-close`, che dispone l'agente della fork; il log JSONL resta su disco ma è orfano e innocuo, e il browser non lo riseleziona mai. Un secondo `/side` sullo stesso parent mentre la creazione è in corso restituisce errore invece di orfanare un handle.

## Perché questi scelgi (note sui tentativi falliti)

- Il taglio preso al bind è voluto: la richiesta esplicita è «appena aperta
  la side chat deve essere pulita», quindi anche le conversazioni side
  precedenti di una fork riaperta restano nascoste; il limite di 40 unità
  per pagina è l'attesa di coda, non un archivio consultabile.
- Nessuna restrizione di tool è voluta: la direzione è «una chat normale
  con permesso workspace write», quindi il fork eredita il preset del
  genitore intatto. Un tentativo con `tools.restrict` su contesto globale
  lanciava e veniva ingoiato, lasciando il fork con tutti i tool e senza
  segnalazione: rimosso del tutto.
- La sessione corrente arriva dall'hook framework `useSessions` che il
  renderer passa nei props di ogni occupante di slot (`useSessions(s => s.current)`),
  non da un servizio: il servizio sessions non ha un accessor `.current`
  (fallback: `sessions.list.getSnapshot().current`). Le chiamate RPC partono
  dal payload-direct `ctx.get('connection').api.sessions.*` — un solo
  argomento oggetto e risposta `{result:{value}}`: il namespace `remote` non
  monta `sessions`, e gli item di `session.list` espongono `sessionId`.
- La fence dell'ownership (`hasApiRemoteSubagentOwner` in
  `packages/api/remotes/src/agent-lookup.ts`) rifiuta `session.prompt` con
  `agent-busy` quando l'header porta `origin: 'subagent'`, oppure quando il
  padre è live e possiede l'agente (`parentSession` impostato): per questo la
  fork non scrive nessuno dei due campi. Il catalogo `subagent.*` resta
  inutilizzabile senza il descrittore `subagent/descriptor`, che solo il
  continuation manager appende (vedi "Estendere").
- Il Loader risolve le entry del profilo con gli hook di tsx attivi nel
  source-launch, che applicano i `paths` del tsconfig: mappare il bare
  specifier di un pacchetto client su `src/client` esegue la faccia browser
  sul host al boot. I pacchetti client si mappano sulla radice `src` (faccia
  node vuota); solo il subpath `/client` punta a `src/client`.
- L'accesso diretto a `ctx.<servizio>` senza `inject` dichiarato lancia
  sempre `cannot get property ... without inject`, anche nel browser: le
  dipendenze opzionali del client half passano tutte da `ctx.get()`.

## Manutenzione

Ricompila dopo ogni modifica sorgente:

```powershell
pnpm --filter @deepseek-ai/dsh-command-side-chat exec tsc -b tsconfig.json   # host
pnpm --filter @deepseek-ai/dsh-client-ui-side-chat run bundle                # client (lib/client.js)
pnpm run build:web                                                           # solo se cambi la shell
npm run dsh -- web --no-open --port 3080                                     # riavvio backend
```

Il browser serve `lib/client.js` dal disco: spesso basta un hard refresh
(Ctrl+Shift+R) senza riavviare il backend.

### Debug rapido

| Sintomo | Causa tipica | Dove guardare |
|---|---|---|
| `/side` manca dalla palette | riga host assente o pacchetto non compilato | `base/cordis.patch.yml`, `lib/index.js` |
| Boot resta su "pending (waiting for services)" | un plugin dichiara `inject` con servizi assenti | rimuovere `export const inject` (schema del client half) |
| Boot crasha su `cannot get property "X" without inject` | lettura diretta di una proprietà del ctx fuori da `inject`, o faccia browser eseguita sul host | usare `ctx.get`; controllare che `tsconfig.base.json` mappi `<pkg>` su `src`, non su `src/client` |
| Comando ok, finestra mai | bundle client non servito o filtri RPC disallineati dal wire | console F12 cerca `scw-` / `side-chat`; la API arriva da `ctx.get('connection').api.sessions`, gli item di `list` espongono `sessionId` |
| Finestra aperta ma invio muto | fork creata da una versione precedente con `origin: 'subagent'`: `session.prompt` risponde `agent-busy` | log backend; rilancia `/side` per creare una fork conforme |

### Estendere (fork continuable, stop button)

Creare la fork tramite il continuation manager dei subagent
(`packages/subagent/subagent`) invece di `createAgent` diretto: abilita
`subagent.prompt/interrupt` end-to-end (invio robusto + pulsante stop) e fa
comparire la fork anche nel lineage UI. Costo: dipendenza dal provider
"continuable-creation" e catalogo.

## Convenzioni rispettate

- Plain JS/TS senza trasformazioni custom; React via `createElement`.
- CSS inline iniettato dal componente (nessun CSS module da tipizzare).
- Apertura visivamente pulita: il seed della main chat resta contesto interno
  del fork; il trascritto parte vuoto, senza testo di benvenuto, e mostra
  solo i messaggi prodotti dopo l'apertura.
- Stile a soli token `--dsw-*`, nessun colore letterale: ombre
  `--dsw-shadow-lv1/lv2`, alias bg/border/label/button/state.
- Id sessione globalmente univoci (timestamp) per la persistenza JSONL.
- Ogni side effect host passa da `ctx.effect(...)` (disposable).
