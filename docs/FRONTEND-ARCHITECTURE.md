# Rev4a Frontend Architecture

> **Last updated:** 2026-07-19

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
| `Select` | `Select.tsx` | Native select with typed options, label, error state. |
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
| `OnboardingPageClient` + step components | `app/onboarding/PageClient.tsx` | 4-step wizard (`WelcomeStep`, `ProvidersStep`, `AgentsStep`, `DoneStep`) + `WizardFrame` shell with mobile-first CSS. |
| `useOnboarding` | `app/onboarding/useOnboarding.ts` | Shared hook: onboarding state, step transitions, provider save, restart. Receives server-side initial state to avoid loading flash. |
| `OnboardingIcons` | `app/onboarding/icons.tsx` | Shared SVG icons (flyweight pattern): `ArrowRightIcon`, `CheckIcon`, `DockerIcon`, `GatewayIcon`, etc. |
| `tokens` | `tokens.ts` | TypeScript types for `Tone` and related token values. |
| `Badge` | `Badge.tsx` | Inline status tag with tone variants (success, danger, warning, neutral). Used for channel chips, pairing labels, error/success messages. |

### Rules

1. **Prefer existing primitives over new ad-hoc markup.** Every new component starts from the shared catalog.
2. **No inline styles on interactive elements.** Buttons, inputs, selects use the `app/components/ui/*` component with component props. Only layout/wrapping containers use inline style.
3. **No Italian in code, labels, or comments.** UI strings, error messages, aria-labels — all English.
4. **Clickable/custom interactive elements must be `<button type="button">`.** Not `<span onClick>`, not `<div onClick>`. Always include `aria-label` for icon-only buttons.
5. **Modals inside forms** — close button has `type="button"` to prevent accidental form submission.
6. **Loading buttons** — set `loading={true}` on `Button`, do not render separate loaders next to the button. The spinner is built-in.
7. **New UI component** — add it to `app/components/ui/`, export from `index.ts`, document it here. If it's specific to one page, keep it page-local unless another page needs it.

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

## Migration rule

For every new/changed page:

1. No new one-off card styles unless justified.
2. Use `app/components/ui/*` primitives first — `Button`, `Input`, `Select`, `Modal`, `Toast`, `Surface`, `Metric`, `StatusCard`, `Pill`, `Page`, `Tabs`, `ItemList`, `FilterBar`, `PropertyList`, `TemplateOption`, `LoadingSpinner`.
3. Async data must render skeleton, not fake zero values.
4. Business logic stays in `lib`/API routes; UI consumes typed payloads.
5. If a pattern is introduced, name it and keep it in `lib/patterns` or `app/components/ui`.
