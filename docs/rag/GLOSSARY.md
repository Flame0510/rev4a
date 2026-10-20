# Rev4a Glossary

> **Last updated:** 2026-10-10

Terms you'll encounter while using the Rev4a dashboard.

---

## Agent
An AI assistant configured with a specific role, AI model, and workspace. Each agent has a name (e.g. "Argus") and can run multiple sessions over time. Agents are deployed as Docker containers with persistent data volumes.

## Agent Template
A pre-built configuration used when creating a new agent. Each template ships its own set of files. Atlas has AGENTS.md, SOUL.md, IDENTITY.md, TOOLS.md, MEMORY.md and HEARTBEAT.md; Argus and Prometheus have the same minus HEARTBEAT.md; Custom has only AGENTS.md, MEMORY.md and BOOTSTRAP.md. Located in `agent-templates/`. Available templates: **Atlas** (general dev), **Argus** (security/audit), **Prometheus** (client-facing), and **Custom** (blank slate — bootstraps identity interactively on first run).

## Badge
A small inline label component used for status indicators and channel chips. Six tones: neutral, accent, success, warning, danger, info. Used for the Telegram chip on the agent list and pairing status in the Channel Manager. There is no WhatsApp support anywhere in Rev4a.

## Backup (Agent)
A compressed archive (`.tar.gz`) of an agent's persistent volume (`/root/`). Backups exclude the npm cache to keep sizes small (~1.5 MB). Stored in the `rev4a-backups` Docker volume. Used for restore operations and auto-created before each recreate.

## Browser Access
Which browsers may open an agent's Control UI. On OpenClaw 9.x every new browser must be approved once; the approval is remembered per browser. Managed in the "BROWSER ACCESS" section of the agent detail panel: approve or reject waiting browsers, rename or revoke approved ones. The Open button uses a one-time link that skips the approval. The Invite link button gives a link for someone else: their browser still waits for approval.

## Container
A Docker container running on the server. Each agent runs in its own container. The Containers page shows all containers (a running one also with its CPU, memory and processes now), including infrastructure ones such as databases and reverse proxies, with a web terminal link (a real shell in the browser; a dropped connection is resumed for 2 minutes).

## Channel
A communication channel (Telegram) configured on an agent. Channels allow users to send DMs to the agent via messaging apps. The Channel Manager modal lets you connect/disconnect Telegram and manage pairings (approve/reject senders).

## Channel Manager
Modal in the agent detail panel for configuring Telegram channels. Connect with bot token, restart agent, manage pairings (approve pending codes, revoke approved senders). Pairings are polled every 5 seconds with automatic cancellation of stale requests via AbortController.

## Cost
What an agent spent in USD. Each agent's OpenClaw prices every model call itself, with the prices Rev4a writes into it (input, output, cached input), and Rev4a reads those figures every 5 minutes. The Costs page (`/costs`) shows them for today, 7 or 30 days — by day, by agent, by model, and the most expensive sessions. Calls made with a ChatGPT subscription are not part of it (see ChatGPT subscription). The dashboard's "Spent today" card shows the same figures for today, and each agent's panel on the Agents page has a COSTS section with its own. The Costs page also shows what the Rev4a proxy metered for each agent next to the agent's own figure, and its Spent total counts the larger of the two per agent — so it can be above the dashboard's "Spent today", the daily chart and the cost split, which keep the agents' own figures. It also compares the agents' figures with what DeepSeek and OpenRouter actually billed (their balance or usage, read every hour).

## Off-peak
DeepSeek bills half price outside its peak hours (peak: 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday). Rev4a writes the lower prices into the agents when off-peak starts and the full ones when it ends, so each call is priced at the rate in force when it ran. The Costs page header and the agent panel's COSTS section (Rates now) show the current band.

## Credential
A third-party service token (GitHub PAT, Trello API key, Vercel token, Supabase access key, Notion API token, MongoDB connection string) stored in the Rev4a vault. A credential reaches an agent only when the user switches it on for that agent on the Credentials page: the token goes into the agent's OpenClaw secret store as an environment variable and the matching skill is enabled (GitHub instead uses OpenClaw's managed GitHub identity; Vercel uses the CLI's own auth.json + config.json). Switching it off removes it. Every reveal is written to an audit table that no route or view reads.

## Cron / Cron Job
A scheduled task that runs an agent automatically at a fixed time (e.g. every night at 3:15 AM). Configured with standard cron syntax. Jobs can be enabled/disabled per entry.

## Dashboard
The main page of Rev4a (`/`). Shows live sessions, cost summary, health cards for Rev4a's runtime, cron and lineage, and a real-time event feed. Its Machine card shows the server's CPU, RAM and fullest disk right now, with a link to the System page. There is no setup banner: an incomplete wizard redirects to `/wizard`.

## Event
A lifecycle occurrence for a session: spawned, completed, failed, or missing too long (spawn timeout); the daemon also records system anomalies (high CPU or RAM, a container with too many processes or nearly all of Docker's memory) as events. Events appear in the live feed on the Dashboard and are pushed via SSE every 5 seconds.

## Gateway
The routing layer that connects agents to AI providers. The Gateway page manages provider API keys and the model catalogue, and pushes that catalogue to every agent. Which model a given agent runs is set elsewhere, in the Model section of that agent's detail panel.

## Lineage
The parent-child relationship tree between sessions. When an agent spawns another agent to do work, that relationship is shown as an interactive graph on the Lineage page. Configurable time periods: 1d, 3d, 7d, 15d, 30d and all.

## Memory
Files that store an agent's persistent knowledge and personality. The tracked set is USER.md, MEMORY.md, AGENTS.md, SOUL.md and HEARTBEAT.md. Editing them changes how an agent behaves. The Memory page shows these with size and budget tracking. A template may also ship IDENTITY.md or TOOLS.md, which are not tracked.

## Model
The AI model used by an agent or session. Examples: GPT-5.4, Claude Sonnet 5, DeepSeek Flash. Models are linked to specific providers. The Gateway page controls which models are enabled for the whole deployment; the agent detail panel sets which one a given agent runs, plus its fallbacks. A model whose name the provider has retired is tagged `deprecated` on the agent card and in that panel. The Gateway page does not show it.

## First-run wizard
First-time setup wizard at `/wizard`. Steps: Welcome → Providers → First Agent → Ready. Completion is recorded in `wizard.json` under the data directory. Always accessible from the sidebar. The mobile bottom navigation has five entries — Home, Agents, Workspace, Gateway, Containers — and the wizard is not one of them.

## Plugin
An extension that adds new tools and capabilities to agents. Plugins are installed in the workspace and appear in the Plugins page with enable/disable toggles.

## Provider
An AI service provider (OpenAI, Anthropic, Groq, OpenRouter, DeepSeek, etc.) that hosts models. Provider API keys are configured in the Gateway page or via the first-run wizard.

## Provider Gateway
Rev4a's built-in proxy that gives all agents unified access to configured LLM providers. Agents point to `http://host.docker.internal:3740/api/provider/v1` and Rev4a routes requests to the correct upstream using the stored API keys.

## Proxy Metering
The count the Rev4a provider proxy keeps of every call it carries, per agent (from the `x-rev4a-agent` header), hour and model: calls, tokens as the provider reported them, and the price in force at the time. Shown on the Costs page next to what each agent recorded; Spent there is the larger of the two per agent. Calls without an agent header are "Unidentified callers": listed, not counted in Spent.

## Pulse
The AI concierge embedded in Rev4a. Click the floating chat button (bottom-right) on any page to ask questions about the dashboard features and navigation.

## Recreate (Agent)
Rebuild an agent container on its own OpenClaw version while preserving the persistent volume. Auto-backups the volume first — if the backup fails, the recreate is aborted. A recreate never changes the OpenClaw version; moving to a newer version is a separate update.

## Restore (Agent)
Replace an agent's persistent volume with a previously created backup. The container is stopped, the volume content is fully replaced, then the container is restarted.

## Rollback (Agent)
Undo an agent's latest OpenClaw update: the backup taken just before the update is put back and the agent starts again on its previous version. Anything the agent did after that backup is lost, including a recreate or restore done after a failed update; the confirmation names the backup date. Offered in the agent's OPENCLAW VERSION section while that backup exists.

## Session
One instance of an agent doing work. Tracks: start/end time, tokens used, model, status, and task description; what a session cost is on the Costs page (most expensive sessions). A session starts when an agent receives a task and ends when it completes or fails.

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

## Subscription
A ChatGPT Plus or Pro (Codex) account connected to one agent from the Subscriptions page by a device-code login. The sign-in is kept inside the agent, not in Rev4a. The agent can use a subscription model as its primary or as a fallback, chosen in the MODEL section of the agent panel; the previous model is pre-filled as a fallback for when the account's usage limit is reached. Its calls are not counted as spend: the Costs page shows them in a separate "ChatGPT subscription" section with their API value (what the same calls would have cost at OpenAI API prices).

## Traefik
Optional reverse proxy an operator can put in front of the Rev4a dashboard or of an agent's port. Rev4a does not configure it and sets no routing labels on agents: an agent's Control UI is reached on its published port. Rev4a itself runs on port 3740 and does not require Traefik.

## Update (Agent)
Move one agent to a newer OpenClaw version downloaded on the Agents page, from its OPENCLAW VERSION section. The agent goes offline for a few minutes: it is backed up while stopped, started on the new version (which converts its data), and checked for missing conversation history or cron jobs. Undone with Rollback.

## Vault
Rev4a's store for third-party service tokens (GitHub, Trello, Vercel, Supabase, Notion, MongoDB). Provider API keys live separately in `provider-keys.json`, managed from the Gateway page. Supports reveal (written to an audit table no route or view reads) and a per-agent switch (on, off, or an error). Secrets are stored unencrypted.

## Workspace
The directory where an agent's operational files live (config, memory files, skills, plugins, scripts). The Workspace page lets you browse, view, and edit text files in each agent container (running or stopped agents are listed; a stopped one must be started to open its files). There is no host workspace.

## System (page)
The page with the machine Rev4a runs on: CPU (with cores and load), memory and swap, and each disk's used and free space, now and over 1 hour, 24 hours, 7 days or 30 days. A bar turns yellow and then red when it reaches a threshold (CPU and memory 85 % / 95 %, disk 80 % / 90 %), and the level is written next to it.

## System Health
A card on the Dashboard reporting whether Rev4a itself is working, not the hardware it runs on. `/api/system-health` returns checks for session runtime, the daemon heartbeat (how old its latest machine sample is), failed runs in the last 24 hours ("Failed runs (24h)": failed or timed-out runs), what the agents spent today, and cron jobs, each with a health of `ok`, `warning` or `error`, plus a list of recommendations.

It reports no CPU, RAM, disk or load average: those are on the System page (`/system`), sampled every 30 seconds by the daemon and kept for 30 days.
