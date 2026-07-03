# What PYTHIA Can Answer

> **Last updated:** 2026-07-03

PYTHIA is the in-dashboard AI concierge for Olympus. This document defines what she can and cannot answer.

---

## Navigation Questions

- "Where do I find the agents page?"
- "How do I get to the container list?"
- "Is there a page for cron jobs?"
- "Where can I see my AI providers?"
- "How do I create a new agent?"
- "Where is the lineage graph?"
- "How do I open the file explorer?"
- "Which page shows costs?"

## How-To Questions

- "How do I create an agent?"
- "How do I filter agents by status?"
- "How do I open a terminal for a container?"
- "How do I see the tool calls for a session?"
- "How do I configure a provider?"
- "How do I set up the gateway?"
- "How do I enable/disable models on the gateway?"
- "How do I check if my API key is working?"
- "How do I take a screenshot of the dashboard?"
- "How do I view memory files?"

## Explanation Questions

- "What does the lineage graph show?"
- "What do the different statuses mean (idle, working, completed, error)?"
- "What is a gateway?"
- "What is the difference between a plugin and a skill?"
- "What are MCP tools?"
- "What does 'cost override' mean?"
- "What is a session?"
- "What is workspace?"

## Current Page Questions

- "What can I do on this page?"
- "What does this page show?"
- "What is this chart telling me?"
- "What do these buttons do?"
- "What is this status indicator?"

## Operational Questions

- "Which agents are configured?"
- "What models are available?"
- "Which providers have API keys set up?"
- "What cron jobs are scheduled?"
- "How many containers are running?"
- "How does cost calculation work?"
- "What is the lineage view for?"
- "How do agents connect to providers?"

---

## What PYTHIA Cannot Answer

- **Live data**: "How many sessions are active right now?" — PYTHIA doesn't have direct database access. She'll tell you to check the dashboard.
- **Future predictions**: "How much will we spend next month?" — PYTHIA has no forecasting model.
- **Development/code questions**: "How is the daemon implemented?" or "What database schema is used?" — PYTHIA is a user concierge, not a developer tool.
- **Implementation details**: Anything about SQL queries, API endpoints, code structure, or how the backend works internally.
- **Destructive actions**: PYTHIA cannot modify anything — she is read-only guidance.
- **Historical data before database records**: Events that weren't captured are not available.

---

## How to Get the Best Answers

1. **Open the relevant page first.** PYTHIA gives better guidance when you're on the Agents page asking about agents, or on the Gateway page asking about model routing.
2. **Be specific.** "How do I see an agent's tool calls?" is better than "how do I use this?"
3. **Follow up naturally.** PYTHIA remembers the conversation history, so you can ask follow-up questions.
4. **For live data, look at the dashboard.** PYTHIA will point you to the right page.
