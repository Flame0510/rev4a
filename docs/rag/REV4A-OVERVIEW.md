# What is Rev4a?

> **Last updated:** 2026-10-10

Rev4a is the control panel for your AI agent infrastructure. It shows you everything your agents are doing, how much they cost, and whether the system is healthy — all in one dashboard.

## What can you do in Rev4a?

### Dashboard (`/`)
The main page. See live sessions (who's working right now), cost summary, an overall health indicator, and a real-time event feed. Click any session row to open the Session Drawer and see the session's recent actions.

The health cards cover Rev4a's own runtime, cron and watchdog, and lineage. The Machine card shows the server's CPU, RAM and fullest disk right now, coloured when it reaches a threshold, and links to the System page for details. There is no wizard banner on the dashboard; an incomplete setup redirects to `/wizard` instead.

### First-run wizard (`/wizard`)
First-run setup wizard that guides new users through configuration. Four steps:
1. **Welcome** — what Rev4a is and what it can do
2. **Providers** — add API keys for DeepSeek, OpenAI, OpenRouter, or Groq (saved via the Provider Gateway)
3. **First Agent** — understand how agents work and what you need to create one
4. **Ready** — site map of key sections with quick links

The wizard is always accessible from the sidebar. There is no progress badge on that entry and no banner elsewhere.

### Agents (`/agents`)
Manage Docker containers running OpenClaw agents. See which agents are running, stopped, or errored. Filter by status, view agent details (environment variables, ports, auth tokens, backups, Telegram channels), and create new agents. Each agent card shows its template, status, TG channel chip, and a direct link to its Control UI.

The RESOURCES section of an agent's panel starts with its **memory limit**: the limit, the memory in use against it and an Edit button. A size is applied live without a restart; removing the limit rebuilds the container (the agent restarts, its data is kept). An "Out of memory" note shows when a process in that agent was killed for lack of memory in the last 24 hours.

**Agent Creation Wizard** (`/agents/create`) — two-step flow:
1. Pick a template: **Atlas** (general dev), **Argus** (security/audit), **Prometheus** (client-facing), or **Custom** (blank slate)
2. Configure: name, optional port, optional model → Deploy

**Custom template:** starts with no preset identity. On first run, the agent runs a bootstrap ritual (BOOTSTRAP.md): introduces itself, asks who the user is, and together they define name, personality, tone, and boundaries. No AI generation needed — it's a native OpenClaw feature.

**Channel Manager:** Each agent detail panel has a "CHANNELS" section with TG status badge and a "Manage Channels" button. The modal lets you:
- **Telegram:** connect a bot (paste bot token → save → restart agent), disconnect, and manage pairings (approve pending codes, revoke approved senders). Pairings are polled every 5 seconds.

The agent list also shows a compact TG chip next to each agent name (green = connected, hidden if not configured).

**Browser access:** on agents running OpenClaw 9.x, every new browser has to be approved once before the agent's Control UI connects. The detail panel's "BROWSER ACCESS" section lists browsers waiting for approval, with Approve and Reject, and the browsers already approved, with Rename and Revoke. A yellow "BROWSER WAITING" chip on the agent card says a request is pending. The **Open** button tries a one-time link that lets the browser in without any approval; if the agent cannot issue one (it is stopped, or the link fails) it opens the normal link. To let someone else in, **Invite link** gives a link to send them: their browser appears under waiting for approval, and nothing opens until you approve it. The link contains the token all agents share; changing the agents token cancels every link already sent.

Rev4a itself has an **"Update available"** banner: it starts `rev4a update` and the server
restarts itself, so the dashboard drops briefly. The banner is only shown when a newer
version is published; it waits for the restart and then confirms the new version, or
reports that the update did not complete and points at `update.log` in the Rev4a data
directory, where the update's output is written. While it runs, every open tab shows a
full-screen "Updating Rev4a" screen with the current phase and reloads when the new
version answers; if the update fails it shows the error and the log with Retry, Reload and
Dismiss.

The Agents page includes a banner for the **agent base image**, which is kept per
OpenClaw version. It is hidden when a supported version is downloaded and nothing newer
is published and every downloaded version's image is the newest build. When no image is downloaded it offers **Download Image**; when a newer
supported OpenClaw version is published it says so and offers **Download <version>**; when the image of a downloaded version is an older
build than the one this Rev4a release expects it says "A newer build of the agent image
<version> is available" and offers **Download new build of <version>**. Agents keep their
current image until they are recreated (a new build of the same version reaches an agent only by a recreate; an update to a newer OpenClaw version moves it too).
Downloading changes no agent: new agents are created on the newest version downloaded,
existing agents keep their version (a recreate never changes it), and their card shows
**UPDATE AVAILABLE**. A card badge **NEW BUILD** means a newer build of the agent's own OpenClaw
version is downloaded: recreate the agent (a cold backup is taken first) to use it.

**Programs agents install.** Only an agent's `/root` volume survives a recreate or an
OpenClaw update. On agent images built since 2026-10-06, what an agent installs with
`apt-get install` / `apt install` is recorded (with the apt sources and keys it added) and
installed again automatically in the background after a recreate; packages installed before
that image, local `.deb` files and tools installed another way (`npm -g`, downloaded
binaries) are not, and should live under `/root/.local`. The dashboard does not show the
outcome yet: it is in `/root/.rev4a/packages-status.json` inside the agent (open the agent's
terminal), with the state `running`, `ok`, `partial`, `failed` or `nothing-to-do`.

**Updating an agent:** the detail panel's "OPENCLAW VERSION" section shows the version the
agent runs and, when a newer one is downloaded, **Update to <version>**. The update takes
the agent offline for a few minutes: it backs the agent up while stopped, starts it on the
new version (which converts its data), and checks that no conversation history or cron job
went missing. Afterwards **Roll back to <version>** puts back the backup taken just before
the update, on the old version; anything the agent did after the update is lost. The agent
must be running to start an update.

The agent base image banner above (not this update — an agent's own **Update to
<version>** recreates it on an image already downloaded) is the one running the
`docker pull`. While it runs the banner shows the percent of layers finished and the
latest line of docker's output; a **Cancel** button, offered once the download is
running, stops it. There is no modal, no "View Progress", no "Run in Background". The
outcome ("ready" and "canceled" for 3 seconds, a failure until the next action) is
reported even when it happened while the Agents page was closed or reloading, if it is
less than 30 seconds old. Status is polled every 2 seconds.

### Create Agent (`/agents/create`)
Wizard to spin up a new agent. Steps: choose a template (Prometheus, Argus, Atlas, etc.), name your agent, pick a model, set an optional port range (default: auto-assigned 10-port block, e.g. 3700-3709). An optional **memory limit** can be picked in the same step (No limit, 1.5 to 16 GB, or a custom size in GB; below 2 GB the picker warns that the agent may be killed while it starts). The default it offers is set on the Config page (Agent defaults). The agent is created as a Docker container with a persistent volume — all config, workspace files, and credentials survive container restarts.

### Lineage (`/lineage?period=7d`)
Interactive graph showing session family trees — which agent spawned which child agent, across configurable time periods: 1d, 3d, 7d, 15d, 30d, and all. Click any node to inspect. Includes a live feed side panel.

### Gateway (`/gateway`)
Connects agents to AI providers. Add and remove provider API keys, enable or disable individual models in the catalogue read from `models.config.json`, and push the resulting model list to every agent container. It does not assign models to agents: choosing which model an agent runs is done per agent, in the Model section of the agent's detail panel on the Agents page. A DeepSeek model row shows its current rate and a peak/off-peak chip; the rate updates after the next band change. Every model row has a **Details** button: the modal shows the model's description, list price and provider, its architecture and parameter count when the weights are public, reasoning modes, capabilities, benchmarks with sources, licence and how much disk the weights take — the numbers come from the model card on Hugging Face and from curated entries that cite a source, never from estimates.

### Containers (`/containers`)
Full list of all Docker containers on the server, including stopped ones. Each row shows name, status, image, IP, ports, and an agent pill where applicable. Click "Terminal" to open an interactive shell into that container. A running container also shows what it consumes now — CPU share, memory and processes — with a "Charts" link to its history on the System page.

The page has no start, stop, or restart buttons: it is read-only apart from the terminal link. Container lifecycle is managed from the Agents page.

### Costs (`/costs`)
What each agent spent, as its own OpenClaw priced it with the prices Rev4a syncs. Pick today, 7 days or 30 days (UTC days): the total, where the money went (input, output, cache), the tokens and how much input came from cache, a chart of the spend per day, the spend by agent and by model, and the most expensive sessions. *Metered at the proxy* shows, per agent, what the Rev4a proxy counted for every call it carried next to what the agent itself recorded; the page counts the larger of the two, and marks an agent when the proxy saw clearly more (for example calls from a loop that were never recorded). Calls that could not be priced are listed by model, and agents whose figures are not current are flagged. When a DeepSeek model is on offer, the header shows whether DeepSeek is billing peak or off-peak (half price) and until when. Figures are read from the agents every 5 minutes. *Against the bill* compares them with what DeepSeek and OpenRouter actually charged (their balance or usage, read every hour); a small gap is normal, since the same key may pay for the assistant too. Each agent's own spend is also in its panel on the Agents page (COSTS), with the current DeepSeek band (Rates now).

### System (`/system`)
The machine Rev4a runs on. Three cards — CPU (percent, cores, load average), memory (used, available, swap) and storage (each disk with its used and free space, and whether it is the system disk, where Docker keeps agents, or where Rev4a keeps its data) — then charts of CPU, memory and each disk over 1 hour, 24 hours, 7 days or 30 days (for CPU and memory the average line with the peak shaded). Hover a chart (or focus it and use the arrow keys) to read a point; each chart has a Table view. Bars turn yellow and red when they reach their thresholds. Figures refresh every 30 seconds; history is kept 30 days.

At the top of the System page a **Memory limit** warning appears when the running containers use 85 % or more of Docker's memory and at least one running agent has no memory limit or its limit could not be read; it links to those agents.

### Agents and containers (on the System page)
Under the machine's charts: what Docker holds on disk (images, volumes, writable layers, build cache, and how much of each no container uses), then one row per container sorted by CPU. A closed row shows its name, whether it is an agent, and its CPU share, memory, storage and processes now, with the average and peak over the chosen range (1 hour to 30 days); open it for the same three charts as the machine — CPU, Memory, Storage — for that container. "Everything else" is what is not a container (the host, Rev4a, other software). Each agent's panel on the Agents page has the same numbers in its RESOURCES section, with a link to its charts. Below, the recent alerts: CPU, memory or a disk that crossed its limit, a container with 1000 or more processes on two samples in a row, or one holding 90 % of Docker's memory for five, a process killed for lack of memory in an agent (an out-of-memory alert, `container_oom`: at most one per container per 10 minutes, with the number of kills in between; it can happen with or without a memory limit), and when.
When Docker still sees a container but it has no current statistics, its row says "no data". If collection stops, the current figures are hidden and old rows say "not current" instead of implying a live reading.

### Container Terminal (`/containers/terminal/[id]`)
Live web terminal into a running Docker container — like SSH in the browser: Tab completion, command history, `top`, `vi`, resizing with the window. If the connection drops (network, laptop sleep) the shell keeps running for 2 minutes and reconnecting picks it up; reloading the page resumes it too. **Close** ends the shell. If the container is stopped or missing, the page says so and offers **Reconnect**. Only a logged-in user can open it.

### Workspace (`/workspace`)
File explorer for the OpenClaw workspace. Browse, view, and edit files across workspaces: the VPS host workspace and every agent container workspace. Switch between workspaces via a dropdown. Supports binary file preview (images) and text editing with syntax awareness.

### Credentials (`/credentials`)
Manage third-party service credentials: GitHub, Trello, Vercel, Supabase, Notion. Each credential lists agents with a Switch. Switching on puts the token into the agent's OpenClaw secret store as an environment variable (`SUPABASE_ACCESS_TOKEN`, `TRELLO_API_KEY` and `TRELLO_TOKEN`, `NOTION_API_TOKEN`) and enables the matching skill; no TOOLS.md entry is written. GitHub and Vercel are the exception: OpenClaw reserves `GH_TOKEN`/`GITHUB_TOKEN` and the Vercel CLI ignores a token-only environment, so GitHub is delivered as OpenClaw's managed GitHub identity (a handoff plus `tools.github.configure`) and Vercel through the CLI's own `auth.json` + `config.json {currentTeam}`. Delivery needs OpenClaw 2026.9.0 or newer on the agent (Trello needs 2026.9.9, whose image ships the `jq` its skill requires); older agents can still be detected and have legacy credentials switched off. Each row's Switch shows what the agent really holds (Rev4a reads the container, so a credential changed from another Rev4a or on the agent itself shows as it is). A credential enabled in Rev4a but missing from the agent says "Not found in the agent" with Redeliver and Remove actions; an unknown read shows `?` and Rev4a's setting; stopped and busy agents show a disabled Switch with a reason. An agent that holds another credential of the same provider says which one. An agent on the ChatGPT subscription runtime gets a note: the token reaches only commands run through OpenClaw. The agent panel has a read-only CREDENTIALS section. A credential switched on for any agent, or whose switch-off failed ("Removal failed", Retry removal), cannot be deleted. Before rolling Rev4a back to an older version, switch credentials off. Every reveal is recorded in an audit table, which no route or view reads. Gateway CLI calls use the token from `/root/.agent-token` when present, so a rotated token does not break credential switches. Secrets are held unencrypted in `credentials.db`, and in the agent's secret store (or, for GitHub and Vercel, OpenClaw's managed `gh` profile and the Vercel CLI files).

### Subscriptions (`/subscriptions`)
Connect a ChatGPT Plus or Pro (Codex) account to an agent and let the agent use a subscription model as its primary model. To connect, press Connect on the agent's row: Rev4a shows a link and a code, and you enter the code on OpenAI with your ChatGPT account (the code expires in 15 minutes). The page shows which agents are connected and until when, and the model each one uses. The model itself is chosen in the agent's MODEL section (agent panel), where subscription models appear next to the Rev4a proxy models for the primary and the fallbacks. When you pick a subscription model as primary with no fallback set, the panel pre-fills the previous model as the first fallback, so when the subscription reaches its usage limit (shared with your own Codex use) the agent falls back to it. Disconnect (after a confirmation) returns the agent to its own model and signs the account out. Subscription calls are not counted as spend: the Costs page shows them in their own "ChatGPT subscription" section with their API value (what the same calls would have cost at OpenAI API prices). The page also shows, at the top, the account's usage limits (5 hours and weekly, with the reset times); the quota belongs to the ChatGPT account, so it is shared by every agent signed in with it and your own Codex use. The sign-in stays inside the agent; Rev4a stores nothing. A row whose status could not be read shows the reason and a **Retry** button ("the agent is still starting" clears by itself). An agent on an unsupported OpenClaw version says so ("This agent is not on a supported OpenClaw version … Update it first."); it must be updated on the Agents page.

### Crons (`/crons`)
Scheduled tasks auto-discovered from the host OpenClaw gateway (via `openclaw cron list --json`) and every running Docker container with the `AGENT_ID` label (via `docker exec openclaw cron list --json`). Filter jobs by agent using the toolbar tabs. Each job shows name, description, cron expression, next run, last run, and last status. Toggle on/off per job. The run history panel shows recent cron run executions for the selected job, loaded on demand from the container's gateway.

### Memory / Context (`/memory`)
Browse agent memory files. The tracked set is USER.md, MEMORY.md, AGENTS.md, SOUL.md and HEARTBEAT.md. These files define how agents behave, what they know, and their personality. Also shows total memory budget vs usage.

A template may ship other files, such as IDENTITY.md or TOOLS.md, but those are not part of the tracked context set.

### Config (`/config`)
Rev4a application settings. View and modify environment variables (password, tokens, secrets), restart the server. Changes are persisted to `.env`, synced to systemd, and a daemon-reload is triggered. The **Agent defaults** section (the default memory limit offered for new agents) is saved to `agent-defaults.json` and applies at once, without a restart; the "restart Rev4a" hint is for the `.env` values only. It only prefills the create wizard and never changes an existing agent.

### Tools (`/tools`)
Catalog of the OpenClaw built-in tools available to agents, grouped by area: file and code, shell, web, messaging, sessions, media, and others. The list is curated in the app, not discovered at runtime, so it covers built-ins only and does not enumerate MCP servers or plugin tools. The page also holds audio/TTS and timezone settings.

### Plugins (`/plugins`)
Browse installed OpenClaw plugins. Enable/disable toggle per plugin. Plugins extend agent capabilities with new tools and integrations.

### Skills (`/skills`)
Skill registry showing all skills across three sources:
- **Shared** — global skills from `~/.config/rev4a/shared/shared-skills`, available to all agents
- **Per-agent** — skills in each agent's workspace (`<workspace>/skills`), shown with agent label
- **Bundled** — skills shipped with OpenClaw (read-only)

Filter by source, view and edit SKILL.md content, and **promote** agent-local skills to shared with one click.

### Setup (`/setup`)
First-run password setup. Reachable before a password exists; it sets `REV4A_PASSWORD` and the JWT secret, after which every page requires a session.

### Login (`/login`)
Password-protected access to the dashboard. Enter the Rev4a password to authenticate. Session persists via a JWT cookie (7-day expiry). From the 6th wrong password within an hour the login is locked for that address for 30 seconds, doubling up to 15 minutes; the page shows how long to wait. A restart of Rev4a clears the lock. Behind a reverse proxy, set `REV4A_TRUSTED_PROXIES` to the proxy's address (`127.0.0.1` for a proxy on the same host; a pinned address, never the agent network, for one in Docker), otherwise every visitor shares one address and one attacker can lock everyone out.

## What about Pulse?

Pulse is the AI assistant embedded in Rev4a. She appears as a floating chat button in the bottom-right corner, on every page except login, setup and the first-run wizard. She can:

- Explain what any page does
- Guide you through features ("how do I create an agent?")
- Answer questions about agents, providers, costs, sessions, containers, crons, credentials, and the first-run wizard
- Give practical tips based on the page you're on

Pulse does NOT have access to live data — she knows the page layout and features, but you need to look at the dashboard for real-time information.

## What is an "agent"?

An agent is an AI assistant that runs tasks autonomously. Each agent has:
- A name and role (e.g. "Argus" the ops lead)
- A configured AI model (e.g. GPT-5.4, Claude Sonnet)
- A workspace with its memory files and configuration
- Sessions — each time an agent does work, it creates a session
- A Docker container with a persistent data volume
- Backups that can be created, restored, and managed from the Agents page

## What is a "session"?

A session is one unit of agent work. It starts when an agent receives a task and ends when the task completes or fails. Sessions track:
- Tokens used (input and output)
- Cost in USD
- Model used
- Status (idle, working, completed, error)

Sessions can have parent-child relationships (lineage): one agent spawns another to delegate work.
