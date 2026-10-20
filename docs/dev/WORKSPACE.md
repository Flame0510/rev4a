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
| 409 | Save with `expectedMtimeMs` when the file changed on the agent (`The file changed on the agent since you opened it`, with `mtimeMs`) or was deleted there (`The file was deleted on the agent since you opened it`, with `deleted: true`) |
| 413 | File larger than 2 MiB: `File too large to open here (<size>, limit 2 MB)` (not in tail/range/download/info modes; download: over 50 MiB) |
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
      "path": "/root/.openclaw/workspace/", "containerName": "agent_8ba21f83", "running": true,
      "readOnlyPaths": ["/root/.openclaw/workspace/.rev4a"] }
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

**Response (file read):** `{ workspace, label, path, type: "container", content, size, mtimeMs }`. `content` is
the file's exact text (UTF-8): nothing is trimmed and no newline is added. Binary files are not
served in this mode: the page decides by extension or a NUL character and never offers Save for
them. Images, SVG, PDF, audio and video are read with `raw=1` (next section).

### `GET /api/workspace?workspace=<id>&path=<file>&raw=1`

Raw mode: `200` with the exact bytes and `Content-Type` from a fixed extension map (png, jpg, jpeg, gif, webp,
avif, bmp, ico, svg, pdf, mp3, wav, ogg, oga, m4a, flac, aac, mp4, m4v, webm, mov, ogv), `Content-Length`,
`X-Content-Type-Options: nosniff`, `Content-Disposition: inline; filename*=UTF-8''<encoded basename>`,
`Cache-Control: no-store`, and for SVG `Content-Security-Policy: sandbox; default-src 'none'; img-src data:;
style-src 'unsafe-inline'`. Other extensions answer 415 `No preview for this file type`; a directory is 400; over
50 MiB is 413 `File too large to open here (<size>, limit 50 MB)`. At most two reads over 8 MiB run at once (a third gets 503, try again), because a large read holds about 3.3x the file in memory. Errors keep the statuses above. No Range support.

### Tail, range, info and download (WS-3)

**Additions (WS-3).** All are additive; every existing field and status is unchanged.

- `stat` now reports the mtime too (`stat -c '%F|%s|%Y'`): whole seconds, so every `mtimeMs` below is a multiple of 1000. The text read response (`&path=<file>`) adds `size` and `mtimeMs` (taken from the stat just before the read, so a file that changes during the read shows up as a conflict, never as a false match).
- **Tail:** `&path=<file>&tail=<bytes>` (empty value: 262144; 1 to 2097152) returns the last bytes. **Range:** `&offset=<n>&length=<m>` (`length` 1 to 2097152). Either answers `200 { workspace, label, path, type, content, size, mtimeMs, offset, length, truncated }` for any text file whatever its size (no 413 in these modes). The window is cut on UTF-8 boundaries: a partial character at the start (when `offset` > 0) and at the end (when the window stops before the end of the file) is dropped, and `offset`/`length` are the byte position and size of what is really returned; `truncated` is true when that is not the whole file. Invalid UTF-8 inside the window answers 415; a partial character at the very end of the file counts as invalid. Bad numbers, or `tail` together with `offset`/`length`, answer 400. The file size is read in the same container call as the bytes, so a log the agent appends to meanwhile never shifts the window (`size` in the answer is that size; bytes appended after it show at the next read). A file that disappears before the read answers 404, never empty content.
- **Info:** `&path=<file>&info=1` answers `200 { path, size, mtimeMs, kind: "text" | "binary" | "empty", label? }` from the first 4 KiB: a NUL or invalid UTF-8 is `binary`; `label` names a format from its magic number (SQLite database, ZIP archive, ZIP (Office document) for docx/xlsx/pptx by extension, gzip archive, tar archive, PDF document, PNG, JPEG, GIF and WebP image, ELF executable, WebAssembly module, MP4 video, MP3 audio) and is left out for anything else. A directory or special file is 400.
- **Download:** `&path=<file>&download=1` answers the exact bytes of any regular file up to 50 MiB with `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename*=UTF-8''<encoded basename>`, `Content-Length`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`. Same confinement, large-read limiter (503) and statuses as raw mode; 413 over 50 MiB. No extension check.
- **Read-only roots:** `action=list` adds `readOnlyPaths: string[]` to each workspace (read-only bind mounts inside the workspace root, from `docker inspect`, e.g. `/root/.openclaw/workspace/.rev4a`; `[]` when the inspect fails), and the `tree=1` entries inside one carry `readOnly: true` (the key is absent elsewhere).
- **Save conflict:** `PUT` accepts an optional `expectedMtimeMs` (the `mtimeMs` from the read). When the file exists and its mtime (whole seconds) differs, nothing is written and the answer is `409 { error: "The file changed on the agent since you opened it", mtimeMs }`. The comparison runs inside the container's write script as the last step before the rename, so the only window left is a change in the same second as the one the page saw (a precision of one second). A file the agent deleted meanwhile is a 409 too (`deleted: true`), never re-created silently; Overwrite (a save without `expectedMtimeMs`) creates it again. Without `expectedMtimeMs` a save is exactly as before. A successful `PUT` answers `{ ok: true, mtimeMs }`.

Helpers (`tailArgv`, `rangeArgv`, `decodeWindow`, `describeFile`, `detectFileLabel`, `downloadHeaders`, `WRITE_SCRIPT`) are in `lib/workspace-fs.ts`; tests in `scripts/test-workspace-info.mjs`. The tail and range reads run constant scripts (`tail -c "$1" -- "$2" | base64 -w0`, and the same with `| head -c "$3"` for a range), with the path and numbers as positional arguments.

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

**Optional body field:** `expectedMtimeMs` (a number, negative for a file dated before 1970; normally the `mtimeMs` of the last read): see the save conflict above.

**Response:** `{ "ok": true, "mtimeMs": 1750000000000 }` (`mtimeMs` is the new mtime, left out if it could not be read). Exactly `content` is written; no newline is added.

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
3. `stat -c '%F|%s|%Y'` gives the kind, size and mtime: a directory is listed, a file over 2 MiB is 413, a special file (device, fifo) is 400.
4. `base64 -w0 -- <path>` returns the exact bytes; they must be valid UTF-8 (else 415, so a file in another encoding is never opened as text and saved back corrupted). A timeout or a failed read is an error, never an empty file.

### Raw read (`raw=1`)

Same steps 1 to 3 (confinement, `realpath -m`, `stat`), with two more checks: the extension of the requested path and of the real path (after symlinks) must be in the map (a link named `x.png` pointing at `.env` is 415), and the size must be at most 50 MiB. Then `base64 -w0 -- <path>` runs with a `maxBuffer` for 50 MiB of base64 and a deadline of 15 s plus 1 s per MiB (at most 90 s). A timeout or failed exec throws, so partial bytes are never served. The base64 is decoded with `Buffer.from`; if the decoded length differs from the `stat` size the answer is 502 `The file changed while it was read`. Helpers: `rawContentType`, `rawHeaders`, `rawTimeoutMs` in `lib/workspace-fs.ts`; tests in `scripts/test-workspace-media.mjs`.

Listing a tree uses `find <root> ( -name node_modules -o -name .git -o -name .next -o -name .trash -o -name cache ) -prune -o -mindepth 1 -printf '%P|%y|%s|%T@\0'` as argv; hidden top-level entries are left out.

---

## 7. Writing

- The content goes on **stdin**; the path is the positional argument of a constant `sh -c` script (`WRITE_SCRIPT` in `lib/workspace-fs.ts`). Nothing from the request is part of a shell string, so a line `EOFINNER` or `$(…)` in a file is just text.
- The script writes a temporary file next to the target, copies the target's mode and owner onto it when the target exists (`cp -p`; a new file gets 0644), and renames it over the target: atomic, so a reader never sees half a file. Parent directories are created. No newline is added. A target that exists but is not a regular file (fifo, device) is refused with 400; a killed save removes its temporary file.
- With `expectedMtimeMs`, the script compares `stat -c %Y` of the existing target with that value (seconds) just before the rename and exits 23 (409) on a difference or when the target no longer exists, leaving the target and the directory untouched.
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
