# Rev4a Frontend Architecture

> **Last updated:** 2026-09-14

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
