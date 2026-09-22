# Rev4a Frontend Architecture

> **Last updated:** 2026-09-22

## Layering

Rev4a UI should follow a layered architecture:

1. `app/*/page.tsx` — routing only.
2. `app/components/*Page*.tsx` — page composition and data orchestration.
3. `app/components/ui/*` — shared design-system primitives.
4. `lib/patterns/*` — domain/data patterns.
5. `lib/*` — infrastructure helpers and pure utilities.

Feature pages should not create new ad-hoc visual languages. Prefer `ui` primitives first.

## UI primitives

All shared UI primitives live in `app/components/ui/` and are exported from `app/components/ui/index.ts`.

### Complete catalog

| Component | File | Purpose |
|-----------|------|---------|
| `Button` | `Button.tsx` | Action button, 5 variants (`primary`, `secondary`, `danger`, `ghost`, `success`), 2 sizes (`sm`, `md`), loading spinner. |
| `Input` | `Input.tsx` | Text input with label, error state, placeholder. |
| `Select` | `Select.tsx` | Native select with typed options, label, error state. An option can be `disabled`, to display a current value that may not be chosen again. |
| `RemoveButton` | `RemoveButton.tsx` | The `×` that removes an item from a list — one `danger` style everywhere. Whether the removal is immediate or pending goes in `title`, not in the colour. Not for dismissing dialogs — see rule 8. |
| `Modal` | `Modal.tsx` | Overlay modal, Escape-to-close, maxWidth prop, `type="button"` on close. |
| `Toast` | `Toast.tsx` | Lightweight toast notification with auto-dismiss (4s), `success` / `error` variants. |
| `LoadingSpinner` | `LoadingSpinner.tsx` | Inline or fullscreen spinner. |
| `Tabs` | `Tabs.tsx` | Tab navigation bar with optional count badges. |
| `ItemList` / `ListContainer` / `ListItem` / `ListItemSeparator` | `ItemList.tsx` | List primitives for sidebar/panel item lists. |
| `FilterBar` | `FilterBar.tsx` | Horizontal filter button group. |
| `PropertyList` | `PropertyList.tsx` | 2-column grid for label/value pairs. Children rendered as `<Fragment>` — do not wrap in extra `<div>`. |
| `TemplateOption` | `TemplateOption.tsx` | Agent template selection card with avatar, description, optional badge. Centralises create-agent card styling. |
| `Pill` | `Pill.tsx` | Small status/attribute label. Variants: `default`, `accent`. |
| `ModalityIcons` | `ModalityIcons.tsx` | Capability badges parsed from a model's `modality` string (`"text+image->text"`). Input types render as icons; a non-text **output** is called out separately, since reading an image and generating one are different capabilities. Pass `dynamic` for router models, which advertise the union of everything they might route to and so show "varies" instead. |
| `Metric` | `Metric.tsx` | Metric card with title, value, subtitle, tone. |
| `StatusCard` | `StatusCard.tsx` | Health/status report card. |
| `Surface` | `Surface.tsx` | Shared panel/card surface, variant prop. |
| `Page` / `PageHeader` | `Page.tsx` | Full-page layout shell. |
| `Icons` | `Icons.tsx` | SVG icons (`EyeIcon`, `EyeOffIcon`), 16/20px shared. |
| `PasswordInput` | `PasswordInput.tsx` | Password input with inline show/hide toggle (`<button type="button">` with `aria-label`). |
| `UpdateSection` | `app/agents/UpdateSection.tsx` | OPENCLAW VERSION section of the agent detail panel: the version the agent runs, **Update to <version>** when a newer supported version is downloaded (confirm modal, disabled while the agent is stopped), the running update's steps with backup progress, the outcome, and **Roll back to <version>** after an update. Polls `/api/agents/[id]/update` every 2 s while an update or rollback runs; one action at a time (keyed busy state). |
| `BackupSection` | inline in `app/agents/PageClient.tsx` | BACKUP section of the agent detail panel, on the cold backup and the restore. **Backup Now** starts `POST /api/agents/[id]/cold-backup`; while the job runs a banner shows the file and its live percent with **Cancel** (`DELETE /cold-backup`). **Restore** (after a confirm) starts `POST /restore` and a banner shows `Restoring <file>…` (no percent: the extract is a single `tar xzf`, and there is no Cancel). Both sections poll their `GET` every 2 s while running, and on mount pick up a job that is already running — a backup lives in a Docker helper, a restore in `agent_restores`, so reloading the page or navigating away never loses them nor allows a second one (the server answers 409 anyway). Delete per row; all actions disabled while one runs; keyed busy state `{ kind, file }` so only the row in action shows the spinner. On the agent list, an activity Badge (fed by `/api/agents/activity-summary`, polled at 2 s only while something runs, otherwise riding the 15 s list poll) reads `BACKUP nn%`, `RESTORING`, `RECREATING`, `EDITING` or `UPDATING`. |
| `RecreateSection` | inline in `app/agents/PageClient.tsx` | RECREATE section of the agent detail panel. **Recreate Container** starts `POST /api/agents/[id]/recreate` (202) after a confirm; a banner then shows the phase — *Backing up … nn%* while the cold backup runs, *Recreating container…* while the container is rebuilt and the gateway starts. The section polls `GET /recreate` every 2 s, and on mount picks up a recreate that is already running, so a reload or navigation never loses it; it refetches the agent once the job reports `done`. |
| `ImageDownloadBanner` | `app/agents/ImageDownloadBanner.tsx` | Agent image banner on the Agents page. Polls `/api/agents/image-status` every 2 s; offers **Download Image** when no supported version is downloaded, **Download <version>** when the registry publishes a newer one, and shows the download in progress and its completion. Downloading changes no agent. |
| `VersionBanner` | `app/components/VersionBanner.tsx` | "Update available" banner for Rev4a itself, when `GET /api/update-check?check=1` reports a newer published version (dismissable per version, remembered in `localStorage`). **Update now** starts `POST /api/update-check`; because that update restarts the server, the banner cannot be told the outcome by the response: it records what it asked for in `sessionStorage`, polls `/api/update-check` until the installed version moves (two minutes at most) and reloads, then on the next mount either confirms "Updated to vX" or reports that the update did not complete and points at `update.log` (the update's own output). It never reloads blindly onto the same version. |
| `BrowserAccessSection` / `OpenControlUiButton` | `app/agents/BrowserAccessSection.tsx` | Browser access to one agent's Control UI, in its detail panel: requests waiting for approval (Approve / Reject) and approved browsers (Rename / Revoke), refreshed every 5 s while mounted. A successful approve, reject, rename or revoke updates the list at once, since the refresh behind it runs the OpenClaw CLI and takes seconds; a read started before the mutation is discarded. On agents that require approval, "Invite link" fetches `/api/agents/[id]/invite-link` and shows the link in a read-only field with Copy, which uses the Clipboard API in a secure context and the field's selection over plain HTTP, plus a warning when the link uses localhost. `OpenControlUiButton` opens `/api/agents/[id]/open-control-ui` in a new tab inside the click; that route redirects to a one-time link that pairs the browser with no approval, or to the plain token link when none can be issued. Used on the agent cards and in the panel. |
| `ChannelManager` / `ChannelSection` | `app/agents/ChannelManager.tsx`, `ChannelSection` inline in `app/agents/PageClient.tsx` | Telegram, in the agent detail panel (`ChannelSection` is the card that opens the modal; the modal title is the agent's display name). Reads `GET /channels`; lists pending pairing requests with **Approve** (`POST /channels/pairing`) and approved senders with **Revoke** after a confirm (`DELETE /channels/pairing?senderId=`). Pending comes from `openclaw pairing list`, approved from OpenClaw's pairing store (`lib/channelManager.ts`). Polls pairings every 5 s while open; one keyed busy state per action. |
| `EditAgentModal` / `EditBanner` | `app/agents/PageClient.tsx` | Rename/ports editing. The modal has **Display Name** and **Host Port** (same input and validation messages as the create wizard, from `lib/agent-ports.ts`), sends `PATCH /api/agents/[id]` and closes on `202`; `EditBanner` (top of the agent detail) polls `GET /api/agents/[id]` every 2 s while an edit is `rebuilding`, resumes on mount, and refetches the agent once it finishes, so a reload or a navigation shows the running edit instead of allowing a second (the server answers 409). No backup is taken: the volume is untouched. The port range is validated **as it is typed**: the modal fetches `GET /api/agents/ports` when it opens (the same set the create form uses, every container, running or stopped) and excludes the agent's own block, so an occupied range shows the API's message inline and the Save button stays disabled — the create wizard does the same with the same endpoint. |
| `ModelSection` | `app/agents/ModelSection.tsx` | Primary model and fallbacks for one agent, in its detail panel. Explicit save, no restart. The model is a property of the agent, not of the gateway. Tags models the catalogue marks `deprecated`. |
| `ModelsProvider` / `useModels` | `app/lib/models-context.tsx` | The client's single model list, from `/api/models`. Whatever changes what is offered calls `refresh()`: the Gateway page after a toggle, a key save or removal, or a sync, and the first-run wizard after saving keys. Everything else only reads, PulseChat included. |
| `WizardPageClient` + step components | `app/wizard/PageClient.tsx` | Multi-step first-run wizard plus its frame shell, with mobile-first CSS. |
| `useWizard` | `app/wizard/useWizard.ts` | Shared hook: wizard state, step transitions, provider save, restart. Receives server-side initial state to avoid a loading flash. |
| Wizard icons | `app/wizard/icons.tsx` | Shared SVG icons (flyweight pattern): `ArrowRightIcon`, `CheckIcon`, `CheckCircleIcon`, `DockerIcon`, `GatewayIcon`, `AgentIcon`, `TemplateIcon`, `LinkIcon`, `ConfigIcon`, `InformationIcon`. |
| `tokens` | `tokens.ts` | TypeScript types for `Tone` and related token values. |
| `Badge` | `Badge.tsx` | Inline status tag with tone variants (success, danger, warning, neutral). Used for channel chips, pairing labels, error/success messages. |
| `Skeleton` + shape helpers | `app/components/Skeleton.tsx` | Shimmer placeholders. `Skeleton` is the primitive; the rest mirror one specific layout each: `TreeSkeleton`, `CodeSkeleton`, `CronJobsSkeleton`, `CronRunsSkeleton`, `CredentialCardsSkeleton`, `AgentSyncRowsSkeleton`, `SkeletonLines`, `SkeletonMetric`, `CardRowSkeleton`. A shape helper must match the real markup it stands in for — same row structure, same paddings, same element count where the count is known — so nothing reflows when data replaces it. |

### Rules

1. **Prefer existing primitives over new ad-hoc markup.** Every new component starts from the shared catalog.
2. **No inline styles on interactive elements.** Buttons, inputs, selects use the `app/components/ui/*` component with component props. Only layout/wrapping containers use inline style.
3. **No Italian in code, labels, or comments.** UI strings, error messages, aria-labels — all English.
4. **Clickable/custom interactive elements must be `<button type="button">`.** Not `<span onClick>`, not `<div onClick>`. Always include `aria-label` for icon-only buttons.
4a. **A control gated on another field stays visible and disabled** — never conditionally unmounted. Rendering it only once its dependency is filled makes it appear out of nowhere, and any hint that references it is pointing at something not on screen. Show it disabled, with the reason beside it, so the shape of the form is stable from the first render.
5. **Modals inside forms** — close button has `type="button"` to prevent accidental form submission.
6. **Loading buttons** — set `loading={true}` on `Button`, do not render separate loaders next to the button. The spinner is built-in. The label must also change for the duration (`Saving…`, `Deleting…`, `Syncing…`).
6a. **One in-flight mutation, keyed.** Hold a single `busy` string identifying the running action (`delete:<id>`, `sync:<id>:<container>`), plus a `useRef` mirror as the authoritative guard — state is read from the render that produced the click, so two fast clicks would otherwise both pass. `loading` compares against the exact key; `disabled` is set for any busy value, so a control that would be refused looks refused. Never key a mutation on one dimension when the same control is rendered per row of another: a key holding only a container name puts every profile's button for that container into a spinner.
6b. **Do not hold the lock across a slow refresh.** Release it when the mutation itself completes and refresh derived state afterwards, unawaited. Show the pending state by fading the stale values only — never the buttons, since `opacity` on an ancestor cannot be undone by a child and makes live controls read as disabled.
6c. **An optimistic update moves every field the render derives from, together.** A row that decides its state by reading two fields against each other flips to a third, wrong state if the update touches only one of them — and holds it until the slow refresh lands. Update the whole set the derivation reads, or none of it.
7. **New UI component** — add it to `app/components/ui/`, export from `index.ts`, document it here. If it's specific to one page, keep it page-local unless another page needs it.

8. **`×` means remove, `✕` means dismiss.** They look alike and are not the same
    action. Removing an item from a list uses `RemoveButton`; dismissing a dialog
    is the `Modal` component's own close control. Do not build a third variant of
    either, and do not reuse one for the other.

    *Outstanding:* four dialogs predate the shared `Modal` and roll their own close
    control — the edit dialog and the `openclaw.json` dialog in
    `app/agents/PageClient.tsx` (both a `ghost` Button with `✕`), the drawer in
    `app/components/SessionDrawer.tsx` (a bare `<button>`), and
    `app/components/ModelPickerModal.tsx` (`model-picker__close`, which compounds
    the problem by using `×`, the *remove* glyph, to dismiss, and omits
    `type="button"`). The fix is to move them onto `Modal`, not to extract a
    `CloseButton`: they also reimplement Escape-to-close and overlay behaviour.
    `ModelPickerModal` has no importers at all, so deleting it is the cheaper fix
    there.

    Separately, `app/agents/PageClient.tsx` has a raw `×` delete-backup button with
    no accessible name that should be `RemoveButton`.

## GoF pattern mapping

Already used:

- **Observer + Singleton**: `EventBus` owns one SSE stream and fan-outs updates.
- **Factory**: `SessionFactory` / `EventFactory` normalize raw runtime data.
- **Adapter**: `ApiAdapter` converts raw API payloads to domain types.
- **Strategy + Composite**: `FilterStrategy` composes dashboard filtering.

Added UI-side discipline:

- **Factory-ish tone mapping**: `toneFromHealth()` maps domain health into UI tone.
- **Strategy-ish variants**: `Surface` variant/tone classes choose presentation without inline restyling.
- **Composition**: page-specific components compose primitives instead of duplicating card markup.

## Responsive system

Rev4a uses Bootstrap v5 breakpoint categories as project-wide tokens, declared in `app/globals.css`:

- `--bp-sm: 576px`
- `--bp-md: 768px`
- `--bp-lg: 992px`
- `--bp-xl: 1200px`
- `--bp-xxl: 1400px`

Rules:

1. Prefer breakpoint tokens over raw pixel values.
2. New responsive behavior should map to Bootstrap categories (`sm`, `md`, `lg`, ...), not ad-hoc thresholds.
3. When an exception is needed, express it relative to a token and document why.

## Current responsive behaviors

- **Agents page**
  - below `lg` (`< 992px`) switches to stacked/mobile mode
  - shows one section at a time (`AGENTS` → `FILES + CONFIG` → `EDITOR`)
  - avoids split-column clipping on narrow, fold, and small-tablet devices
- **Mobile bottom nav**
  - active below `md`
  - item row centers from `sm` upward within the mobile range
- **PDF preview in Agents**
  - rendered in-page for mobile browsers instead of relying on the native iframe PDF viewer

## Request orchestration rule

For interactive pages that can change view/file/tab quickly:

1. Abort obsolete fetches with `AbortController`.
2. Guard against stale updates after `await` boundaries.
3. On navigation/context switch, kill in-flight requests before starting new ones.
4. Mobile layout changes must not wait on network completion.
5. After a mutation, refresh the cheap endpoint and await it; fire the expensive one without awaiting. A page that re-reads everything makes the user wait on work their change did not need.
6. A refresh helper invoked from a mutation must never reject. The mutation has already succeeded by then, so a failed re-read surfacing as the caller's error reports a completed action as failed.
7. Check `res.ok` before reading the body. An error response is still valid JSON, so `json.items ?? []` silently turns a 401 into an empty result presented as fact.

## Migration rule

For every new/changed page:

1. No new one-off card styles unless justified.
2. Use `app/components/ui/*` primitives first — `Button`, `Input`, `Select`, `Modal`, `Toast`, `Surface`, `Metric`, `StatusCard`, `Pill`, `Page`, `Tabs`, `ItemList`, `FilterBar`, `PropertyList`, `TemplateOption`, `LoadingSpinner`.
3. Async data must render skeleton, not fake zero values.
4. Business logic stays in `lib`/API routes; UI consumes typed payloads.
5. If a pattern is introduced, name it and keep it in `lib/patterns` or `app/components/ui`.
