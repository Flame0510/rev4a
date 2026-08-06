# What is Rev4a?

> **Last updated:** 2026-07-18

Rev4a is the control panel for your AI agent infrastructure. It shows you everything your agents are doing, how much they cost, and whether the system is healthy — all in one dashboard.

## What can you do in Rev4a?

### Dashboard (`/`)
The main page. See live sessions (who's working right now), cost summary by model and time period (today, 7 days, 30 days), system health (CPU, RAM, disk, load average), and a real-time event feed. Click any session row to open the Session Drawer and see every tool call the agent made. If the onboarding wizard is incomplete, a banner appears at the top with a link to continue.

### Onboarding (`/onboarding`)
First-run setup wizard that guides new users through configuration. Four steps:
1. **Welcome** — what Rev4a is and what it can do
2. **Providers** — add API keys for DeepSeek, OpenAI, OpenRouter, or Groq (saved via the Provider Gateway)
3. **First Agent** — understand how agents work and what you need to create one
4. **Ready** — site map of key sections with quick links

The wizard is always accessible from the sidebar. A progress badge (e.g. "1/3") shows how many steps are complete. Once finished, the badge disappears and the dashboard banner goes away.

### Agents (`/agents`)
Manage Docker containers running OpenClaw agents. See which agents are running, stopped, or errored. Filter by status, view agent details (environment variables, ports, auth tokens, backups, Telegram channels), and create new agents. Each agent card shows its template, status, TG channel chip, and a direct link to its Control UI.

**Agent Creation Wizard** (`/agents/create`) — two-step flow:
1. Pick a template: **Atlas** (general dev), **Argus** (security/audit), **Prometheus** (client-facing), or **Custom** (blank slate)
2. Configure: name, optional port, optional model → Deploy

**Custom template:** starts with no preset identity. On first run, the agent runs a bootstrap ritual (BOOTSTRAP.md): introduces itself, asks who the user is, and together they define name, personality, tone, and boundaries. No AI generation needed — it's a native OpenClaw feature.

**Channel Manager:** Each agent detail panel has a "CHANNELS" section with TG status badge and a "Manage Channels" button. The modal lets you:
- **Telegram:** connect a bot (paste bot token → save → restart agent), disconnect, and manage pairings (approve pending codes, revoke approved senders). Pairings are polled every 5 seconds.

The agent list also shows a compact TG chip next to each agent name (green = connected, hidden if not configured).

The Agents page includes a banner for the **agent base image** (`openclaw-agent-base:latest`):
- Green: image is up-to-date (no banner shown)
- Yellow: image is outdated or missing — click "Rebuild Image" to start a build
- Copper: a build is running in the background — click "View Progress" to open
  the build modal

The build modal shows live Docker build logs (polled every 2s). You can:
- **Run in Background** — close the modal, build continues on the server
- **Abort** — kill the build process; the existing image stays intact
- **Refresh / re-enter** — opening the modal again resumes log streaming
  from the last seen line

The build writes logs to `/tmp/rev4a-build-<timestamp>.log` so they survive
page refreshes and modal closes.

### Create Agent (`/agents/create`)
Wizard to spin up a new agent. Steps: choose a template (Prometheus, Argus, Atlas, etc.), name your agent, pick a model, set an optional port range (default: auto-assigned 10-port block, e.g. 3700-3709). The agent is created as a Docker container with a persistent volume — all config, workspace files, and credentials survive container restarts.

### Lineage (`/lineage?period=7d`)
Interactive graph showing session family trees — which agent spawned which child agent, across configurable time periods (1d, 7d, 30d). Click any node to inspect. Includes a live feed side panel.

### Gateway (`/gateway`)
Central hub connecting agents to AI providers. Two panels:
- **Provider Sync** — reads the model catalogue from `models.config.json`, discovers which providers have API keys, and syncs the full model list to every agent container
- **Agent Model Config** — set each agent's primary model and fallback models via `PUT /api/gateway/agent`

### Containers (`/containers`)
Full list of all Docker containers on the server. See name, image, status, ports, IP, CPU%, and memory usage. Click "Terminal" on any container to open an interactive shell. Use Start/Stop/Restart buttons to manage lifecycle.

### Container Terminal (`/containers/terminal/[id]`)
Live web terminal into a Docker container. Run commands, inspect files, debug issues — like SSH but in the browser.

### Workspace (`/workspace`)
File explorer for the OpenClaw workspace. Browse, view, and edit files across workspaces: the VPS host workspace and every agent container workspace. Switch between workspaces via a dropdown. Supports binary file preview (images) and text editing with syntax awareness.

### Credentials (`/credentials`)
Manage third-party service credentials: GitHub, Trello, Vercel, Supabase, Notion. Each credential can be scoped to specific agent containers. Sync pushes credentials into containers via CLI auth (gh, vercel, supabase) or config files (trello, notion). Live detection shows which credentials are actually installed in each container. Audit trail for every reveal action.

### Crons (`/crons`)
Scheduled tasks auto-discovered from the host OpenClaw gateway (via `openclaw cron list --json`) and every running Docker container with the `AGENT_ID` label (via `docker exec openclaw cron list --json`). Filter jobs by agent using the toolbar tabs. Each job shows name, description, cron expression, next run, last run, and last status. Toggle on/off per job. The run history panel shows recent cron run executions for the selected job, loaded on demand from the container's gateway.

### Memory / Context (`/memory`)
Browse agent memory files — MEMORY.md, SOUL.md, IDENTITY.md, USER.md, AGENTS.md, TOOLS.md, HEARTBEAT.md. These files define how agents behave, what they know, and their personality. Also shows total memory budget vs usage.

### Config (`/config`)
Rev4a application settings. View and modify environment variables (password, tokens, secrets), restart the server. Changes are persisted to `.env`, synced to systemd, and a daemon-reload is triggered.

### Tools (`/tools`)
Catalog of every tool available to agents — built-in commands, MCP server tools, plugin tools, and audio/TTS configuration. Includes timezone settings.

### Plugins (`/plugins`)
Browse installed OpenClaw plugins. Enable/disable toggle per plugin. Plugins extend agent capabilities with new tools and integrations.

### Skills (`/skills`)
Skill registry showing all skills across three sources:
- **Shared** — global skills from `/docker/shared-skills`, available to all agents
- **Per-agent** — skills in each agent's workspace (`<workspace>/skills`), shown with agent label
- **Bundled** — skills shipped with OpenClaw (read-only)

Filter by source, view and edit SKILL.md content, and **promote** agent-local skills to shared with one click.

### Plugins & Skills (`/plugins-skills`)
Combined view showing both plugins and skills side by side.

### Login (`/login`)
Password-protected access to the dashboard. Enter the Rev4a password to authenticate. Session persists via a JWT cookie (7-day expiry).

### Vault (`/vault`)
Credential storage with per-agent permissions. Store API keys and service tokens, scope them to specific agents, and manage permissions via the UI.

## What about Pulse?

Pulse is the AI assistant embedded in Rev4a. She appears as a floating chat button in the bottom-right corner of every page. She can:

- Explain what any page does
- Guide you through features ("how do I create an agent?")
- Answer questions about agents, providers, costs, sessions, containers, crons, credentials, and onboarding
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
