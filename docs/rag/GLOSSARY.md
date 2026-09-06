# Rev4a Glossary

> **Last updated:** 2026-08-28

Terms you'll encounter while using the Rev4a dashboard.

---

## Agent
An AI assistant configured with a specific role, AI model, and workspace. Each agent has a name (e.g. "Argus") and can run multiple sessions over time. Agents are deployed as Docker containers with persistent data volumes.

## Agent Template
A pre-built configuration used when creating a new agent. Templates include default files (AGENTS.md, SOUL.md, MEMORY.md, IDENTITY.md, TOOLS.md, HEARTBEAT.md, BOOTSTRAP.md) and settings. Located in `agent-templates/`. Available templates: **Atlas** (general dev), **Argus** (security/audit), **Prometheus** (client-facing), and **Custom** (blank slate — bootstraps identity interactively on first run).

## Badge
A small inline label component used for status indicators and channel chips. Supports success, danger, warning, and neutral tones. Used for TG/WA chips on the agent list and pairing status in the Channel Manager.

## Backup (Agent)
A compressed archive (`.tar.gz`) of an agent's persistent volume (`/root/`). Backups exclude the npm cache to keep sizes small (~1.5 MB). Stored in the `rev4a-backups` Docker volume. Used for restore operations and auto-created before each recreate.

## Container
A Docker container running on the server. Each agent runs in its own container. The Containers page shows all containers, including infrastructure ones (databases, reverse proxies, etc.), with CPU/memory metrics and a web terminal.

## Channel
A communication channel (Telegram) configured on an agent. Channels allow users to send DMs to the agent via messaging apps. The Channel Manager modal lets you connect/disconnect Telegram and manage pairings (approve/reject senders).

## Channel Manager
Modal in the agent detail panel for configuring Telegram channels. Connect with bot token, restart agent, manage pairings (approve pending codes, revoke approved senders). Pairings are polled every 5 seconds with automatic cancellation of stale requests via AbortController.

## Cost
The estimated cost of an agent session in USD, calculated from tokens used and per-model pricing. Rev4a shows cost by today, 7 days, 30 days, all-time, and by model.

## Cost Override
A manual correction for a month's total cost. If the automatic calculation doesn't match the actual invoice, you can set an override value for that month with an optional note.

## Credential
A third-party service token (GitHub PAT, Trello API key, Vercel token, Supabase access key, Notion API token) stored in the Rev4a vault. A credential is installed into a container only when the user syncs it, and removed on de-sync; any credential can be synced to any container. Every reveal is written to an audit table that no route or view reads.

## Cron / Cron Job
A scheduled task that runs an agent automatically at a fixed time (e.g. every night at 3:15 AM). Configured with standard cron syntax. Jobs can be enabled/disabled per entry.

## Dashboard
The main page of Rev4a (`/`). Shows live sessions, cost summary, system health metrics (CPU, RAM, disk, load average), and a real-time event feed. A setup banner appears if the first-run wizard is incomplete.

## Event
A lifecycle occurrence for a session: spawned, completed, errored, or a tool call made. Events appear in the live feed on the Dashboard and are pushed via SSE every ~3 seconds.

## Gateway
The routing layer that connects agents to AI providers. The Gateway page has two panels: Provider Sync (push the model catalogue to all agents) and Agent Model Config (set each agent's primary model and fallbacks).

## Lineage
The parent-child relationship tree between sessions. When an agent spawns another agent to do work, that relationship is shown as an interactive graph on the Lineage page. Configurable time periods: 1d, 7d, 30d.

## Memory
Files that store an agent's persistent knowledge and personality: MEMORY.md, SOUL.md, IDENTITY.md, USER.md, AGENTS.md, TOOLS.md, HEARTBEAT.md. Editing them changes how an agent behaves. The Memory page shows all files with size and budget tracking.

## Model
The AI model used by an agent or session. Examples: GPT-5.4, Claude Sonnet 4, DeepSeek V4 Flash. Models are linked to specific providers. The Gateway page manages which models are enabled and which agent uses which model.

## First-run wizard
First-time setup wizard at `/wizard`. Steps: Welcome → Providers → First Agent → Ready. Completion is recorded in `wizard.json` under the data directory. Always accessible from the sidebar or mobile navbar.

## Plugin
An extension that adds new tools and capabilities to agents. Plugins are installed in the workspace and appear in the Plugins page with enable/disable toggles.

## Provider
An AI service provider (OpenAI, Anthropic, Groq, OpenRouter, DeepSeek, etc.) that hosts models. Provider API keys are configured in the Gateway page or via the first-run wizard.

## Provider Gateway
Rev4a's built-in proxy that gives all agents unified access to configured LLM providers. Agents point to `http://host.docker.internal:3740/api/provider/v1` and Rev4a routes requests to the correct upstream using the stored API keys.

## Pulse
The AI concierge embedded in Rev4a. Click the floating chat button (bottom-right) on any page to ask questions about the dashboard features and navigation.

## Recreate (Agent)
Rebuild an agent container from the latest `openclaw-agent-base:latest` image while preserving the persistent volume. Auto-backups the volume first — if the backup fails, the recreate is aborted. This is how agents pick up OpenClaw image updates.

## Restore (Agent)
Replace an agent's persistent volume with a previously created backup. The container is stopped, the volume content is fully replaced, then the container is restarted.

## Session
One instance of an agent doing work. Tracks: start/end time, tokens used, cost, model, status, and task description. A session starts when an agent receives a task and ends when it completes or fails.

## Pairing
A security mechanism for Telegram channels. When a user sends `/start` to the bot, a 4-digit pairing code is generated. An admin must approve this code in the Channel Manager to add the user to the allowlist. Approved senders can be revoked at any time.

## Telegram
A messaging channel type. Agents can be connected to Telegram via a bot token from @BotFather. Once connected, users send `/start` to get a pairing code, which an admin approves in the Channel Manager.

## Session ID
A unique identifier for a session. Format: `agent:<name>:<role>` (e.g. `agent:ops:main`) or `agent:<name>:subagent:<uuid>` for temporary child agents.

## Skill
A reusable prompt/tool bundle that agents can invoke. Skills appear in the Skills page and can be used by agents via commands or direct invocation.

## Status (Session)
Current state of a session:
- **idle** — agent is running but not actively processing
- **working** — agent is actively processing a task (consuming tokens)
- **completed** — task finished successfully
- **error** — task failed

## BOOTSTRAP.md
A first-run ritual file for agents. When an agent starts for the first time in a new workspace, it reads BOOTSTRAP.md, introduces itself, learns who the user is, and together they define the agent's name, personality, tone, and boundaries. The agent then creates/updates SOUL.md, IDENTITY.md, and USER.md, then deletes BOOTSTRAP.md so the ritual never repeats. Used by the Custom agent template.

## Token
The unit of text processed by an AI model. Input tokens (your prompt) and output tokens (the AI's response) are counted separately and used to calculate cost.

## Tool
A capability available to agents: running shell commands, reading files, searching the web, etc. Tools can be built-in, from plugins, or from MCP servers.

## Tool Call
A record of an agent using a tool during a session. Useful for auditing what an agent actually did. Shown in the Session Drawer.

## Traefik
Optional reverse proxy for routing web traffic to agent containers. If configured, an agent gets a public URL. Rev4a itself runs on port 3740 and does not require Traefik.

## Vault
Rev4a's store for third-party service tokens (GitHub, Trello, Vercel, Supabase, Notion). Provider API keys live separately in `provider-keys.json`, managed from the Gateway page. Supports reveal (written to an audit table no route or view reads), sync to and from containers, and live detection of which credentials are actually installed. Secrets are stored unencrypted.

## Workspace
The directory where an agent's operational files live (config, memory files, skills, plugins, scripts). The Workspace page lets you browse, view, and edit files across the VPS host and all agent containers.

## System Health
Hardware metrics shown on the Dashboard: CPU usage (%), RAM used/total (MB), disk used/total (GB), system load average (1m). The System Health API (`/api/system-health`) also generates recommendations (e.g. "Consider archiving old sessions to reduce disk usage"). Status can be `ok`, `warn`, or `error`.
