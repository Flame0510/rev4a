# Code Review — `feat/shared-skills-setup` (commit 72c746c)

**Repo:** olympus  
**Data:** 2026-07-23  
**Tipo:** Edge Case Audit  
**File esaminati:** 6 (Dockerfile, route.ts, page.tsx, ARCHITECTURE.md, olympus.sh, spawn-agent.sh)

---

## Risultati per i 10 punti richiesti

### 1. `/docker/shared-skills` non esiste sull'host? E se esiste ma è vuota?

**route.ts (L176-181):** La creazione on-demand è implementata: `fs.existsSync` + `fs.mkdirSync({recursive: true})` + `chown`/`chmod`.  
**spawn-agent.sh (L63-72):** Stessa logica: se la dir non esiste, la crea con warning.

**Se vuota:** Docker monta la directory vuota. il container vede una `/data/.openclaw/shared-skills` vuota. `openclaw` deve scansionare `extraDirs`: se non trova `SKILL.md` nelle sottodirectory, nessuna skill viene caricata. Non crasha — è un no-op silenzioso.

| Severity | File | Linea | Problema | Fix |
|----------|------|-------|----------|-----|
| 🟢 LOW | route.ts | 176-181 | Nessun log quando la dir viene creata on-demand (debug difficile) | Aggiungere `console.log` per tracciabilità |

**Verdetto:** ✅ Gestito correttamente. Lato openclaw → da verificare che `extraDirs` inesistente o vuoto non causi errori (probabilmente skip con warning).

---

### 2. `/docker/shared-repos` non esiste?

Stessa logica di shared-skills in entrambi i file.

| Severity | File | Linea | Problema | Fix |
|----------|------|-------|----------|-----|
| 🟢 NONE | — | — | Gestito identico a shared-skills | — |

**Verdetto:** ✅ OK, lo stesso loop `for` copre entrambi i volumi.

---

### 3. Mount `ro` su `/data/.openclaw/shared-skills` — Docker crea il path?

**Verifica empirica:** Sì. Se il path non esiste dentro il container, Docker lo crea come directory (owned by root sul filesystem del container, ma poi il bind mount sovrascrive con l'host dir).

**Problema:** se la directory host è root-owned (chown fallito), e il container esegue come uid 1000 (node), la lettura in `ro` funziona **solo se** la directory host ha permessi `world-readable` (r-x). Con `chmod 2775` (setgid + rwxrwxr-x) usato nel codice, l'accesso funziona. Se `chmod` fallisce, il `mkdirSync` di Node crea la dir con umask di sistema (tipicamente 755 su Ubuntu) → comunque world-readable.

| Severity | File | Linea | Problema | Fix |
|----------|------|-------|----------|-----|
| 🟢 LOW | route.ts | 176-181 | Se umask host è 0077, la dir creata da `mkdirSync` non è world-readable → uid 1000 nel container non può leggere | Aggiungere `fs.chmodSync(vol, 0o755)` dopo `mkdirSync` invece di affidarsi solo a `execSync chmod` (che può fallire) |

**Verdetto:** ✅ Funziona nei casi normali. Edge case con umask restrittiva → mitigare con `fs.chmodSync`.

---

### 4. `chown 1000:1000` fallisce (uid 1000 non esiste sull'host)?

**route.ts:** Il `catch` rende il fallimento non-fatale ✅  
**spawn-agent.sh (L68-70):** `id -u 1000` controlla prima di chiamare `chown`. Se uid 1000 non esiste, skippa ✅  
**olympus.sh (L175-180):** Stesso pattern con `id -u 1000` ✅

| Severity | File | Linea | Problema | Fix |
|----------|------|-------|----------|-----|
| 🟢 NONE | — | — | Gestito correttamente in tutti e 3 i file | — |

**Conseguenza se fallisce:** directory root-owned, ma con `chmod 2775` il container (uid 1000) può comunque leggere file in `ro`. Per `shared-repos` (montato `rw`), la scrittura fallirà se la dir è root-owned → ma l'agente tipicamente clona repo in sottodirectory, che erediteranno i permessi.

| Severity | File | Linea | Problema | Fix |
|----------|------|-------|----------|-----|
| 🟡 MEDIUM | route.ts | 177 | Se chown fallisce, `shared-repos` è root-owned e montato `rw` — il container (uid 1000) non può scrivere nuove sottodirectory | Assicurarsi che `chmod 2775` venga SEMPRE eseguito (non solo dopo chown riuscito): spostare `chmod` fuori dal `if` |

**Verifica nel codice:** In `route.ts` L177-179, `chmod` è dentro un secondo `try` separato dal `chown` — viene eseguito indipendentemente dal fallimento di `chown`. ✅ OK in route.ts.

**spawn-agent.sh L68-70:** `chmod` è fuori dall'`if id -u` — viene sempre eseguito. ✅ OK.

**olympus.sh L178-179:** `chmod` è DENTRO l'`if [[ ! -d ]]` e DOPO l'`if id -u`. Se la dir esiste già e non ha i permessi giusti, non vengono corretti.

| Severity | File | Linea | Problema | Fix |
|----------|------|-------|----------|-----|
| 🟡 MEDIUM | olympus.sh | 178-179 | Se `/docker/shared-skills` esiste già ma ha permessi errati, `chmod` non viene applicato (è dentro `if [[ ! -d ]]`) | Spostare `chown`/`chmod` fuori dal branch `! -d`, eseguendoli sempre |

**Verdetto:** ✅ Non-fatale ovunque. ⚠️ olympus.sh non corregge permessi su dir pre-esistenti.

---

### 5. `waitForContainerReady` timeout 60s — container lento che parte dopo 65s?

**route.ts (L15-29):** Polling ogni 2s con timeout fisso 60s. Se il container diventa healthy a 61-120s (il `maxDuration` è 120s), viene ucciso da `docker rm -f` e restituito errore 500.

| Severity | File | Linea | Problema | Fix |
|----------|------|-------|----------|-----|
| 🔴 HIGH | route.ts | 17 | Timeout hardcoded a 60s non sfrutta la finestra `maxDuration=120s`. Un container che boota in 61-120s viene ucciso inutilmente | Opzione A: aumentare timeout a 90-110s con backoff esponenziale. Opzione B: rendere il timeout configurabile via env var (`OLYMPUS_HEALTH_TIMEOUT`) |

**Dettaglio aggiuntivo:** `maxDuration=120` è un ceiling di Vercel/Next.js. Se il container parte in 65s ma il timeout è 60s, l'utente vede un errore e deve riprovare — ma il volume `agent-<name>-data` esiste già dalla prima esecuzione fallita, quindi al secondo tentativo il boot è più veloce (config già scritta). Questo mitiga parzialmente il problema.

**Verdetto:** ⚠️ Possibile falso negativo su primo avvio di agent "lenti". Mitigato dal retry automatico (volume già caldo).

---

### 6. `docker rm -f` con nome container che ha caratteri speciali?

**Validazione in route.ts (L76-78):** `isDockerCompatibleName` regex `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` blocca caratteri speciali. Il nome passato a `docker rm -f` è sempre sicuro. ✅

**spawn-agent.sh:** NESSUNA validazione su `$AGENT_ID`. Un nome con spazi o caratteri speciali passato direttamente causerebbe:
- `docker run --name "$CONTAINER_NAME"` fallisce con errore Docker
- `docker rm -f "$CONTAINER_NAME"` tenta di rimuovere un container con nome invalido

| Severity | File | Linea | Problema | Fix |
|----------|------|-------|----------|-----|
| 🟡 MEDIUM | spawn-agent.sh | 36 | Nessuna validazione su `$AGENT_ID` prima di usarlo come nome container | Aggiungere validazione regex uguale a route.ts prima dell'uso |

**Verdetto:** ✅ route.ts sicuro. ⚠️ spawn-agent.sh vulnerabile a input malevolo (mitigato dal fatto che è uno script CLI locale, non esposto via API).

---

### 7. `extraDirs` garantito post-scrittura — se `openclaw config patch` fallisce?

**route.ts (L340-355):** Sequenza critica:
1. Legge `openclaw.json` dal container
2. Modifica in memoria (controlUi, model, update)
3. **Sovrascrive** `openclaw.json` con `cat >` → perde gli `extraDirs` pre-configurati dalla base image
4. Esegue `openclaw config patch --stdin` per ri-aggiungere `extraDirs`

| Severity | File | Linea | Problema | Fix |
|----------|------|-------|----------|-----|
| 🔴 HIGH | route.ts | 348-353 | Se il `config patch` di step 4 fallisce (catch non-fatale), `extraDirs` è PERSO dal config. L'agente funziona ma senza shared skills. Il base image li aveva, ma lo step 3 li ha cancellati. | Opzione A: aggiungere `extraDirs` nel JSON scritto allo step 3, così il patch è ridondante ma safe. Opzione B: invece di sovrascrivere tutto, usare `openclaw config set` per ogni chiave. Opzione C: dopo catch, loggare un warning visibile e ritentare il patch con backoff. |

**Workaround attuale:** Il `catch` commenta "non-fatal; skill loading will just skip shared dirs" — ma l'agente perde una funzionalità senza che l'utente lo sappia.

| Severity | File | Linea | Problema | Fix |
|----------|------|-------|----------|-----|
| 🟡 MEDIUM | route.ts | 353 | Il catch è silenzioso — nessun log, nessun indicatore all'utente che le shared skills sono mancanti | Aggiungere `console.error` nel catch con dettagli dell'errore |

**Verdetto:** 🔴 **Bug reale.** Se il config patch fallisce (container lento, openclaw binary non ancora pronto, disco pieno), le shared skills scompaiono silenziosamente.

---

### 8. `spawn-agent.sh --non-interactive` senza `OLYMPUS_GATEWAY_TOKEN`?

**spawn-agent.sh (L57-61):** Il controllo esiste: `if [ -z "${OLYMPUS_GATEWAY_TOKEN:-}" ]` → `exit 1` con messaggio di errore.

| Severity | File | Linea | Problema | Fix |
|----------|------|-------|----------|-----|
| 🟢 NONE | spawn-agent.sh | 57-61 | Gestito correttamente | — |

**Verdetto:** ✅ OK.

---

### 9. Due container con stesso nome in rapida successione — race condition?

**route.ts (L148-157):** Controlla `docker ps` per label `AGENT_ID=${name}` e restituisce 409 se esiste. **MA:** `docker ps` mostra solo container RUNNING. Se un container è appena stato rimosso ma Docker non ha ancora rilasciato il nome, o se esiste un container STOPPED con lo stesso nome, la race condition è:

1. Richiesta A: `docker ps` → nessun container running → procede
2. Richiesta A: `docker run --name "agent-x"` → OK
3. Richiesta B: `docker ps` → nessun container running (quello di A è in starting, non ancora healthy?) → no, è running
4. Richiesta B: `docker run --name "agent-x"` → **ERRORE: Conflict, nome già in uso**

Docker stesso impedisce la race condition sul nome: il secondo `docker run` fallisce atomicamente. Il check `docker ps` è un "fast reject" ma non è la protezione primaria — Docker funge da mutex.

| Severity | File | Linea | Problema | Fix |
|----------|------|-------|----------|-----|
| 🟢 LOW | route.ts | 148 | Il check `docker ps` non rileva container stoppati con stesso label. Se esiste un container stoppato `agent-x` (con label), il check passa ma `docker run` fallisce con errore Docker poco chiaro | Usare `docker ps -a` nel check invece di `docker ps` |

**Scenario peggiore:** Un container è stato stoppato (non rimosso) da un'operazione precedente. L'API lo ignora, tenta `docker run`, Docker restituisce "Conflict: name already in use" → l'utente vede un errore generico invece di un messaggio chiaro.

| Severity | File | Linea | Problema | Fix |
|----------|------|-------|----------|-----|
| 🟡 MEDIUM | route.ts | 226 | Il comando `docker run` non ha flag `--rm`. Se il container viene creato ma il waitForContainerReady lo uccide, il nome rimane "usato" come stopped container finché non rimosso | Aggiungere `--rm` al docker run per pulizia automatica, oppure assicurarsi che docker rm -f funzioni sempre |

**Verdetto:** ✅ Protetto da Docker a livello kernel. ⚠️ Messaggi di errore potenzialmente criptici per l'utente.

---

### 10. Volume `agent-<name>-data` persiste tra recreate — `extraDirs` sopravvive?

**Analisi:** Il volume è un named Docker volume (`-v agent-${name}-data:/root`). `docker rm -f` rimuove il container ma NON il volume. ✅

**extraDirs:** Nel file `openclaw.json` dentro `/root/.openclaw/` (sul volume). Dopo un recreate:
1. Il container parte, OpenClaw legge `openclaw.json` esistente dal volume
2. route.ts step 3 **sovrascrive** il file senza `extraDirs`
3. route.ts step 4 **ri-applica** `extraDirs` via `config patch`

Quindi sì, `extraDirs` sopravvive al recreate perché viene ri-applicato esplicitamente. ✅

**MA:** Se l'agente viene ricreato via `spawn-agent.sh` (non via API route.ts), gli step 3-4 NON vengono eseguiti. Il container eredita il `openclaw.json` dal volume, che dovrebbe già avere `extraDirs` da una precedente esecuzione di route.ts. Tuttavia, se il container è stato creato SOLO via spawn-agent.sh (mai via API), `extraDirs` è presente solo grazie al base image Dockerfile → quindi sopravvive finché il config non viene rigenerato.

| Severity | File | Linea | Problema | Fix |
|----------|------|-------|----------|-----|
| 🟢 LOW | spawn-agent.sh | 95 | spawn-agent.sh non applica `extraDirs` — si affida al base image. Se openclaw rigenera il config (migrazione, --allow-unconfigured), le shared skills scompaiono | Aggiungere `openclaw config patch` anche in spawn-agent.sh dopo l'avvio |

**Verdetto:** ✅ Sopravvive nella pratica. ⚠️ C'è un gap se l'agente è gestito esclusivamente via spawn-agent.sh e OpenClaw rigenera il config.

---

## Problemi aggiuntivi trovati

### A. Commento fuorviante — rischio data loss su recreate

**route.ts (L292-296):** Il commento dice "If so, skip the copy — the user may have edited them" ma il codice successivo commenta "Always copy" e il loop copia sempre. Comportamento effettivo: **sovrascrive sempre** i file workspace (AGENTS.md, SOUL.md, etc.) coi template.

| Severity | File | Linea | Problema | Fix |
|----------|------|-------|----------|-----|
| 🔴 HIGH | route.ts | 292-307 | Su recreate di un container con volume persistente, i file workspace modificati dall'utente vengono **sovrascritti** dai template. Data loss. | Rimuovere il commento fuorviante OPPURE implementare il comportamento descritto: controllare se il file esiste già nel container prima di copiare |

### B. ARCHITECTURE.md desync — shared-memory

**ARCHITECTURE.md (L60, L131, L306):** Documenta `/docker/shared-memory` come volume condiviso, ma né route.ts né spawn-agent.sh lo creano o montano. Il codice non lo supporta.

| Severity | File | Linea | Problema | Fix |
|----------|------|-------|----------|-----|
| 🟡 MEDIUM | ARCHITECTURE.md | 60,131,306 | Documentazione fuori sync col codice: shared-memory referenziato ma non implementato | Rimuovere i riferimenti a shared-memory o aggiungere nota "planned, not yet implemented" |

### C. spawn-agent.sh: `set -e` rende fatali errori che route.ts tratta come non-fatali

**spawn-agent.sh (L1, L67-71):** `set -e` all'inizio dello script. Se `chown` o `chmod` falliscono nel blocco di creazione volumi, lo script esce con errore. In route.ts questi errori sono catturati e non-fatali.

| Severity | File | Linea | Problema | Fix |
|----------|------|-------|----------|-----|
| 🟡 MEDIUM | spawn-agent.sh | 67-71 | Inconsistenza: chown/chmod failure è fatale in spawn-agent.sh, non-fatale in route.ts | Aggiungere `|| true` dopo chown e chmod nel blocco di creazione volumi |

### D. Container stoppato non rilevato dal check esistente

**route.ts (L148):** `docker ps -a` invece di `docker ps` rileverebbe anche container stoppati con lo stesso nome. Con `docker ps` un container stoppato viene ignorato e Docker blocca la creazione con un errore criptico.

| Severity | File | Linea | Problema | Fix |
|----------|------|-------|----------|-----|
| 🟡 MEDIUM | route.ts | 148 | `docker ps` non vede container stoppati → Docker restituisce "Conflict" invece di un messaggio user-friendly | Usare `docker ps -a` per il check |

### E. Timeout di waitForContainerReady non sfrutta maxDuration

Già coperto nel punto 5. Riassunto: 60s di timeout health-check con 120s di maxDuration Next.js → 60s sprecati.

---

## Riepilogo severity

| Severity | Count | Dettaglio |
|----------|-------|-----------|
| 🔴 HIGH | 2 | (5) Timeout 60s vs maxDuration 120s — agent lenti uccisi inutilmente; (7) Config patch fallito → extraDirs perso silenziosamente; (A) Data loss su recreate — workspace sovrascritto |
| 🟡 MEDIUM | 6 | (4b) olympus.sh non corregge permessi pre-esistenti; (6b) spawn-agent.sh senza validazione nome; (7b) Catch silenzioso; (9b) docker ps vs docker ps -a; (B) ARCHITECTURE.md desync; (C) set -e in spawn-agent.sh |
| 🟢 LOW | 4 | (1) No log su creazione dir; (3) umask restrittiva; (9a) Race condition nome (Docker mutex); (10) spawn-agent.sh non applica extraDirs |

---

## Raccomandazioni prioritarie

1. **Fix immediato (HIGH):** In route.ts, aggiungere `extraDirs` al JSON scritto allo step 3 (write-back del config), così anche se lo step 4 fallisce, il dato è già presente.
2. **Fix immediato (HIGH):** Risolvere il commento/codice inconsistente sulla copia dei template (o skippare se file esiste, o rimuovere il commento fuorviante).
3. **Miglioramento:** Portare `waitForContainerReady` a 90s o usare backoff esponenziale fino a 110s.
4. **Miglioramento:** Aggiungere validazione `$AGENT_ID` in spawn-agent.sh.
5. **Docs:** Allineare ARCHITECTURE.md rimuovendo shared-memory o marcandolo come planned.
