# What is Olympus?

> **Last updated:** 2026-07-03

Olympus is the control panel for your AI agent infrastructure. It shows you everything your agents are doing, how much they cost, and whether the system is healthy — all in one dashboard.

## What can you do in Olympus?

### Dashboard (`/`)
The main page. See live sessions (who's working right now), cost summary by model and time period (today, 7 days, 30 days), system health (CPU, RAM, disk), and a real-time event feed. Click any session row to open the Session Drawer and see every tool call the agent made.

### Agents (`/agents`)
Manage your Docker containers running OpenClaw agents. See which agents are running, stopped, or errored. Filter by status, view agent details (environment variables, ports, auth tokens), and create new agents.

### Create Agent (`/agents/create`)
Wizard to spin up a new agent. Choose a template, name your agent, pick a model, set environment variables, and optionally configure a web URL via Traefik.

### Providers (`/providers`)
View all configured AI providers (OpenAI, Anthropic, Groq, OpenRouter, etc.) and their available models. Check which API keys are set and which models are ready to use.

### Gateway (`/gateway`)
Central hub connecting agents to AI providers. Toggle which models are available, see each agent's default model and fallbacks, check gateway health, and sync provider configurations.

### Cron Jobs (`/crons`)
See scheduled tasks that run agents automatically. View schedule expressions, last run time, next run time, and execution status.

### Containers (`/containers`)
Full list of all Docker containers on the server. See name, image, status, ports, and IP. Click "Terminal" on any container to open an interactive shell.

### Container Terminal (`/containers/terminal/[id]`)
Live web terminal into a Docker container. Run commands, inspect files, debug issues — just like SSH.

### Config (`/config`)
Olympus application settings. View and modify configuration values that control how the dashboard behaves.

### Lineage (`/lineage?period=7d`)
Interactive graph showing session family trees. See which agent spawned which child agent, across time periods. Click any node to inspect.

### Memory / Context (`/memory`)
Browse agent memory files. These files (like MEMORY.md and SOUL.md) define how agents behave, what they know, and their personality.

### Workspace (`/workspace`)
File explorer for the OpenClaw workspace. Browse, view, and download files that agents use — configuration, scripts, and operational documents.

### Tools (`/tools`)
Catalog of every tool available to agents — built-in commands, MCP server tools, plugin tools, and audio transcription tools.

### Plugins & Skills (`/plugins-skills`), Plugins (`/plugins`), Skills (`/skills`)
Browse plugins (extend agent capabilities with new tools) and skills (reusable prompt/tool bundles agents can invoke).

### Login (`/login`)
Password-protected access to the dashboard. Enter the Olympus password to authenticate.

## What about Pythia?

Pythia is the AI assistant embedded in Olympus. She appears as a floating chat button in the bottom-right corner of every page. She can:

- Explain what any page does
- Guide you through features ("how do I create an agent?")
- Answer questions about agents, providers, costs, sessions, containers, and crons
- Give practical tips based on the page you're on

Pythia does NOT have access to live data — she knows the page layout and features, but you need to look at the dashboard for real-time information.

## What is an "agent"?

An agent is an AI assistant that runs tasks autonomously. Each agent has:
- A name and role (e.g. "Argus" the ops lead)
- A configured AI model (e.g. GPT-5.4, Claude Sonnet)
- A workspace with its memory files and configuration
- Sessions — each time an agent does work, it creates a session

## What is a "session"?

A session is one unit of agent work. It starts when an agent receives a task and ends when the task completes or fails. Sessions track:
- Tokens used (input and output)
- Cost in USD
- Model used
- Status (idle, working, completed, error)
- Tool calls made during the session

Sessions can have parent-child relationships (lineage): one agent spawns another to delegate work.
