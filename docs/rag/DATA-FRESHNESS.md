# Data Freshness in Rev4a

> **Last updated:** 2026-11-18

Understanding how current the data in Rev4a is — and what is truly real-time vs. periodically updated.

## Agent ports

Since 1.30.0, the agent panel's **Ports** list samples the container's TCP listeners when
the panel opens and on Refresh. The status is unknown when the container is stopped or its
TCP tables cannot be read. Public URLs reflect the managed routes at the time of the read.

---

## Session data

**Update frequency:** every 30 seconds while one of an agent's sessions is running, about
every 60 seconds when it is idle (longer for an agent that does not answer)

The daemon reads each running agent's sessions from inside its container, one agent at a
time (a read takes 5-12 seconds). Session statuses and token counts are therefore up to a
minute behind reality, a little more with many agents. A stopped agent keeps its sessions,
marked as gone. The Mac's own OpenClaw (outside Docker) is not read.

**What this means for PULSE:** if you ask "is Argus working right now?", the answer reflects
data that is up to a minute old.

---

## Event feed

**Update frequency:** every 5 seconds (via SSE stream)

The `/api/stream` endpoint pushes updates to the dashboard every 5 seconds. It
sends exactly three things:
- New events (session_started, subagent_spawned, session_ended, session_failed, session_aborted, system_anomaly)
- The session list
- Today's cost total

Sessions arrive over the stream only when the daemon stored a change; the Lineage page also fetches them itself.

The event feed is as close to real-time as Rev4a gets. However, events are
written by the daemon — session events by its reads of the agents (every 30 to 60 seconds),
system anomalies by its machine sampling — so an event that just happened may take up
to about a minute to appear, plus up to 5 more to reach the browser.

---

## System metrics (CPU, RAM, disk)

**Update frequency:** every 30 seconds, sampled by the Rev4a daemon on its own timer
(it does not depend on OpenClaw being installed on the host). The System page refreshes
every 30 seconds too, so a figure is at most about a minute old.

**Retention:** 30 days, in their own database (`metrics.db`).

Shown on the **System** page (`/system`) — current CPU, memory, swap and storage, and
their history over 1 hour, 24 hours, 7 days or 30 days — and, as three figures, on the
Dashboard's Machine card. If the newest sample is older than 90 seconds the page says
the collector is not running instead of showing stale numbers as current.

---

## Container consumption (System page, Containers page, agent panel)

**Update frequency:** every 60 seconds for CPU, memory, processes, network and block I/O of
each running container; every 10 minutes for the disk Docker holds (volumes, writable layers,
images, build cache). Both are sampled by the Rev4a daemon on timers of their own and kept 30
days in `metrics.db`. The first figures after the daemon starts take about 20 seconds (a CPU
figure needs two readings). A stopped container leaves a gap in its charts, not zeros.

CPU is a share of Docker's cores and memory a share of Docker's memory: on Docker Desktop that
is its virtual machine (for example 8 GB of a 16 GB Mac), on a server it is the machine. If the
newest sample is older than three minutes the System page says it is not collecting — the
figures still on show are the last known ones, not live. The agent panel stands its "now" rows
down, and the Containers page clears its usage row rather than leave stale figures. A container
still seen in Docker's list but without fresh statistics says "no data", not "stopped".

## Agent costs (Costs page)

**Update frequency:** every 5 minutes. The Rev4a daemon asks each running agent
what it spent and keeps the figures in their own database (`costs.db`); the page
refreshes every minute. An agent whose figures could not be read recently is listed
under **Not current** with the reason.

Next to them the page shows what the Rev4a proxy metered per agent: it is written
as each call finishes (a streamed call when its stream ends), so it is current to the
minute; the page counts the larger of the proxy's and the agent's figure. Agents
send their id with each call after the startup sync; calls without it are listed as
"Unidentified callers".

The agent figures are computed by each agent's own OpenClaw, with the prices Rev4a writes
into the agent for every model. A call to a model without a price is counted but not
priced: the page lists those under **Calls without a price**. Days are UTC. DeepSeek
bills half price off-peak; Rev4a switches the agents' prices at each change, so each
call is priced at the rate it ran at.

## Cost totals (dashboard)

The dashboard's "Spent today" card and "Spent by model" list, and the COSTS section of an
agent's panel, show the agents' own figures for today (UTC day): up to 5 minutes behind the
agents. The Costs page's Spent can be higher: it counts, per agent, the larger of the agent's
figure and what the Rev4a proxy metered, and the proxy's figure is written as each call ends,
not every 5 minutes. Calls made with a ChatGPT subscription are in none of these figures; the Costs page's *ChatGPT subscription* and *Claude subscription* sections show them from the same 5-minute readings. The vendor readings behind *Against the bill* on the Costs page are taken
once an hour.

## Update screen

While Rev4a updates itself, the "Updating Rev4a" screen polls `GET /api/update-status` every
3 seconds. Outside an update every open tab polls it every 30 seconds, which is how a tab
learns that an update started in another tab or from a terminal.

---

## Cron jobs

**Update frequency:** on demand (fetched live from OpenClaw gateway on page load)

Cron status (last run, next run) is fetched directly from the OpenClaw gateway each time the Crons page is loaded. It is not stored in the database.

**Note:** if the OpenClaw gateway returns a scope-blocked error when listing crons, Rev4a may show no crons even if crons exist. This is an authorization scope issue, not a real absence of crons.

---

## Agent configuration

**Update frequency:** on demand (read from `openclaw.json` on each request)

The agents list, Telegram accounts, and bindings are read directly from
`openclaw.json` each time they are requested.

There is no page or route for this any more: per-agent settings are reached from
the agent's detail panel on the Agents page.

## Subscriptions (ChatGPT / Codex and Claude)

**Update frequency:** the status of each agent is read live (about 0.5 s for ChatGPT, up to about 40 s for Claude Code, on every request; a read that fails is retried up to twice (1 s, then 2 s; a timeout only once, so at most about 27 s) and then shown as an error with a Retry button, never read through the slower CLI); the model list of either provider is cached 10 minutes. The server caches ChatGPT and Claude usage limits for 3 minutes per account, including failed reads. A Claude read makes one small Claude Code call. The Subscriptions page and the agent panel re-read the cache every 60 s while visible and when the tab gets focus. The container list behind these reads is cached 5 s and the account-to-agent lookup 60 s. The Claude login dialog polls the in-memory job every 2 s while it runs.

**Refresh**, **Check again** and the automatic checks after **Open claude.ai** bypass the
usage cache for that account with `refresh=1`.

## Agent base image

**Update frequency:** polled every 2 seconds, continuously

`GET /api/agents/image-status` lists the supported OpenClaw versions downloaded and
compares them with the versions the registry publishes, and checks that each downloaded version is the image build this release expects (a newer build of the same version shows as outdated). The registry list is refreshed
at most every 10 minutes, so a newly published version can take that long to appear.
The banner polls the endpoint every 2 seconds for as long as the page is open, not only
while something is running.

The operation the banner triggers is a **`docker pull`**, not a build (unless the
pull fails and this repository's own Dockerfile builds that exact version, a
development fallback). While it runs the banner shows the percent of layers
finished and the latest line of docker's output; the bar is indeterminate until a
percent can be computed (while the version is resolved and the layers are listed,
and during the local-build fallback). The percent never goes down and stops at 99:
completion is announced by the outcome, not by 100%. A **Cancel** button, offered
once the download is running, stops it — the `docker pull`/`docker build` process is
killed, or never started if the cancel came first. A log is written server-side to
`/tmp/rev4a-download-<timestamp>.log`, but nothing in the dashboard reads it.

The outcome comes from the server's own record of the last download: "ready" and
"canceled" show for 3 seconds, a failure stays until the next action. An outcome
that happened while the Agents page was closed or reloading is still reported if it
is less than 30 seconds old.

---

## Memory / context files

**Update frequency:** on demand (files read from disk on each request)

The Context page reads the agent's workspace inside its container each time, and the server keeps the answer for 30 seconds per agent (Reload skips it). It holds sizes and times only, never file contents.

---

## What is NOT real-time

| Data | Why it may be stale |
|---|---|
| Cron sessions older than 7 days | The daemon prunes cron session rows after 7 days |
| Sessions never polled by daemon | If the daemon was down, sessions from that window are missing |
| Costs before Rev4a was installed | Historical data before the first daemon run is not available |
| Events older than 30 days | The daemon deletes every event older than 30 days, whatever its type |

---

## How to check if data is fresh

System health is a card on the **Dashboard**, not a page of its own. Its checks
cover session runtime, the daemon heartbeat, failed runs in the last 24 hours
("Failed runs (24h)": failed or timed-out runs), what the agents spent today, and cron jobs. CPU, RAM and disk are on the System page (`/system`)
and the Dashboard's Machine card instead.

To check directly on the server:
```bash
sqlite3 ~/.config/rev4a/data/events.db \
  "SELECT datetime(MAX(ts)/1000, 'unixepoch', 'localtime') FROM events"
```

The database lives under the Rev4a data directory, which defaults to
`~/.config/rev4a/` and moves with `REV4A_DATA_DIR`. It is not inside the repo.
