# What PULSE Can Answer

> **Last updated:** 2026-10-06

PULSE is the in-dashboard AI concierge for Rev4a. This document defines what she can and cannot answer.

---

## Navigation Questions

- "Where do I find the agents page?"
- "How do I get to the container list?"
- "Where do I see CPU, RAM or disk usage of the server?" — The System page (`/system`), and the Machine card on the Dashboard.
- "Which agent is using the most CPU or memory?" — The "Agents and containers" section of the System page: one row per container, sorted by CPU, with memory, storage and processes; open a row for its charts. An agent's own panel has the same numbers under RESOURCES.
- "What is filling the disk?" — The "Docker storage" block on the System page: images, volumes (an unused volume is named), writable layers and build cache.
- "Why is there a red bar or an alert on the System page?" — "Recent alerts" at the bottom of the System page lists what crossed its limit and when.
- "Where can I see the first-run wizard?"
- "Is there a page for cron jobs?"
- "Where can I see my AI providers?" — The Gateway page (`/gateway`) shows providers and the model catalogue. Which model an agent runs is on the Agents page, in that agent's detail panel.
- "How do I create a new agent?"
- "What templates are available?"
- "What is the Custom template?"
- "How does the custom agent bootstrap work?"
- "Where is the lineage graph?"
- "How do I open the file explorer?"
- "Which page shows costs?" — The Costs page (`/costs`): what each agent spent, by day, agent, model and session.
- "Where do I manage credentials (GitHub, Trello, etc.)?"
- "How do I connect an agent to Telegram?"
- "How do I approve a Telegram pairing?"
- "What does the TG badge mean?"
- "How do I get to the gateway?"
- "Where is the terminal for a container?"
- "Where can I edit memory files?"
- "How do I see the plugins?"
- "Where can I check system health?"

## How-To Questions

- "How do I create an agent?"
- "How do I set up Rev4a for the first time?"
- "How do I complete the first-run wizard?"
- "How do I add an API key for a provider?"
- "How do I filter agents by status?"
- "How do I open a terminal for a container?"
- "How do I configure a provider?"
- "How do I set up the gateway?"
- "How do I enable/disable models on the gateway?"
- "How do I check if my API key is working?"
- "How do I take a screenshot of the dashboard?"
- "How do I view memory files?"
- "How do I sync credentials to an agent?"
- "How do I back up an agent?"
- "How do I restore an agent from a backup?"
- "How do I rebuild (recreate) an agent's container?"
- "How do I delete an agent?"
- "How do I restart the Rev4a server?"
- "How do I change environment variables?"
- "How do I see the session lineage?"
- "How do I log in to an agent's control UI?"
- "Why does the Control UI ask me to approve this browser?"
- "How do I approve or revoke a browser for an agent?"
- "How do I give someone else access to an agent's Control UI?"
- "How do I update an agent to a newer OpenClaw version, and how do I go back?"
- "How do I register a new provider via OAuth?" — The endpoint exists but no page uses it. Providers are added by pasting an API key on the Gateway page.
- "How do I manage agent model fallbacks?"
- "How do I connect an agent to Telegram?"
- "How do I approve a pairing code?"

## Explanation Questions

- "What does the lineage graph show?"
- "What do the different statuses mean (idle, working, completed, error)?"
- "What is a gateway?"
- "What is the Provider Gateway?"
- "What is the difference between a plugin and a skill?"
- "What are MCP tools?"
- "What is the vault?"
- "What are credentials in Rev4a?"
- "What is an agent template?"
- "What happens when I recreate an agent?"
- "How do agent backups work?"
- "What is an agent persistent volume?"
- "What is the first-run wizard?"
- "What is the Provider Gateway proxy?"
- "How does the SSE stream work?"
- "What is the shared gateway token?"
- "What are model fallbacks?"
- "What is the Channel Manager?"
- "What is pairing?"
- "What is Telegram pairing?"
- "What is the TG badge on the agent list?"

## Troubleshooting Questions

- "Why is my agent not showing up?"
- "Why are costs missing for some sessions?" — On the Costs page, calls to a model without a price are listed under "Calls without a price": the model left the catalogue or has no price yet.
- "Why can't I connect to the container terminal?"
- "Why is the gateway sync not working?"
- "How do I check if the daemon is running?"
- "Why are credentials not showing in my agent?"
- "What does the yellow diamond next to an agent mean?"
- "Why is the agent base image banner showing?"
- "How do I fix 'image is outdated'?"
- "How do agent image updates work?" — The banner on the Agents page runs a `docker pull` and shows the percent of layers finished and docker's latest output line, with a Cancel button once the download is running; there is no modal or live log. The banner also offers a **newer build** of a version you already have ("A newer build of the agent image X is available"); agents keep their current image until recreated or updated. The outcome is reported even if it happened while you were away, as long as it is less than 30 seconds old.
- "How big is model X / how many parameters does it have?" — Open the **Details** modal from the model row on the Gateway page: parameter counts, architecture and benchmark numbers come from the model's card on Hugging Face, with the vendor's own claim where it makes one. Models whose weights are not published (OpenAI, Anthropic, Google, Qwen's Plus/Max line) show no parameter count: the size is not public and Rev4a does not estimate it.
- "How do I update Rev4a itself?" — The "Update available" banner starts `rev4a update` in the background (the same command as from a shell). It installs the new version and Rev4a restarts itself, so the dashboard drops for a short while; the banner waits for the new version and then confirms it, or says the update did not complete. The update's output is written to `update.log` in the Rev4a data directory (`~/.config/rev4a/data/update.log`) — the only place that says why an update failed.
- "Why is my Telegram bot not connecting?"
- "Why can't I approve a pairing code?"
- "Why is the TG badge missing from my agent?"

## What PULSE CANNOT do

- Access real-time data (session costs, live statuses, actual CPU/RAM). She only knows features and navigation.
- Execute actions (create agents, sync gateway, change config). She guides you to the right page.
- Read the contents of specific files on the server.
- See your API keys or credentials.
- Predict costs for future sessions.

---

## How PULSE uses context

When you ask a question, PULSE knows which page you're currently on (e.g. `/agents`, `/gateway`). She tailors her answer to the page you're looking at. If you're on the Agents page and ask "how do I create one?", she knows you mean an agent, not a cron job.

### Best results
1. **Open the relevant page first.** PULSE gives better guidance when you're on the Agents page asking about agents, or on the Gateway page asking about model routing.
2. **Be specific.** "How do I add a fallback model?" works better than "help me with models."
3. **Ask follow-ups.** PULSE remembers the conversation within the same chat session.
