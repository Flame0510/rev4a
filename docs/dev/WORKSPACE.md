# Workspace — Agent File Explorer

> **Status:** Active — `main` branch
> **Last updated:** 2026-10-20

---

## 1. Overview

The Workspace feature is a file explorer and editor for the OpenClaw workspace of every
agent container. Users can browse a recursive tree, read text files and write them back, all
from the Rev4a dashboard.

**Purpose:** Give operators direct access to agent workspace files (MEMORY.md, logs,
configurations, project files) without needing to exec into containers.

There is no host ("Local") workspace any more. `REV4A_WORKSPACE_ROOT` is ignored: when it is
set, the server logs one line at start (`[workspace] REV4A_WORKSPACE_ROOT is no longer used`)
and carries on.

---

## 2. Workspace Selector (UI)

The dashboard includes a **workspace selector** — a dropdown that lists every agent.
Selecting one loads its file tree into the editor panel. A stopped agent is listed too
(`running: false`) but its files cannot be opened until it is started.

---

## 3. Available Workspaces

Container workspaces are **auto-discovered** at runtime by querying Docker, running and
stopped alike:

```
docker ps -a --filter label=AGENT_ID --format '{{.Names}}|{{.Label "AGENT_ID"}}|{{.State}}'
```

| Property | Value |
|---|---|
| ID convention | `container-<containerName>` (e.g. `container-agent_8ba21f83`) |
| Label | The agent's display name (`AGENT_NAME`), else `<agentId> (<containerName>)` |
| Type | `container` |
| Root path | `/root/.openclaw/workspace/` |
| Running | `true` when the container is running |
| Access | `docker exec` with argv arrays (no shell on the host) |

Only containers with the `AGENT_ID` Docker label appear — this prevents showing
infrastructure containers (Traefik, databases, etc.) that are not agent workspaces. An id
that names no agent container is refused with 400, so the container name in a request is
never passed to Docker unchecked.

---

## 4. API Endpoints

Errors are always JSON `{ "error": "..." }` with a real HTTP status:

| Status | Meaning |
|---|---|
| 400 | Unknown or malformed workspace id, or a bad path (not a string, empty, NUL), or the path is a directory on save |
| 403 | The path is outside `/root/.openclaw/workspace` after `..` and symlinks are resolved |
| 404 | File not found |
| 413 | File larger than 2 MiB: `File too large to open here (<size>, limit 2 MB)` |
| 415 | Not valid UTF-8 (read as exact bytes): `Not a UTF-8 text file: it cannot be opened or edited here` |
| 423 | Save into a read-only location (a read-only bind mount, e.g. `/root/.openclaw/workspace/.rev4a`) |
| 502 | The agent container is not running (`Agent <label> is not running`) or did not answer in time |
| 503 | Docker is not available |

### `GET /api/workspace?action=list`

List the agent workspaces.

**Auth:** Bearer token or the `rev4a_token` browser cookie

**Response:**
```json
{
  "workspaces": [
    { "id": "container-agent_8ba21f83", "label": "Giuanmuzzziins", "type": "container",
      "path": "/root/.openclaw/workspace/", "containerName": "agent_8ba21f83", "running": true }
  ],
  "dockerAvailable": true
}
```
When Docker is down: `{ "workspaces": [], "dockerAvailable": false }` (still 200).

### `GET /api/workspace?workspace=<id>[&path=<path>][&tree=1]`

List files in a workspace, read a file, or return a recursive tree.

**Auth:** any auth method

**Query params:**
| Param | Default | Description |
|---|---|---|
| `workspace` | first running agent | Workspace ID |
| `path` | workspace root | Directory or file path to read; relative paths are read against the root |
| `tree=1` | — | When set, returns a recursive flat list of all entries |

**Response (directory listing):**
```json
{
  "workspace": "container-agent_8ba21f83",
  "label": "Giuanmuzzziins",
  "path": "/root/.openclaw/workspace",
  "type": "container",
  "files": [
    { "name": "skills", "isDirectory": true, "isFile": false },
    { "name": "SOUL.md", "isDirectory": false, "isFile": true }
  ]
}
```

**Response (`tree=1` — recursive tree):**
```json
{
  "workspace": "container-agent_8ba21f83",
  "label": "Giuanmuzzziins",
  "path": "/root/.openclaw/workspace/",
  "root": "/root/.openclaw/workspace/",
  "type": "container",
  "entries": [
    { "name": "skills", "path": "/root/.openclaw/workspace/skills",
      "relPath": "skills", "type": "directory", "size": 0,
      "mtimeMs": 1750000000000, "isDirectory": true, "isFile": false },
    ...
  ],
  "tree": [ "...same items as entries..." ],
  "files": [ "...same items as entries..." ]
}
```

**Response (file read):** `{ workspace, label, path, type: "container", content }`. `content` is
the file's exact text (UTF-8): nothing is trimmed and no newline is added. Binary files are not
served: the page decides by extension or a NUL character and never offers Save for them (raw
bytes are a later card).

### `PUT /api/workspace`

Write content to a workspace file.

**Auth:** any auth method

**Body:**
```json
{
  "workspace": "container-agent_8ba21f83",
  "path": "/root/.openclaw/workspace/test.md",
  "content": "hello"
}
```

**Response:** `{ "ok": true }`. Exactly `content` is written; no newline is added.

---

## 5. Entry Sorting (Consistency Rule)

All directory listings and trees are sorted server-side by `compareWorkspaceEntries()`:

1. **Directories before files** — at every level of a nested path
2. **Alphabetical within each group** — directories sorted by name, then files sorted by name
3. **Recursive depth-first** — the same rule applies at every nesting level

This ordering is **always applied server-side** so the UI receives a consistent
sequence regardless of filesystem order (`readdir` order differs across platforms and
filesystems). The comparator lives in `lib/workspace-fs.ts`.

---

## 6. Reading

1. The container is looked up in `docker ps -a --filter label=AGENT_ID` (once per request): unknown id 400, stopped 502.
2. The path is normalised against the root (`..` out of the root is 403), then `realpath -m -- <path>` runs in the container and the result is checked again (a symlink pointing outside is 403).
3. `stat -c '%F|%s'` gives the kind and size: a directory is listed, a file over 2 MiB is 413, a special file (device, fifo) is 400.
4. `base64 -w0 -- <path>` returns the exact bytes; they must be valid UTF-8 (else 415, so a file in another encoding is never opened as text and saved back corrupted). A timeout or a failed read is an error, never an empty file.

Listing a tree uses `find <root> ( -name node_modules -o -name .git -o -name .next -o -name .trash -o -name cache ) -prune -o -mindepth 1 -printf '%P|%y|%s|%T@\0'` as argv; hidden top-level entries are left out.

---

## 7. Writing

- The content goes on **stdin**; the path is the positional argument of a constant `sh -c` script (`WRITE_SCRIPT` in `lib/workspace-fs.ts`). Nothing from the request is part of a shell string, so a line `EOFINNER` or `$(…)` in a file is just text.
- The script writes a temporary file next to the target, copies the target's mode and owner onto it when the target exists (`cp -p`; a new file gets 0644), and renames it over the target: atomic, so a reader never sees half a file. Parent directories are created. No newline is added. A target that exists but is not a regular file (fifo, device) is refused with 400; a killed save removes its temporary file.
- A save into a read-only bind mount (the Rev4a rules at `/root/.openclaw/workspace/.rev4a`) is refused with 423 before anything is written: the route reads the container's mounts with `docker inspect` and compares the destination.

---

## 8. Design Decisions

| Decision | Rationale |
|---|---|
| Server-side sorting | Filesystem `readdir` order is platform-dependent (e.g. ext4 vs overlayfs). Sorting server-side guarantees consistent ordering for the UI. |
| Container discovery via `AGENT_ID` | Avoids listing all containers (including Traefik, DBs, etc.) — only agent containers are relevant workspace targets. |
| No host shell, async exec | Every docker call is an argv array run asynchronously with a timeout (`lib/docker-exec.ts`, or `execFile` for `docker ps`/`inspect`). A container name or path can not turn into a second command, and a slow container does not freeze the server. |
| Container root at `/root/.openclaw/workspace/` | Prevents operators from accidentally reading/writing system files inside the container. A path is confined to the root after `..` and after symlinks are resolved with `realpath -m` in the container; a sibling such as `workspace-evil` is refused too. |
| Local workspace removed | The host workspace read the Rev4a host's own disk through `REV4A_WORKSPACE_ROOT`. It was never the agents' files and was a way out of the sandbox; the page now shows agent containers only (2026-10-20). |
| Real-time file reads (no caching) | Workspace files change frequently (agents write MEMORY.md, logs). Caching would require invalidation logic with little benefit — file reads are fast. |
| UI tree auto-refresh (5s polling) | The file tree re-fetches every 5s (recursive `setTimeout`, not `setInterval`, to avoid overlapping requests) so external changes — an agent editing its own `TOOLS.md`, a restore, a manual edit inside the container — appear without a manual page reload. Only the tree is refreshed; the currently open file is left untouched to avoid clobbering an in-progress edit. Cleaned up on unmount via a `mounted` flag + `clearTimeout`. |
| Flat tree with aliases (`entries`, `tree`, `files`) | Backward compatibility: older UI components expect `files` or `tree` keys; `entries` is the canonical name in the current codebase. |
