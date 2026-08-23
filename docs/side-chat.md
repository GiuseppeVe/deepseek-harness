# Side chat (`/side`) — specifica di manutenzione

> Feature persistente che aggiunge il comando `/side`: apre una finestra di
> chat speculare sul lato destro della UI web, fork effimera della
> conversazione corrente con set di tool minimo. Ispirata alla side chat di
> Codex app.

## Filosofia

1. **Zero nuove RPC**: la feature riusa esclusivamente la superficie
   `session.*` esistente (`list`, `history`, `prompt`). Nessun dominio API
   nuovo ⇒ nessuna modifica ad apiproxy/schema/remotes generati.
2. **La fork è una sessione normale**: creata con `agentLoop.createAgent` e
   metadati `origin: 'subagent'` + `parentSession`; non è registrata nel
   registro subagents, quindi NON appare nel catalogo `subagent.list` né è
   "continuable". Tutta l'interazione passa dal lato sessioni ordinario.
3. **Il boot non si blocca mai**: il client half non dichiara `inject`
   (che metterebbe il plugin in `pending` se un servizio ritarda) e legge i
   servizi solo con `ctx.get()` dentro un retry tollerante. Peggior caso: la
   finestra non c'è, il boot procede.
4. **Comando come unico trigger**: niente launcher grafici; `/side` crea la
   fork, la finestra compare da sola quando scopre la fork più recente.
5. **Effimerma**: ogni `/side` dispose la fork precedente; gli id contengono
   timestamp (`side-<parent>-<n>-<ms>`) così sono univoci per sempre
   (la persistenza JSONL collide altrimenti dopo un riavvio).

## Componenti

| Percorso | Ruolo |
|---|---|
| `packages/session/command-side-chat/src/index.ts` | Host: registra `/side`, fora l'agente (seed = eventi del parent meno l'ultimo `command/run`), tool minimi `read/grep/glob` via `tools.restrict` in try/catch |
| `packages/client/ui-side-chat/src/client/index.ts` | Client: occupante `shell.overlay` (finestra fissa destra), polling 700 ms |
| `packages/bundle/base/cordis.patch.yml` | riga host `- id: command-side-chat` |
| `packages/bundle/web-app/cordis.patch.yml` | riga client `- id: ui-side-chat` |
| `tsconfig.host.json` / `tsconfig.client.json` / `tsconfig.base.json` | riferimenti progetto + paths |
| `$DSH_HOME/profiles/web/cordis.patch.yml` | righe utente `insert` degli stessi due id: montano la feature anche quando il backend parte da un'altra installazione, perché i pacchetti risolvono tramite le junction in `profiles/node_modules` |

## Flusso dati

```
/side ──▶ command-side-chat ──▶ agentLoop.createAgent(parent.ctx, {
                                   sessionId: 'side-<parent>-<n>-<ms>',
                                   seed, meta{origin:'subagent',parentSession},
                                   setup: restrict(read,grep,glob) })
UI (700ms): remote.sessions.list() ── filtra items con
            parentSessionId === sessions.current && id.startsWith('side-')
            ──▶ più recente = fork attiva ▶ open
refresh:    remote.sessions.history(childId,{maxMessages}) ──▶ righe bolle
invio:      remote.sessions.prompt(childId,{mode:'queue',content:[text]})
"sta scrivendo": ultima riga visibile è 'user'
```

## Perché questi scelgi (note sui tentativi falliti)

- `props.useSessions` NON esiste per gli occupanti di `shell.overlay`
  persistiti: `AppFrame` li renderizza con `{}`. I dati arrivano solo dai
  servizi chiusi nella closure dell'apply (`ctx.sessions`, `ctx.remote`).
- Il catalogo `subagent.list/history/prompt` è gated su
  `ctx.subagents.listChildren` (registro dei figli creati dal servizio
  subagent): le fork dirette non ci compaiono. Se in futuro vuoi l'invio via
  `subagent.prompt` (affidabile anche se il parent muore), bisogna creare la
  fork attraverso il continuation manager dei subagent — vedi "Estendere".
- `session.prompt` su sessioni marcate subagent può rispondere
  `agent-busy`: oggi funziona perché la fork non è nel registro; se la rendi
  continuable, spostati su `subagent.prompt`.
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
| Comando ok, finestra mai | bundle client non servito o `ctx.slots/remote` mancanti | console F12 cerca `scw-` / `side-chat`; verifica `dsh.client.inject` include `@deepseek-ai/dsh-api-remotes` |
| Finestra aperta ma invio muto | `agent-busy` su session.prompt o parent non live | log backend; valutare fork continuable |

### Estendere (fork continuable, stop button)

Creare la fork tramite il continuation manager dei subagent
(`packages/subagent/subagent`) invece di `createAgent` diretto: abilita
`subagent.prompt/interrupt` end-to-end (invio robusto + pulsante stop) e fa
comparire la fork anche nel lineage UI. Costo: dipendenza dal provider
"continuable-creation" e catalogo.

## Convenzioni rispettate

- Plain JS/TS senza trasformazioni custom; React via `createElement`.
- CSS inline iniettato dal componente (nessun CSS module da tipizzare).
- Id sessione globalmente univoci (timestamp) per la persistenza JSONL.
- Ogni side effect host passa da `ctx.effect(...)` (disposable).
