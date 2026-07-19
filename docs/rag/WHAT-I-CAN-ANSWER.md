# What PYTHIA Can Answer

> **Last updated:** 2026-07-18

PYTHIA is the in-dashboard AI concierge for Olympus. This document defines what she can and cannot answer.

---

## Navigation Questions

- "Where do I find the agents page?"
- "How do I get to the container list?"
- "Where can I see the onboarding wizard?"
- "Is there a page for cron jobs?"
- "Where can I see my AI providers?"
- "How do I create a new agent?"
- "Where is the lineage graph?"
- "How do I open the file explorer?"
- "Which page shows costs?"
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
- "How do I set up Olympus for the first time?"
- "How do I complete the onboarding wizard?"
- "How do I add an API key for a provider?"
- "How do I filter agents by status?"
- "How do I open a terminal for a container?"
- "How do I see the tool calls for a session?"
- "How do I configure a provider?"
- "How do I set up the gateway?"
- "How do I enable/disable models on the gateway?"
- "How do I check if my API key is working?"
- "How do I take a screenshot of the dashboard?"
- "How do I view memory files?"
- "How do I sync credentials to an agent?"
- "How do I back up an agent?"
- "How do I restore an agent from a backup?"
- "How do I recreate an agent with the latest image?"
- "How do I delete an agent?"
- "How do I restart the Olympus server?"
- "How do I change environment variables?"
- "How do I add a cost override?"
- "How do I see the session lineage?"
- "How do I log in to an agent's control UI?"
- "How do I register a new provider via OAuth?"
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
- "What does 'cost override' mean?"
- "What is the vault?"
- "What are credentials in Olympus?"
- "What is an agent template?"
- "What happens when I recreate an agent?"
- "How do agent backups work?"
- "What is an agent persistent volume?"
- "What is the onboarding wizard?"
- "What is the difference between Gateway and Providers pages?"
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
- "Why are costs missing for some sessions?"
- "Why can't I connect to the container terminal?"
- "Why is the gateway sync not working?"
- "Why am I seeing an onboarding banner?"
- "How do I check if the daemon is running?"
- "Why are credentials not showing in my agent?"
- "Why is the agent base image banner showing?"
- "How do I fix 'image is outdated'?"
- "What happens if I abort a build?"
- "Can I close the build modal while it's running?"
- "How do agent image rebuilds work?"
- "Why is my Telegram bot not connecting?"
- "Why can't I approve a pairing code?"
- "Why is the TG badge missing from my agent?"

## What PYTHIA CANNOT do

- Access real-time data (session costs, live statuses, actual CPU/RAM). She only knows features and navigation.
- Execute actions (create agents, sync gateway, change config). She guides you to the right page.
- Read the contents of specific files on the server.
- See your API keys or credentials.
- Predict costs for future sessions.

---

## How PYTHIA uses context

When you ask a question, PYTHIA knows which page you're currently on (e.g. `/agents`, `/gateway`). She tailors her answer to the page you're looking at. If you're on the Agents page and ask "how do I create one?", she knows you mean an agent, not a cron job.

### Best results
1. **Open the relevant page first.** PYTHIA gives better guidance when you're on the Agents page asking about agents, or on the Gateway page asking about model routing.
2. **Be specific.** "How do I add a fallback model?" works better than "help me with models."
3. **Ask follow-ups.** PYTHIA remembers the conversation within the same chat session.
