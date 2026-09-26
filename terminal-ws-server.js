// Terminal WebSocket Server — standalone
// Uses node-pty for real PTY with docker exec - fully interactive.
//
// Reached only through server.js (the dashboard's own port), which checks the session
// cookie and the Origin and forwards the handshake with REV4A_TERMINAL_SECRET. This
// server listens on 127.0.0.1 and refuses any handshake without that secret.
//
// Sessions outlive a dropped connection: the browser names its session (`session=<uuid>`
// in the URL); when the socket drops the shell keeps running for DETACHED_GRACE_MS, its
// output queued, and a reconnect with the same id picks it up where it was. A deliberate
// close (code 1000), the shell exiting, DETACHED_GRACE_MS without a client, or
// IDLE_TIMEOUT_MS without input or output ends it — and ending it kills the shell and
// everything it started *inside the container*: killing the host's `docker exec` client
// alone leaves them running (Docker does not stop an exec when its client goes away).
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { createHash, randomUUID, timingSafeEqual } = require('crypto');

const pty = require(path.resolve(__dirname, 'node_modules/node-pty'));

// node-pty 1.1 ships its macOS `spawn-helper` without the execute bit, and every spawn
// then fails with "posix_spawnp failed" (Linux does not use the helper). Restore it once.
if (process.platform === 'darwin') {
  const fs = require('fs');
  const prebuilds = path.resolve(__dirname, 'node_modules/node-pty/prebuilds');
  try {
    for (const arch of fs.readdirSync(prebuilds)) {
      const helper = path.join(prebuilds, arch, 'spawn-helper');
      if (fs.existsSync(helper) && (fs.statSync(helper).mode & 0o111) === 0) fs.chmodSync(helper, 0o755);
    }
  } catch (err) {
    console.log(`[TerminalWS] Could not make node-pty's spawn-helper executable: ${err.message}`);
  }
}

const PORT = parseInt(process.env.TERMINAL_WS_PORT || '3741', 10);
const SECRET = process.env.REV4A_TERMINAL_SECRET || '';
const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ping interval: keeps idle links open through NAT and finds dead peers. */
const HEARTBEAT_MS = 25 * 1000;
/** How long a shell waits for its browser to come back after the connection drops. */
const DETACHED_GRACE_MS = 2 * 60 * 1000;
/** A shell with no input and no output for this long is ended. */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** Output kept for a detached session, replayed on reattach (the newest part, in characters). */
const DETACHED_BUFFER_CHARS = 64 * 1024;
/** Live shells at once; a runaway loop of new tabs cannot fill the host with `docker exec`. */
const MAX_SESSIONS = 20;
/** Keystrokes queued while the container is checked (before the shell exists). */
const MAX_EARLY_INPUT_CHARS = 64 * 1024;
/** Backpressure: the shell is paused while this much output waits for a slow client. */
const PAUSE_ABOVE_BYTES = 1024 * 1024;
const RESUME_BELOW_BYTES = 256 * 1024;
/** Marks the shell's processes inside the container, so they can be found and ended. */
const MARKER = 'REV4A_TERMINAL_SESSION';

// Close codes the client acts on: it stops retrying and says why.
const CLOSE_EXITED = 4001; // the shell exited (`exit`, Ctrl-D)
const CLOSE_ENDED = 4002; // idle too long, or a resume found the shell already gone
const CLOSE_REPLACED = 4003; // the same session was opened in another tab
const CLOSE_NOT_FOUND = 4404; // no such container
const CLOSE_NOT_RUNNING = 4409; // the container is stopped
const CLOSE_NO_SHELL = 4410; // neither bash nor sh in the container
const CLOSE_TOO_MANY = 4429; // MAX_SESSIONS shells already open
const CLOSE_SPAWN_FAILED = 4500; // the PTY could not be started on this host

function secretMatches(supplied) {
  if (!SECRET || typeof supplied !== 'string') return false;
  const digest = (v) => createHash('sha256').update(v, 'utf8').digest();
  return timingSafeEqual(digest(supplied), digest(SECRET));
}

/** A resize message from the client ({"type":"resize","cols":n,"rows":n}), or null. */
function parseResize(msg) {
  if (!msg.startsWith('{"type":"resize"')) return null;
  try {
    const { type, cols, rows } = JSON.parse(msg);
    const ok = (n) => Number.isInteger(n) && n >= 2 && n <= 1000;
    return type === 'resize' && ok(cols) && ok(rows) ? { cols, rows } : null;
  } catch {
    return null;
  }
}

/** 'running' | 'stopped' | 'missing' — from `docker inspect`, argv only. */
function containerState(id) {
  return new Promise((resolve) => {
    execFile('docker', ['inspect', '-f', '{{.State.Running}}', id], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve('missing');
      resolve(String(stdout).trim() === 'true' ? 'running' : 'stopped');
    });
  });
}

/** bash when the container has it, else sh; null when it has neither. */
function pickShell(id) {
  return new Promise((resolve) => {
    execFile('docker', ['exec', id, 'sh', '-c', 'command -v bash || command -v sh'], { timeout: 10000 }, (err, stdout) => {
      const found = String(stdout || '').trim().split('\n')[0];
      resolve(err || !found ? null : found);
    });
  });
}

// Ends every process in the container that carries the session's marker — the shell and
// whatever it started (children inherit the environment): SIGHUP first, as a terminal
// hangup would, then SIGKILL for what ignored it. The session id is passed as an argument,
// never interpolated into the script.
const KILL_SCRIPT = [
  'm="$1"',
  'hit() { for p in /proc/[0-9]*; do tr "\\0" "\\n" < "$p/environ" 2>/dev/null | grep -qx "$m" && echo "${p#/proc/}"; done; }',
  'pids=$(hit); [ -n "$pids" ] || exit 0',
  'kill -HUP $pids 2>/dev/null; sleep 1',
  'pids=$(hit); [ -n "$pids" ] && kill -KILL $pids 2>/dev/null; exit 0',
].join('\n');

function killInContainer(containerId, sessionId) {
  execFile('docker', ['exec', containerId, 'sh', '-c', KILL_SCRIPT, 'rev4a-kill', `${MARKER}=${sessionId}`], { timeout: 15000 }, (err) => {
    if (err) console.log(`[TerminalWS] Could not end session ${sessionId.slice(0, 8)} in ${containerId}: ${err.message.split('\n')[0]}`);
  });
}

/** Live shells by session id. */
const sessions = new Map();
/** Shells being started, by session id: a second socket for the same id waits for it. */
const starting = new Map();

function closeSocket(ws, code, reason) {
  if (ws && (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)) {
    try { ws.close(code, String(reason).slice(0, 120)); } catch {}
  }
}

function endSession(session, code, reason) {
  if (!sessions.has(session.id)) return;
  sessions.delete(session.id);
  clearTimeout(session.detachTimer);
  clearTimeout(session.flushTimer);
  clearTimeout(session.drainTimer);
  try { session.term.kill(); } catch {}
  killInContainer(session.containerId, session.id);
  closeSocket(session.ws, code, reason);
}

/** Keep the newest DETACHED_BUFFER_CHARS, cut at a line start so the replay begins cleanly. */
function trimQueued(out) {
  if (out.length <= DETACHED_BUFFER_CHARS) return out;
  const tail = out.slice(-DETACHED_BUFFER_CHARS);
  const nl = tail.indexOf('\n');
  return nl >= 0 && nl < 4096 ? tail.slice(nl + 1) : tail;
}

/** Resume a paused shell once the client has taken most of what was sent. */
function watchDrain(session) {
  clearTimeout(session.drainTimer);
  session.drainTimer = setTimeout(() => {
    const ws = session.ws;
    if (!sessions.has(session.id)) return;
    if (!ws || ws.readyState !== ws.OPEN || ws.bufferedAmount < RESUME_BELOW_BYTES) {
      session.paused = false;
      try { session.term.resume(); } catch {}
      return;
    }
    watchDrain(session);
  }, 50);
}

/** Send the coalesced output (at most every 10 ms: a DOM-friendly rate under a flood). */
function flush(session) {
  session.flushTimer = null;
  if (!session.out) return;
  const ws = session.ws;
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(session.out);
    session.out = '';
    if (!session.paused && ws.bufferedAmount > PAUSE_ABOVE_BYTES) {
      session.paused = true;
      try { session.term.pause(); } catch {}
      watchDrain(session);
    }
  } else {
    session.out = trimQueued(session.out);
  }
}

function startSession(id, containerId, shell, size) {
  const term = pty.spawn(
    'docker',
    ['exec', '-it', '-e', `${MARKER}=${id}`, containerId, 'env', 'TERM=xterm-256color', shell],
    { name: 'xterm-256color', cols: size.cols, rows: size.rows },
  );
  const session = {
    id, containerId, term, ws: null, out: '',
    flushTimer: null, detachTimer: null, drainTimer: null, paused: false, lastActivity: Date.now(),
  };
  sessions.set(id, session);
  term.onData((data) => {
    session.lastActivity = Date.now();
    session.out += data;
    if (session.ws && session.ws.readyState === session.ws.OPEN) {
      if (!session.flushTimer) session.flushTimer = setTimeout(() => flush(session), 10);
    } else {
      session.out = trimQueued(session.out);
    }
  });
  term.onExit(({ exitCode }) => {
    flush(session);
    endSession(session, CLOSE_EXITED, `The shell exited (code ${exitCode})`);
  });
  return session;
}

/**
 * Bind a socket to a session: input and resizes go to the shell, queued output is sent.
 * `size` is applied only when the client sent one — a reattach must not squeeze the shell
 * to the 80×30 default and back.
 */
function attach(session, ws, size, earlyInput) {
  if (session.ws && session.ws !== ws) closeSocket(session.ws, CLOSE_REPLACED, 'This session was opened in another tab');
  session.ws = ws;
  clearTimeout(session.detachTimer);
  session.detachTimer = null;
  session.lastActivity = Date.now();
  if (size) {
    try { session.term.resize(size.cols, size.rows); } catch {}
  }
  for (const input of earlyInput) session.term.write(input);
  flush(session);

  ws.on('message', (data) => {
    if (session.ws !== ws) return;
    session.lastActivity = Date.now();
    const msg = data.toString();
    const resize = parseResize(msg);
    if (resize) {
      try { session.term.resize(resize.cols, resize.rows); } catch {}
      return;
    }
    session.term.write(msg);
  });
  ws.on('close', (code) => {
    if (session.ws !== ws) return;
    session.ws = null;
    // 1000 is the page closing the terminal on purpose; anything else may come back.
    if (code === 1000) return endSession(session, 1000, 'Closed');
    session.detachTimer = setTimeout(() => endSession(session, CLOSE_ENDED, 'Disconnected for too long'), DETACHED_GRACE_MS);
  });
}

const server = http.createServer((_req, res) => {
  res.writeHead(426, { 'Content-Type': 'text/plain' });
  res.end('Use WebSocket');
});

const wss = new WebSocketServer({
  server,
  maxPayload: 1024 * 1024, // keystrokes and pastes, not files
  verifyClient: ({ req }, done) => {
    if (secretMatches(req.headers['x-rev4a-terminal-secret'])) return done(true);
    done(false, 401, 'Unauthorized');
  },
});

// Heartbeat: every connection must answer a ping within one interval, or it is dropped
// (its session then waits DETACHED_GRACE_MS). Idle sessions end here too.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
  const now = Date.now();
  for (const session of sessions.values()) {
    if (now - session.lastActivity > IDLE_TIMEOUT_MS) endSession(session, CLOSE_ENDED, 'Ended after 30 minutes without activity');
  }
}, HEARTBEAT_MS);

/** Start the shell for a new session id (container checked first), or null after closing `ws` with the reason. */
async function createSession(ws, sessionId, containerId, size) {
  if (sessions.size + starting.size >= MAX_SESSIONS) {
    closeSocket(ws, CLOSE_TOO_MANY, `${MAX_SESSIONS} terminals are already open — close one first`);
    return null;
  }
  const state = await containerState(containerId);
  if (state === 'missing') { closeSocket(ws, CLOSE_NOT_FOUND, `No container named ${containerId}`); return null; }
  if (state !== 'running') { closeSocket(ws, CLOSE_NOT_RUNNING, `${containerId} is not running — start it first`); return null; }
  const shell = await pickShell(containerId);
  if (!shell) { closeSocket(ws, CLOSE_NO_SHELL, `${containerId} has no bash or sh`); return null; }
  try {
    return startSession(sessionId, containerId, shell, size());
  } catch (err) {
    closeSocket(ws, CLOSE_SPAWN_FAILED, `Could not start the shell: ${err.message}`);
    return null;
  }
}

wss.on('connection', async (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});

  // The browser sends its size (and may type) as soon as the socket opens, while the checks
  // below still run: keep the last size and the input, and apply them on attach.
  let attached = false;
  let clientSize = null;
  const earlyInput = [];
  let earlyChars = 0;
  ws.on('message', (data) => {
    if (attached) return;
    const msg = data.toString();
    const resize = parseResize(msg);
    if (resize) clientSize = resize;
    else if (earlyChars + msg.length <= MAX_EARLY_INPUT_CHARS) { earlyInput.push(msg); earlyChars += msg.length; }
  });

  const url = new URL(req.url || '/', 'http://localhost');
  const containerId = url.searchParams.get('id') || '';
  const requested = url.searchParams.get('session') || '';
  // `resume=1`: the page is reconnecting to a shell it had — if that shell is gone, say so
  // instead of silently handing over a new one.
  const resuming = url.searchParams.get('resume') === '1';
  const sessionId = SESSION_RE.test(requested) ? requested.toLowerCase() : randomUUID();

  if (!CONTAINER_RE.test(containerId)) return closeSocket(ws, CLOSE_NOT_FOUND, 'Invalid container name');

  // Another socket is starting this very session (a duplicated tab while connecting): wait for it.
  if (starting.has(sessionId)) await starting.get(sessionId);

  const existing = sessions.get(sessionId);
  if (existing && existing.containerId === containerId) {
    if (ws.readyState !== ws.OPEN) return;
    attached = true;
    return attach(existing, ws, clientSize, earlyInput.splice(0));
  }
  if (resuming) {
    return closeSocket(ws, CLOSE_ENDED, 'The previous shell has ended (disconnected for more than 2 minutes, or Rev4a restarted)');
  }

  // A session id already used for another container starts fresh under a new id.
  const id = existing ? randomUUID() : sessionId;
  const creation = createSession(ws, id, containerId, () => clientSize || { cols: 80, rows: 30 });
  starting.set(id, creation);
  const session = await creation.finally(() => starting.delete(id));
  if (!session) return;
  if (ws.readyState !== ws.OPEN) {
    // The browser left while the shell started: keep it for a reconnect, as after a drop.
    session.detachTimer = setTimeout(() => endSession(session, CLOSE_ENDED, 'Disconnected for too long'), DETACHED_GRACE_MS);
    return;
  }
  attached = true;
  attach(session, ws, null, earlyInput.splice(0));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[TerminalWS] Server listening on ws://127.0.0.1:${PORT}`);
});

if (!SECRET) console.log('[TerminalWS] REV4A_TERMINAL_SECRET is not set: every connection will be refused (start with `rev4a serve`).');

process.on('SIGTERM', () => {
  console.log('[TerminalWS] Shutting down...');
  clearInterval(heartbeat);
  for (const session of sessions.values()) endSession(session, 1001, 'Server shutting down');
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  // Give the in-container clean-ups (`docker exec … kill`) a moment before exiting.
  setTimeout(() => server.close(() => process.exit(0)), 1500).unref();
  setTimeout(() => process.exit(0), 3000).unref();
});
