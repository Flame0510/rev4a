# What is Rev4a?

> **Last updated:** 2026-09-26

Rev4a is the control panel for your AI agent infrastructure. It shows you everything your agents are doing, how much they cost, and whether the system is healthy — all in one dashboard.

## What can you do in Rev4a?

### Dashboard (`/`)
The main page. See live sessions (who's working right now), cost summary, an overall health indicator, and a real-time event feed. Click any session row to open the Session Drawer and see every tool call the agent made.

The health cards cover Rev4a's own runtime, cron and watchdog, and lineage. They do **not** show CPU, RAM, disk, or load average: those metrics are collected and stored, but no page displays them. There is no wizard banner on the dashboard; an incomplete setup redirects to `/wizard` instead.

### First-run wizard (`/wizard`)
First-run setup wizard that guides new users through configuration. Four steps:
1. **Welcome** — what Rev4a is and what it can do
2. **Providers** — add API keys for DeepSeek, OpenAI, OpenRouter, or Groq (saved via the Provider Gateway)
3. **First Agent** — understand how agents work and what you need to create one
4. **Ready** — site map of key sections with quick links

The wizard is always accessible from the sidebar. There is no progress badge on that entry and no banner elsewhere.

### Agents (`/agents`)
Manage Docker containers running OpenClaw agents. See which agents are running, stopped, or errored. Filter by status, view agent details (environment variables, ports, auth tokens, backups, Telegram channels), and create new agents. Each agent card shows its template, status, TG channel chip, and a direct link to its Control UI.

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
directory, where the update's output is written.

The Agents page includes a banner for the **agent base image**, which is kept per
OpenClaw version. It is hidden when a supported version is downloaded and nothing newer
is published. When no image is downloaded it offers **Download Image**; when a newer
supported OpenClaw version is published it says so and offers **Download <version>**.
Downloading changes no agent: new agents are created on the newest version downloaded,
existing agents keep their version (a recreate never changes it), and their card shows
**UPDATE AVAILABLE**.

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
Wizard to spin up a new agent. Steps: choose a template (Prometheus, Argus, Atlas, etc.), name your agent, pick a model, set an optional port range (default: auto-assigned 10-port block, e.g. 3700-3709). The agent is created as a Docker container with a persistent volume — all config, workspace files, and credentials survive container restarts.

### Lineage (`/lineage?period=7d`)
Interactive graph showing session family trees — which agent spawned which child agent, across configurable time periods: 1d, 3d, 7d, 15d, 30d, and all. Click any node to inspect. Includes a live feed side panel.

### Gateway (`/gateway`)
Connects agents to AI providers. Add and remove provider API keys, enable or disable individual models in the catalogue read from `models.config.json`, and push the resulting model list to every agent container. It does not assign models to agents: choosing which model an agent runs is done per agent, in the Model section of the agent's detail panel on the Agents page. Every model row has a **Details** button: the modal shows the model's description, price and provider, its architecture and parameter count when the weights are public, reasoning modes, capabilities, benchmarks with sources, licence and how much disk the weights take — the numbers come from the model card on Hugging Face and from curated entries that cite a source, never from estimates.

### Containers (`/containers`)
Full list of all Docker containers on the server, including stopped ones. Each row shows name, status, image, IP, ports, and an agent pill where applicable. Click "Terminal" to open an interactive shell into that container.

The page shows no CPU or memory figures and has no start, stop, or restart buttons: it is read-only apart from the terminal link. Container lifecycle is managed from the Agents page.

### Container Terminal (`/containers/terminal/[id]`)
Live web terminal into a Docker container. Run commands, inspect files, debug issues — like SSH but in the browser.

### Workspace (`/workspace`)
File explorer for the OpenClaw workspace. Browse, view, and edit files across workspaces: the VPS host workspace and every agent container workspace. Switch between workspaces via a dropdown. Supports binary file preview (images) and text editing with syntax awareness.

### Credentials (`/credentials`)
Manage third-party service credentials: GitHub, Trello, Vercel, Supabase, Notion. Sync installs a credential into the containers you pick — as that CLI's own config for GitHub, Vercel and Supabase, or as a config file the agent reads for Trello and Notion, which are used through their REST API; de-sync removes it from one container. Any credential can be synced to any container — there is no per-agent permission model. Live detection shows which credentials are actually installed in each container: a green tick when the installed token is the profile's own, a yellow diamond marked "unknown credential" when the container holds a token for that provider that no stored profile accounts for — an edited-but-not-resynced credential, one installed by hand, or the remains of a deleted profile. Every reveal is recorded in an audit table, which no route or view reads. Secrets are held unencrypted in `credentials.db`.

### Crons (`/crons`)
Scheduled tasks auto-discovered from the host OpenClaw gateway (via `openclaw cron list --json`) and every running Docker container with the `AGENT_ID` label (via `docker exec openclaw cron list --json`). Filter jobs by agent using the toolbar tabs. Each job shows name, description, cron expression, next run, last run, and last status. Toggle on/off per job. The run history panel shows recent cron run executions for the selected job, loaded on demand from the container's gateway.

### Memory / Context (`/memory`)
Browse agent memory files. The tracked set is USER.md, MEMORY.md, AGENTS.md, SOUL.md and HEARTBEAT.md. These files define how agents behave, what they know, and their personality. Also shows total memory budget vs usage.

A template may ship other files, such as IDENTITY.md or TOOLS.md, but those are not part of the tracked context set.

### Config (`/config`)
Rev4a application settings. View and modify environment variables (password, tokens, secrets), restart the server. Changes are persisted to `.env`, synced to systemd, and a daemon-reload is triggered.

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
Password-protected access to the dashboard. Enter the Rev4a password to authenticate. Session persists via a JWT cookie (7-day expiry).

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
- Tool calls made during the session

Sessions can have parent-child relationships (lineage): one agent spawns another to delegate work.
