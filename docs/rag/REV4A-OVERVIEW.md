# What is Rev4a?

> **Last updated:** 2026-11-18

Rev4a is the control panel for your AI agent infrastructure. It shows you everything your agents are doing, how much they cost, and whether the system is healthy — all in one dashboard.

## What can you do in Rev4a?

### Dashboard (`/`)
The main page. See live sessions (who's working right now), cost summary, an overall health indicator, and a real-time event feed. Click any session row to open the Session Drawer and see the session's recent actions.

The health cards cover Rev4a's own runtime, cron and watchdog, and lineage. The Machine card shows the server's CPU, RAM and fullest disk right now, coloured when it reaches a threshold, and links to the System page for details. There is no wizard banner on the dashboard; an incomplete setup redirects to `/wizard` instead.

### First-run wizard (`/wizard`)
First-run setup wizard that guides new users through configuration. Five screens (four setup steps, then Ready), since 1.29.0:
1. **Welcome** — what Rev4a is and what it can do
2. **Access** — skippable: Only this computer saves both listen keys as local at Finish, then restarts (disabled unless the browser uses a supported loopback host); From other devices links to the domain/Tailscale guide; By IP for now changes nothing and keeps warnings
3. **Providers** — add API keys for DeepSeek, OpenAI, OpenRouter, or Groq (saved via the Provider Gateway)
4. **First Agent** — understand how agents work and what you need to create one
5. **Ready** — site map of key sections with quick links

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

**Browser access:** on agents running OpenClaw 9.x, every new browser has to be approved once before the agent's Control UI connects. The detail panel's "BROWSER ACCESS" section lists browsers waiting for approval, with Approve and Reject, and the browsers already approved, with Rename and Revoke. A yellow "BROWSER WAITING" chip on the agent card says a request is pending. While an agent's Gateway is still starting (seconds to a few minutes after Start, a restart, a recreate or an update) its card shows a "STARTING m:ss" chip and the **Open** button reads "Starting…" and is disabled only while the Gateway answers that it is starting (in the first seconds, before it answers at all, Open stays enabled and the Control UI may not load yet); if it has not become ready after 10 minutes the chip reads "NOT READY", and Open is enabled again. The **Open** button tries a one-time link that lets the browser in without any approval; if the agent cannot issue one (it is stopped, or the link fails) it opens the normal link. To let someone else in, **Invite link** gives a link to send them: their browser appears under waiting for approval, and nothing opens until you approve it. The link contains the token all agents share; changing the agents token cancels every link already sent.

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
binaries) are not, and should live under `/root/.local`. The agent detail panel's
**SYSTEM PACKAGES** section shows the restore outcome, restored packages, version changes
and failures. The underlying status is also in `/root/.rev4a/packages-status.json` inside
the agent, with the state `running`, `ok`, `partial`, `failed` or `nothing-to-do`.

**Updating an agent:** the detail panel's "OPENCLAW VERSION" section shows the version the
agent runs and, when a newer one is downloaded, **Update to <version>**. The update takes
the agent offline for a few minutes: it backs the agent up while stopped, starts it on the
new version (which converts its data), and checks that no conversation history or cron job
went missing. Afterwards **Roll back to <version>** puts back the backup taken just before
the update, on the old version; anything the agent did after that backup is lost, including a
recreate or restore done since (the confirmation names the backup date and any such job). The agent
must be running to start an update. Clicking Update right after Start is fine: the update waits up to 5 minutes for the
agent to finish starting ("Waiting for the agent to finish starting…") before it reads anything, and
fails without stopping or backing up the agent only if it never becomes ready.

A slow start is not a failure: if the new version needs more than 10 minutes to start, Rev4a keeps
waiting up to 30 more minutes and then finishes the update. An update recorded as failed or interrupted
whose agent has since been proved fine (running the new version, ready, nothing missing against the
stored baseline) is shown as a muted line with the resolution instead of a red failure, and its
**Roll back** button is replaced by a secondary **Roll back anyway…** (latest update only; it asks you to
type the agent's name and warns that everything done since the backup is lost); one that cannot be proved stays
red with Roll back. Rev4a re-applies its config before it marks an update resolved. The collapsed **Update
history** lists the last 20 updates (date, versions, status, error, resolution, backup file), read-only: the
backup is the agent's data from before that update, and going back to the previous version is the Roll back
of the latest update (a Restore from the Backup section keeps the OpenClaw version).

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

### Lineage (`/lineage`)
Interactive graph showing session family trees (read from each agent's container) — which agent spawned which child agent, across configurable time periods: 15m, 1h, 6h, 1d (the default), 7d, 30d, and all. The chosen period is remembered in the browser. Click any node to inspect. Includes a live feed side panel. A session running on a ChatGPT subscription shows `subscription` instead of a dollar amount (its recorded list price is not a spend).

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

### Orphan agent volumes (on the System page)
Shown only when Docker holds `agent-*-data` volumes that no container uses. Each row has the volume's name, size and creation time and a Delete button behind a confirmation; nothing is deleted automatically. A volume whose agent is being recreated or updated is not listed, and one whose agent's last recreate, update or edit did not finish is listed as kept, without Delete, because it may hold the only copy of that agent's data. A create that fails now removes its own container and volume.

### Agents and containers (on the System page)
Under the machine's charts: what Docker holds on disk (images, volumes, writable layers, build cache, and how much of each no container uses), then one row per container sorted by CPU. A closed row shows its name, whether it is an agent, and its CPU share, memory, storage and processes now, with the average and peak over the chosen range (1 hour to 30 days); open it for the same three charts as the machine — CPU, Memory, Storage — for that container. "Everything else" is what is not a container (the host, Rev4a, other software). Each agent's panel on the Agents page has the same numbers in its RESOURCES section, with a link to its charts. Below, the recent alerts (spend and loop alarms (spend.session: a session that reached its model's whole context window; spend.loop: most calls failing in the last hour; spend.unusual: the last 24 hours cost over 3 times the agent's usual day; spend.unaccounted: a provider balance fell more than Rev4a's agents explain), which are alarms only and carry a Snooze 24 h button): CPU, memory or a disk that crossed its limit, a container with 1000 or more processes on two samples in a row, or one holding 90 % of Docker's memory for five, a process killed for lack of memory in an agent (an out-of-memory alert, `container_oom`: at most one per container per 10 minutes, with the number of kills in between; it can happen with or without a memory limit), and when.
When Docker still sees a container but it has no current statistics, its row says "no data". If collection stops, the current figures are hidden and old rows say "not current" instead of implying a live reading.

### Container Terminal (`/containers/terminal/[id]`)
Live web terminal into a running Docker container — like SSH in the browser: Tab completion, command history, `top`, `vi`, resizing with the window. If the connection drops (network, laptop sleep) the shell keeps running for 2 minutes and reconnecting picks it up; reloading the page resumes it too. **Close** ends the shell. If the container is stopped or missing, the page says so and offers **Reconnect**. Only a logged-in user can open it.

### Workspace (`/workspace`)
File explorer for the OpenClaw workspace. Browse, view, and edit text files (up to 2 MB) in every agent's workspace. A text file opens on a readable preview: Markdown rendered, code, YAML and JSON highlighted (invalid JSON names the line and column), CSV and TSV as a table (the separator, comma, semicolon, tab or pipe, is detected), and .env-like files with every value hidden until Reveal values; EDIT shows the source; switch between agents via a dropdown. Stopped agents are listed (greyed) but must be started to open their files. The tree opens one folder at a time, so even a very large workspace opens at once; the "Show hidden files" switch also shows dot-files, and the address keeps the agent and the open file, so a link or a reload comes back to the same place. The `.rev4a` folder is read-only (a lock marks it). If the agent changes the open file, a banner offers to reload it. PDF files, images (including SVG), audio and video open read-only with the browser's own viewer or player (up to 50 MB); they cannot be edited or saved. Other binary files are not opened, but the panel names their format and size. Every file that opens (text, tail, media or the binary panel) has a Download button (up to 50 MB); a log tail has a Reload button. A log file over 256 KB, or a text file over 2 MB, opens on its last 256 KB (read-only) with a "Load earlier" button. If the agent changed a file after you opened it, Save asks whether to reload or overwrite instead of replacing it silently.

### Credentials (`/credentials`)
Manage third-party service credentials: GitHub, Trello, Vercel, Supabase, Notion, MongoDB. Each credential lists agents with a Switch. Switching on puts the token into the agent's OpenClaw secret store as an environment variable (`SUPABASE_ACCESS_TOKEN`, `TRELLO_API_KEY` and `TRELLO_TOKEN`, `NOTION_API_TOKEN`) and enables the matching skill; no TOOLS.md entry is written. GitHub and Vercel are the exception: OpenClaw reserves `GH_TOKEN`/`GITHUB_TOKEN` and the Vercel CLI ignores a token-only environment, so GitHub is delivered as OpenClaw's managed GitHub identity (a handoff plus `tools.github.configure`) and Vercel through the CLI's own `auth.json` + `config.json {currentTeam}`. Delivery needs OpenClaw 2026.9.0 or newer on the agent (Trello needs 2026.9.9, whose image ships the `jq` its skill requires; MongoDB needs 2026.9.9, the only release it was verified on); older agents can still be detected and have legacy credentials switched off. MongoDB stores the connection string as `REV4A_MONGODB_URI` (never `MONGODB_URI`, which OpenClaw drops from its exec tool), installs `mongosh` 2.13.0 under `/root/.local` in the agent on the first switch-on (about 200 MB; the first switch-on can take a few minutes; it stays on a switch-off), and enables Rev4a's shared skill `rev4a-mongodb`; the agent queries through mongosh, and read-only access depends on the database user's read role, not on Rev4a. Each row's Switch shows what the agent really holds (Rev4a reads the container, so a credential changed from another Rev4a or on the agent itself shows as it is). A credential enabled in Rev4a but missing from the agent says "Not found in the agent" with Redeliver and Remove actions; an unknown read shows `?` and Rev4a's setting; stopped and busy agents show a disabled Switch with a reason. An agent that holds another credential of the same provider says which one. An agent on the ChatGPT subscription runtime gets a note: the token reaches only commands run through OpenClaw. The agent panel has a read-only CREDENTIALS section. A credential switched on for any agent, or whose switch-off failed ("Removal failed", Retry removal), cannot be deleted. Before rolling Rev4a back to an older version, switch credentials off. Every reveal is recorded in an audit table, which no route or view reads. Gateway CLI calls use the token from `/root/.agent-token` when present, so a rotated token does not break credential switches. Secrets are held unencrypted in `credentials.db`, and in the agent's secret store (or, for GitHub and Vercel, OpenClaw's managed `gh` profile and the Vercel CLI files).

### Subscriptions (`/subscriptions`)

If a connected Claude account needs to accept Anthropic's updated terms, the connect dialog,
Subscriptions usage block and agent MODEL line explain that Claude cannot answer. Use **Open
claude.ai**, sign in with that account and accept on Anthropic's site, then **Check again** in
the dialog or usage block. After Open, those two views check every 15 seconds while visible for
up to 5 minutes; the agent line keeps its normal minute poll. Rev4a never accepts terms or drives
the notice, because Anthropic's Consumer Terms §3.7 forbid automated access and Claude Code
requires account flows to complete through Anthropic itself. The connection remains configured.

Connect a ChatGPT Plus or Pro (Codex) account, or a Claude Pro/Max plan through Claude Code (Experimental), to an agent and let the agent use a subscription model as its primary model. For ChatGPT, press Connect on the agent's row: Rev4a shows a link and a code, and you enter the code on OpenAI with your ChatGPT account (the code expires in 15 minutes). The page shows which agents are connected and until when, and the model each one uses. The model itself is chosen in the agent's MODEL section (agent panel), where subscription models appear next to the Rev4a proxy models for the primary and the fallbacks. When you pick a subscription model as primary with no fallback set, the panel pre-fills the previous model as the first fallback, so when the subscription reaches its usage limit (shared with your own Codex use) the agent falls back to it. Disconnect (after a confirmation) returns the agent to its own model and signs the account out. Subscription calls are not counted as spend: the Costs page shows them in their own "ChatGPT subscription" section with their API value (what the same calls would have cost at OpenAI API prices); calls an agent runs on a Claude plan through Claude Code are in a separate "Claude subscription" section. The ChatGPT accordion shows, at the top, the account's usage limits (5 hours and weekly, with the reset times); the quota belongs to the ChatGPT account, so it is shared by every agent signed in with it and your own Codex use. The sign-in stays inside the agent; Rev4a stores nothing. A row whose status could not be read shows the reason and a **Retry** button ("the agent is still starting" clears by itself). An agent on an unsupported OpenClaw version says so ("This agent is not on a supported OpenClaw version … Update it first."); it must be updated on the Agents page.

The subscription **API** also knows a Claude (Pro/Max) plan through Claude Code: for one agent it can install Claude Code, start Anthropic's own sign-in, take the code the operator pastes, switch the agent's `anthropic/*` models to OpenClaw's Claude Code runtime (`claude-cli`), report the state and disconnect. The code is handed to Claude Code once and never stored; the tokens stay in the agent. The page shows this provider as "Claude (via Claude Code)", marked Experimental: Connect opens a guided dialog (install on the first connect, sign in on claude.com, paste the code), the rows read "Connected until <date>" / "Not connected" / "Signed in, not in use" / "Needs a new sign-in", and a connected agent gets a "Claude subscription" group in the MODEL section. Usage counts against the operator's own Claude plan; Anthropic's limits assume ordinary individual use, so for round-the-clock automation an API key is the safer choice. The accordion shows the plan's usage limits (5 hours and Week bars; one tiny Claude Code call per account, cached for 3 minutes, and Refresh bypasses the cache) and the agent panel's Claude line shows the windows left; it closes with a note on ordinary individual use and a link to Anthropic's guide. Connect also puts `IS_SANDBOX=1` in the agent's Claude Code settings (`/root/.claude/settings.json`, merged, never overwritten) so that manual compaction works (Claude Code refuses it as root otherwise); the daemon adds it to agents connected before that. Connecting a Claude plan also switches off, on Claude runs only, tools no agent uses there to save tokens (the list is `tools.byProvider.anthropic.deny`); the agent can switch one back on itself.

### Crons (`/crons`)
Scheduled tasks auto-discovered from every running Docker container with the `AGENT_ID` label (via `docker exec openclaw cron list --json`); there is no host source. Filter jobs by agent using the toolbar tabs (an agent by its display name; the container name is a secondary detail). Each job shows name, description, cron expression, next run, last run, and last status. Toggle on/off per job. The run history panel shows recent cron run executions for the selected job, loaded on demand from the container's gateway.

### Context (`/memory`)
A read-only, per-agent overview of what OpenClaw puts in the agent's prompt. Pick an agent (it must be running) and the page shows the files OpenClaw injects (AGENTS.md, SOUL.md, IDENTITY.md, USER.md, then BOOTSTRAP.md while pending on a brand-new workspace and MEMORY.md when present) with their size in characters, how much of each is injected, and a "truncated" badge when a file is cut. OpenClaw cuts a file longer than the per-file cap (20000 characters by default); once the running total reaches the total cap (60000 by default), the file that crosses it is cut to the characters that remain and later files get nothing. The agent never sees the cut part. The caps in force are shown, with where they come from (the agent's config or the OpenClaw default). The page also lists the files under `memory/` (newest first) and the read-only Rev4a rules file. Every file name links to the Workspace page, where the file can be opened and edited; the Context page itself changes nothing.

Blank files are skipped and a missing file shows as "missing". A linked (symlinked) file is followed by OpenClaw but its size is not read here, so the page marks it unknown and leaves it out of the total. A sub-agent session gets AGENTS.md only (OpenClaw's system-prompt docs: "Sub-agent sessions only inject AGENTS.md"); MEMORY.md is also left out of cron, group and channel sessions. TOOLS.md and HEARTBEAT.md are not injected; the page only mentions them when present.

### Config (`/config`)
Rev4a application settings. View and modify environment variables (password, tokens, secrets), restart the server. The client sends only edited values. Config patches `.env` in place, preserving other keys, comments, blank lines, order and line endings; a daemon-reload is attempted only after a file change. Unchanged values stay intact. Edits use physical lines: the last assignment of an edited key is replaced and earlier duplicates are removed; clearing a stored non-empty value removes all its assignments. If `.env` has a multi-line or unterminated quoted value, a value on the next line, text after a closing quote (including an inline comment), or a backslash immediately before a same-kind quote, Config answers 409 without writing. Edit that file by hand. Save errors remain visible beside Save & Restart after the dialog closes, and the edited values remain available for retry. Allowed settings shown from the process environment are saved only if edited. A full unchanged GET-to-PUT round trip does not write the file. The **Time zone** card sets the zone the dashboard shows times in (saved to `settings.json`, by default the server's own zone, applied at once). The **Agent defaults** section (the default memory limit offered for new agents) is saved to `agent-defaults.json` and applies at once, without a restart; the "restart Rev4a" hint is for the `.env` values only. It only prefills the create wizard and never changes an existing agent.

### Plugins (`/plugins`)
Browse the OpenClaw plugins of one agent, read from its container (pick the agent at the top; a stopped agent must be started first). Search by name, id or description and filter enabled or disabled. Each row shows the version, whether it is enabled, and how many tools and hooks it adds. The page is read-only for now: turning plugins on or off is not available yet. The list is cached for about a minute and Reload refreshes it.

### Skills (`/skills`)
Skill registry showing all skills across three sources:
- **Shared** — global skills from `~/.config/rev4a/shared/shared-skills`, available to all agents
- **Per-agent** — skills in each agent's workspace (`<workspace>/skills`), shown with agent label
- **Bundled** — skills shipped with OpenClaw (read-only)

Filter by source, view and edit SKILL.md content, and **promote** agent-local skills to shared with one click. A partial promotion reports the skipped-file count and returned filename sample in its toast, with an ellipsis when more were skipped. Skills whose name starts with `rev4a-` are Rev4a's own: they show "Managed by Rev4a" and are read-only (no Edit, no Delete, and a workspace skill cannot be promoted under such a name).

### Setup (`/setup`)
First-run password setup. Enter the **Setup code** printed by `rev4a serve` in its
terminal or service journal (`journalctl -u rev4a`), then choose a password of at
least 8 characters. The code changes at every start until setup finishes; case,
dashes and spaces do not matter. Direct Next.js starts (`npm run dev`) print it on
the first setup request. Setup sets `REV4A_PASSWORD` and any missing JWT secret,
then requires login. Already-configured installs never require a setup code. The password is stored so it reads back exactly: one containing `$`, or a single quote together with leading/trailing spaces, `#` or a leading quote, is refused with 400, and an existing `.env` with multi-line or ambiguous values makes setup answer 409.
All setup/wizard API calls require the code before a password exists and normal
authentication afterwards. New environment values reject non-strings, CR, LF and NUL;
clearing a stored non-empty Config value removes its assignment, while unchanged
empty or multiline values remain intact. At start the launcher comments out `.env` loader
controls (`NODE_OPTIONS`, `NODE_REPL_EXTERNAL_MODULE`, `LD_PRELOAD`,
`LD_LIBRARY_PATH`, `DYLD_*`) and logs only the key names; they belong in the service environment.
The server removes those keys again after Next loads `.env`, preserving loader
settings inherited from the operator's shell or systemd. Runtime-only keys
(`REV4A_SERVER_PID`, `REV4A_STARTED_AT`, `REV4A_RUNNING_VERSION`,
`REV4A_TERMINAL_SECRET`, `REV4A_SETUP_CODE`, `REV4A_LISTEN_STATE`,
`REV4A_DOTENV_KEYS`, `REV4A_SUPERVISED`) are excluded from Config reads and
silently ignored on Config writes, including older open tabs. The launcher
removes their real assignments from `.env` at startup, logging names only, and
clears inherited copies from the base child environment before setting fresh
per-boot credentials. The runtime-key repair skips non-plain files entirely (with a log
message); on plain files it removes only physical assignment lines. The loader-key repair
comments out matching physical lines even inside quoted multiline values or after an
unterminated quote. It recognizes CRLF, CR and LF separators, `KEY=value`, `KEY: value`
and `export` prefixes, preserving the original separators. Both repairs are idempotent.
Deleted operator keys and comments cannot
be reconstructed automatically. File read failures other than a missing file abort
environment writes; existing dotted keys are preserved when saving other keys.

### Login (`/login`)
Password-protected access to the dashboard. (Network exposure: `REV4A_LISTEN` and `REV4A_AGENT_PORTS_LISTEN` take `all`, `local` or one IP; `local` binds the panel to loopback plus the Docker gateway on Linux, and agent ports to loopback, for use behind a reverse proxy or Tailscale; firewall port 3740 on the public interface because nearby hosts could route to the Linux gateway. Unset agent-port settings keep each agent's address; explicit `all` moves them back to every interface at the next Recreate, Update or Edit. An agent's Open button then shows an SSH tunnel when its port is open only on the server.) Enter the Rev4a password to authenticate. Session persists via a JWT cookie (7-day expiry). From the 6th wrong password within an hour the login is locked for that address for 30 seconds, doubling up to 15 minutes; the page shows how long to wait. A restart of Rev4a clears the lock. Behind a reverse proxy, set `REV4A_TRUSTED_PROXIES` to the proxy's address (`127.0.0.1` for a proxy on the same host; a pinned address, never the agent network, for one in Docker), otherwise every visitor shares one address and one attacker can lock everyone out.

Once a password change takes effect, every browser session using the old password is refused by API authentication, protected pages and terminal connections. A password saved in Config takes effect after restarting Rev4a. After the SEC-21 update, every browser has to log in once because older cookies lack the password fingerprint; cookie flags, lifetime and Bearer API access are unchanged.

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
- Status (working, idle, done, error, aborted)

Sessions can have parent-child relationships (lineage): one agent spawns another to delegate work. Rev4a reads them from each agent's container; nothing needs to be registered.

## Caddy Domain mode (1.30.0)

On a Linux host, root can preview `rev4a domain setup <domain> --dry-run` and then run it without the flag.
Point the dashboard host and its wildcard subdomain at the server and allow ports 80 and 443.
Setup configures Caddy, preserves any existing dashboard site as comments, and sets the dashboard and agent
listen settings to local. Restart Rev4a and Recreate running agents to apply those settings.
Running agents use `https://<agent>.<domain>` for Control UI. Published dev ports use `https://<agent>-<3001..3009>.<domain>`
and require Basic auth as `rev4a`. On **Remote access → Domain mode**, select **Show** under
**Dev-port credential**, then **Copy**. The password is read from the protected `domain-auth.json`
in the Rev4a data directory only after Show is clicked.

When Domain mode is off, **Remote access → Domain mode** validates the dashboard hostname, lists the
dashboard and wildcard A/AAAA records, and offers **Check** to refresh status and compare expected and found addresses.
If the host has no public interface addresses, use the server's public IP. Copy the dry-run command
and then the setup command to run on the server. These commands include non-default service settings.
After restart, use **Check**. With Domain mode on,
the section shows the dashboard HTTPS link, Caddy and import readiness, on-demand TLS ask,
applied agent route count and restart state. DNS is checked once on open. A stale Caddy callback
shows the setup command again. Current setup identifies an active managed file as **Domain (Caddy, managed by Rev4a)**.
Never disclose or copy its contents into chat. Control UI still uses OpenClaw token and pairing.
Caddy issues agent certificates on first use for hostnames in the generated route file with an active Docker binding.
Stopping an agent removes those routes on sync. Starting it brings back the same hostnames.
With the managed route active, **Open** goes directly to the agent's HTTPS subdomain, with a one-time
link or token link. If the address is being updated, Rev4a requests a Caddy sync and the tab asks
the operator to try again in a moment. The agent panel's **Ports** list shows TCP publishes in the range 3000–3009,
their listening status and links. Open the panel or press **Refresh** to sample again. Routed dev ports
use the username `rev4a` and point to Remote access for the password. Dev servers bind to
`0.0.0.0` inside the container and allow the operator's domain in their Host header checks.

## Remote access presets and restart (1.29.0)

Remote access (/remote-access, next to Config in Setup) offers This computer only (both listen keys local), Direct (IP) (both all), and
Domain (your own proxy) (both local, append 127.0.0.1 and ::1 to trusted proxies).
Review the keys and values in the confirmation, Apply, then Restart now. Local requires a
localhost, localhost., 127.0.0.1 or ::1 browser URL. Other 127.x loopback URLs must first
reconnect at http://127.0.0.1:<port>. Domain always asks you to confirm an already tested
HTTPS proxy with a loopback or Docker bridge target. Client location is a UX guard, not an
authorization boundary. Unset listen keys show Default (as before); Custom settings select
no card. Saved trusted proxies are compared with the current boot, so a pending proxy-only
restart survives reloading. A loopback dashboard listening on every interface says it is
also reachable from the network on System, with a Manage link to Remote access. System keeps one compact mode/status row below host charts. The page shows Current setup properties, icon preset choices, structured confirmation with a Switch acknowledgement, and running-agent ItemList rows. The current preset and unchanged Apply are disabled.

After restart, recreate each listed running agent explicitly to apply its port setting;
stopped mismatches say **N stopped agents will ask before starting** (NET-1e, 1.29.0).
Start asks **Move and start** (cold backup then Recreate, with progress until running),
**Start as is** (keep its bindings), or Cancel, with a Remote access link. Restart of a
stopped container (including the panel's Restart Container button and direct `/restart` calls)
asks too; Stop and running Restart retain their behavior. Failed Move or Recreate leaves an
initially stopped old container stopped; only an originally running one is restarted on failure.
Start and Restart recheck busy ownership after inspect and reserve the Docker mutation against
competing lifecycle jobs. Busy agents keep their
existing refusal. Cards and detail panels show **Ports: every interface** (or their current
Control UI address) when ports differ; the running panel offers Recreate beside the pill.
An empty agent-port setting never asks or shows a pill. Explicit all detects local bindings too.
There is no automatic recreate or data migration; the choice is made for each start.
Older agents can still start as is. Rollback keeps the same data but loses this prompt.
The active Recreate row retains its loading button through backup stops and matching-port
refreshes until the job finishes.

Completed installs never get the new wizard step or any automatic settings change. The
wizard defers local writes until Finish; choosing another option or skipping cancels them.
Finish uses authenticated Config restart (inherited passwords work). A 409 shows the manual
restart message and allows completion without another restart request.

Config Save & Restart, System and setup share a helper. This process's own systemd unit
comes first (user units excluded), with daemon-reload then restart: direct systemctl as
root, sudo -n otherwise. A refused restart while supervised falls back to rev4a serve's
restart flag. Other supervised installs use the flag directly, reloading all services and
.env. Direct next dev returns 409, Restart Rev4a by hand to apply, and never terminates only
the server. No schema, provider vault or volume migration; rollback to 1.28.0 reads the same
settings.
