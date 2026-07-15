# Olympus Glossary

> **Last updated:** 2026-07-03

Terms you'll encounter while using the Olympus dashboard.

---

## Agent
An AI assistant configured with a specific role, AI model, and workspace. Each agent has a name (e.g. "Argus") and can run multiple sessions over time. Agents are deployed as Docker containers.

## Agent Template
A pre-built configuration used when creating a new agent. Templates include default files, environment variables, and settings.

## Container
A Docker container running on the server. Each agent runs in its own container. The Containers page shows all containers, including infrastructure ones (databases, reverse proxies, etc.).

## Cost
The estimated cost of an agent session in USD, calculated from tokens used and per-model pricing. Olympus shows cost by day, week, month, and by model.

## Cost Override
A manual correction for a month's total cost. If the automatic calculation doesn't match the actual invoice, you can set an override value for that month.

## Cron / Cron Job
A scheduled task that runs an agent automatically at a fixed time (e.g. every night at 3:15 AM). Configured with standard cron syntax.

## Dashboard
The main page of Olympus. Shows live sessions, cost summary, system health metrics, and a real-time event feed.

## Event
A lifecycle occurrence for a session: spawned, completed, errored, or a tool call made. Events appear in the live feed on the Dashboard.

## Gateway
The routing layer that connects agents to AI providers. The Gateway page lets you manage which models are enabled, see each agent's model assignment, and sync provider configurations.

## Lineage
The parent-child relationship tree between sessions. When an agent spawns another agent to do work, that relationship is shown as a graph on the Lineage page.

## Memory
Files that store an agent's persistent knowledge and personality. MEMORY.md and SOUL.md are examples. Editing them changes how an agent behaves.

## Model
The AI model used by an agent or session. Examples: GPT-5.4, Claude Sonnet 4, DeepSeek V3. Models are linked to specific providers.

## Plugin
An extension that adds new tools and capabilities to agents. Plugins are installed in the workspace and appear in the Plugins page.

## Provider
An AI service provider (OpenAI, Anthropic, Groq, OpenRouter, etc.) that hosts models. Each provider needs an API key to be configured in Olympus.

## Pythia
The AI concierge embedded in Olympus. Click the floating chat button (bottom-right) on any page to ask questions.

## Session
One instance of an agent doing work. Tracks: start/end time, tokens used, cost, model, status, and task description. A session starts when an agent receives a task and ends when it completes or fails.

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

## Token

## Onboarding
First-time setup wizard on the `/onboarding` page. Takes new users through provider configuration, agent creation overview, and a site map. Tracked per-step in `data/onboarding-progress.json` — progress badge shown in the sidebar until complete.

## Token
The unit of text processed by an AI model. Input tokens (your prompt) and output tokens (the AI's response) are counted separately and used to calculate cost.

## Tool
A capability available to agents: running shell commands, reading files, searching the web, etc. Tools can be built-in, from plugins, or from MCP servers.

## Tool Call
A record of an agent using a tool during a session. Useful for auditing what an agent actually did.

## Traefik
The reverse proxy used to route web traffic to agent containers. If configured, an agent gets a public URL (e.g. `agent-name.olympus.example.com`).

## Workspace
The directory where an agent's operational files live (config, memory files, skills, plugins, scripts). The Workspace page lets you browse and download these files.

## System Health
Hardware metrics shown on the Dashboard: CPU usage (%), RAM used/total, disk used/total, and system load average.
