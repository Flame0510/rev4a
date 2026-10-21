# Container Terminal — WebSocket PTY

> **Status:** Active — `main` branch
> **Last updated:** 2026-09-26

---

## Overview

`/containers/terminal/<name>` opens an interactive shell in a running Docker container —
any container on the host (the Containers page links every running one). It is a real
terminal: raw keystrokes, Tab completion and bash history, Ctrl-keys, cursor movement,
full-screen programs (`top`, `vi`, `less`), resize, progress bars.

```
Browser  xterm.js (@xterm/xterm)
  │  ws(s)://<dashboard host>/api/terminal-ws?id=<container>&session=<uuid>[&resume=1]
  ▼
server.js  (port 3740 — the dashboard's own port)
  │  checks the Origin, the session cookie and the container name,
  │  then forwards the handshake with the per-boot secret (no cookie)
  ▼
terminal-ws-server.js  (127.0.0.1:3741 only)
  │  node-pty
  ▼
docker exec -it -e REV4A_TERMINAL_SESSION=<uuid> <container> env TERM=xterm-256color <bash | sh>
```

It needs **no reverse proxy**: the browser talks to the dashboard's own host and port,
locally or over a plain-IP VPS. Behind a proxy, see [Reverse proxies](#reverse-proxies).

## Processes

`rev4a serve` starts three processes under one systemd unit (`rev4a.service`):

| Process | Listens on | Role |
|---|---|---|
| `server.js` | 3740, all interfaces | Next.js (pages, API, `proxy.ts`) through its programmatic API, plus the WebSocket upgrade on `/api/terminal-ws` |
| `daemon.js` | — | Session collector (reads each agent container) and machine metrics |
| `terminal-ws-server.js` | 127.0.0.1:3741 | The PTYs and their sessions |

The terminal server is its own process so a flood of shell output never stalls the
dashboard's event loop. `server.js` replaces `next start`; every HTTP request goes to
Next.js unchanged. `npm run dev` (`next dev`) has no terminal: use `rev4a serve`.

## Security

At the upgrade, in `server.js`, in this order:

| Check | Refused with |
|---|---|
| The path is `/api/terminal-ws` (no other path takes an upgrade) | `404` |
| `Origin` equals the host the browser addressed: `Host`, or `X-Forwarded-Host` from a proxy; case and the scheme's default port are ignored. Blocks a page on another site from opening a shell with the user's cookie (cross-site WebSocket hijacking); a browser cannot set `X-Forwarded-Host` on a WebSocket, so accepting it opens nothing | `403` |
| The `rev4a_token` cookie verifies — the JWT the dashboard pages require (`REV4A_JWT_SECRET` from the environment or `.env`); a bearer token is not accepted here | `401` |
| The container name matches Docker's pattern (`[a-zA-Z0-9][a-zA-Z0-9_.-]*`, ≤128 characters) | `400` |
| The per-boot secret is set (Rev4a started with `rev4a serve`) | `503` |
| The terminal server answers (refused → `502`, silent for 10 s → `504`) | `502` / `504` |

The handshake is then replayed to 127.0.0.1:3741 **without the cookie** and with
`X-Rev4a-Terminal-Secret` (any copy the client sent is dropped): a random value
`rev4a serve` generates at every start and passes to both processes in the environment
(`REV4A_TERMINAL_SECRET`, never in argv). The terminal server refuses any handshake
without it (`401`, constant-time comparison), so another local user who reaches the
loopback port gets nothing. Started without the variable, both sides say so in the log.

The terminal server then checks the container exists and runs (`docker inspect`) and
picks `bash`, or `sh` when the image has none. Every host-side Docker call passes argv —
no host shell. Inside the container two fixed `sh -c` scripts run (the shell lookup and
the clean-up below); the session id reaches the clean-up as an argument, never
interpolated.

What an authenticated user can do is the single-admin model: open a shell in any running
container. Sessions are not bound to the login that opened them — any valid cookie can
resume a session id it knows — and an open socket is not re-checked when the login
expires; closing the tab or **Close** ends it. The session id travels in the WebSocket
URL, so a reverse proxy's access log records it.

## Sessions

The browser names its session: a UUID kept in `sessionStorage` per container, sent as
`&session=`. The shell belongs to that id, not to the socket:

- **Drop** (network, laptop sleep): the shell keeps running for **2 minutes**, its output
  queued (the newest 64 K characters, cut at a line start). The page reconnects with
  `&resume=1` and is attached to it, receiving the queued output — a command started
  before the drop finishes and is seen. Past 2 minutes (or after a Rev4a restart) the
  shell is gone and the resume is answered with `4002` and the reason; **Reconnect**
  starts a new one.
- **Reload** resumes the same shell while it lives (same tab, same `sessionStorage`); a
  reload after it ended simply starts a new one.
- **Close** (the button) ends it at once: the page sends close code `1000` — or, while it
  is reconnecting, briefly attaches only to send it — the id is forgotten, and the next
  visit starts a new shell.
- **The same session in two tabs** (a duplicated tab copies `sessionStorage`): the newer
  takes it, the older is closed with `4003`. Two sockets starting the same new id at once
  get one shell: the second waits for the first.
- **Idle**: no input and no output for 30 minutes ends the shell (`4002`).
- **Heartbeat**: the server pings every 25 s; a socket that misses a ping is dropped
  (its shell then waits the 2 minutes). Keeps idle links open through NAT and finds dead peers.
- **Limits**: at most 20 shells at once (`4429`); keystrokes typed before the shell starts
  are kept up to 64 K characters; a message is at most 1 MB.
- **Backpressure**: when 1 MB of output waits for a slow client the shell is paused, and
  resumed below 256 KB — `yes` or a huge `cat` cannot grow the server's memory.

**Ending a session ends the shell inside the container.** Killing the host's `docker exec`
client alone does not: Docker leaves an exec running when its client goes away, so every
closed terminal used to leave a shell (and anything running in it) in the container. The
shell is started with `REV4A_TERMINAL_SESSION=<id>` in its environment, which every
process it starts inherits; ending the session runs, in the container, a scan of
`/proc/*/environ` for that marker — `SIGHUP` to what carries it (a terminal hangup), then
`SIGKILL` a second later to what ignored it. Needs `sh`, `tr` and `grep` in the image
(BusyBox and Debian/Ubuntu images have them).

Sizes: the page sends `{"type":"resize","cols":n,"rows":n}` on connect and whenever the
terminal's columns or rows change; a size or keystrokes sent while the server still
checks the container are kept and applied when the shell starts. A resume keeps the
shell's size until the page sends its own.

### Close codes

| Code | Meaning | Client |
|---|---|---|
| `1000` | Closed on purpose by the page | Stops, shows **Reconnect** |
| `4001` | The shell exited (`exit`, Ctrl-D) | Stops, shows the reason, **Reconnect** starts a new shell |
| `4002` | Idle for 30 minutes, or a resume found the shell already gone | Same |
| `4003` | The session was opened in another tab | Same |
| `4404` | No such container / invalid name | Same |
| `4409` | The container is stopped | Same |
| `4410` | No `bash` or `sh` in the container | Same |
| `4429` | 20 shells already open | Same |
| `4500` | The PTY could not be started on this host | Same |
| other (1006…) | The connection dropped | Reconnects: 1 s, 2 s, 5 s, then every 10 s |

Six handshakes in a row that fail before opening (about 40 s: not logged in, Rev4a down
or restarting, a proxy refusing the upgrade) stop the retries with a message and the
**Reconnect** button.

## Reverse proxies

Rev4a needs none, but works behind one that:

- forwards WebSocket upgrades on `/api/terminal-ws` **to port 3740** (the dashboard), like
  every other path. A route sending `/api/terminal-ws` to **3741** — what older versions
  asked for — must be removed: 3741 now answers `401` to anything but `server.js`;
- keeps the host the browser used, in `Host` or `X-Forwarded-Host`. nginx replaces `Host`
  with the upstream address by default: set `proxy_set_header Host $host;` (or
  `X-Forwarded-Host $host`), plus `proxy_http_version 1.1`, `Upgrade $http_upgrade` and
  `Connection "upgrade"`. Otherwise the Origin check answers `403`.
- sends the real client in `X-Forwarded-For`, and is listed in `REV4A_TRUSTED_PROXIES`. nginx on
  the same host needs `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` and
  `REV4A_TRUSTED_PROXIES=127.0.0.1` (add `,::1` if it connects over IPv6). The dashboard login lock is
  keyed by client address and trusts `X-Forwarded-For` only from listed peers; without the
  variable every visitor shares the proxy's address. On Docker Desktop, containers reach the
  host from 127.0.0.1, so listing it lets agents choose their key: prefer a proxy with its own
  address there, or accept the risk.

## Terminal client (browser)

`app/containers/terminal/[id]/TerminalClient.tsx`: **xterm.js 6** (`@xterm/xterm`) with
`@xterm/addon-fit` (sizes the terminal to its box, refitted by a `ResizeObserver`) and
`@xterm/addon-web-links` (http/https URLs open in a new tab). Keystrokes go to the socket
as they are typed (`onData`, and `onBinary` for legacy mouse reports); output is written
as it arrives. 5 000 lines of scrollback, its own scrolling and selection. Copy with the
system shortcut where it is not Ctrl-C (Cmd-C on macOS); in a terminal Ctrl-C belongs to
the shell. Loaded in the browser only (dynamic import). The palette comes from the design
tokens. The session id is a random UUID from `crypto.getRandomValues` —
`crypto.randomUUID()` exists only in secure contexts, and a dashboard served over plain
HTTP by IP is not one.

The page is full screen: a bar (`ui-kicker`, the container name, a status `Badge` —
Connecting, Connected, Reconnecting, Closed — and `Button`s **Reconnect** / **Close**),
a notice line when the session stopped, and the terminal. Styles are the `terminal-page`
classes in `globals.css`.

### Why xterm.js again

The first version (June 2026) used xterm.js 5.3 and was replaced the same day by a
custom DOM renderer after a black screen on large output, broken scrolling and selection
problems — layout issues under `html, body { overflow: hidden }` with a viewport that
never sized. The custom renderer could not be a terminal: it sent whole lines on Enter
(no Tab completion, no bash history), never sent a size, and stripped `\r` and cursor
movement (no progress bars, no `top`/`vi`/`less`). xterm.js 6 now lives in a fixed-size
box sized by `addon-fit`. Before it replaced the custom renderer it was checked in a real
browser (Playwright, 2026-09-26) against those failures: 20 000 lines of `seq` render to
the last line, the alternate screen and cursor addressing work (BusyBox `top` renders),
resize reaches the PTY (`tput cols`).

## Troubleshooting

| Symptom | Cause |
|---|---|
| "Cannot open the terminal" after about 40 s | Not logged in (session expired); Rev4a down; or a reverse proxy not forwarding the upgrade to 3740 or rewriting `Host` (see [Reverse proxies](#reverse-proxies)) |
| "No container named …" / "… is not running" | The container is gone or stopped: an agent is started from the Agents page, any other container with `docker start` |
| "The previous shell has ended" | The connection was down for more than 2 minutes, or Rev4a restarted: **Reconnect** opens a new shell |
| "Could not start the shell: posix_spawnp failed" (macOS) | node-pty's `spawn-helper` lost its execute bit; `terminal-ws-server.js` restores it at start — restart Rev4a |

## Files

```
server.js                                   # HTTP + terminal upgrade on the dashboard port
terminal-ws-server.js                       # PTYs, sessions, clean-up, heartbeat (127.0.0.1)
app/containers/terminal/[id]/page.tsx       # the page (auth-protected by proxy.ts)
app/containers/terminal/[id]/TerminalClient.tsx
```
