# Rev4a Design System

Source of truth: `app/design-system.ts` + CSS tokens in `app/globals.css`.

> **Last updated:** 2026-09-26

---

## Responsive breakpoints

Centralized in `app/design-system.ts` as `Breakpoint` object and exposed via the `useResponsive(key)` hook.

| Token | Value | Used by |
|-------|-------|---------|
| `Breakpoint.sm` | 576px | Mobile bottom nav centering |
| `Breakpoint.md` | 768px | Dashboard, Lineage, SessionDrawer, Providers |
| `Breakpoint.lg` | 992px | Agents (dense/fold devices), Crons, Plugins/Skills |
| `Breakpoint.xl` | 1200px | Reserved |
| `Breakpoint.xxl` | 1400px | Reserved |

### CSS tokens (globals.css)

```css
--bp-sm: 576px;
--bp-md: 768px;
--bp-lg: 992px;
--bp-xl: 1200px;
--bp-xxl: 1400px;
```

Use the CSS custom property in `@media` queries, not raw pixel values.

## Visual language

### Shape

Rev4a uses a **square/sharp** visual language:
- Buttons, inputs, modals, cards — **0 border-radius by default** (no rounding).
- `Pill` uses inline rounded shapes where appropriate (status badges).
- No shadows, no gradients (except the login page background).

### Color tokens

Defined in `app/globals.css` as CSS custom properties:

```css
--bg:         var(--color-bg-950)       /* #0A0A0B  Page background */
--bg2:        var(--color-bg-900)       /* #111114  Slightly lighter surface */
--border:     var(--color-border-700)   /* #222228  Default border */
--text:       var(--color-text-100)     /* #E8E8E8  Primary text */
--text-dim:   var(--color-text-400)     /* #888     Muted/secondary text */
--violet:     var(--color-accent-500)   /* #925BFC  Brand accent */
--violet-bg:  rgba(146, 91, 252, 0.08)  /* Violet-tinted hover/active background */
--green:      var(--color-success-500)  /* #22c55e  Success */
--red:        var(--color-danger-500)   /* #ef4444  Error */
--yellow:     var(--color-warning-500)  /* #f59e0b  Warning */
--blue:       var(--color-blue-400)     /* #60a5fa  Info / links */
```

The semantic tokens above point at the palette tokens (`--color-*`) defined at the top of
`app/globals.css`; the hex values are the palette's, quoted for reference.

### Typography

- Monospace by default: `var(--font-mono-stack)`
- Serif (logotype): `var(--font-serif-stack)`
- UI buttons use `monospace` via CSS class or inline `fontFamily`
- No variable fonts — system monospace stack for consistency

## Component design rules

A shared component grows by **variant, never by copy**. `Metric` is the example: `size="sm"`
is the compact form for a grid inside a dialog (smaller value, tighter spacing), and it lives
on the primitive so the modal and the dashboard cannot drift apart. When a new page needs a
pattern that does not exist yet, add it here and to `docs/FRONTEND-ARCHITECTURE.md`'s catalog,
then use it — a one-off copy of markup is the thing this section exists to prevent.

1. **Border radius: 0 everywhere.** `border-radius: 0` or sharp corners. Exceptions: `Pill`, avatar circles, status dots.
2. **No shadows.** Flat design. Use `border: 1px solid var(--border)` to define surfaces.
3. **Violet is the only accent.** `var(--violet)` for active states, primary actions, headings. `var(--violet-bg)` for hover/active backgrounds.
4. **Mono font on buttons and inputs.** All interactive text uses `var(--font-mono-stack)`.
5. **CSS vars over hardcoded colors.** Never inline `#22c55e`, `#ef4444`, `#888` — use the CSS token.
6. **Loading feedback.** Use `loading` prop on `Button` (shows inline spinner). Do not render separate loader elements.
7. **Minimal animation.** Transitions on hover/active (0.1s–0.12s), spin on loading spinner. No bounce, shake, or decorative animations.

### React hook

```ts
import { useResponsive, Breakpoint } from '../design-system';

const isNarrow = useResponsive('md');  // true when ≤767px
const isFoldable = useResponsive('lg'); // true when ≤991px
```

The hook uses `matchMedia` (passive, zero-CPU) and returns `boolean`.

---

## Current page behaviors

| Page | Breakpoint | Behaviour when active |
|------|-----------|----------------------|
| Agents | `lg` (992px) | Single-column stacked: AGENTS → FILES+CONFIG → EDITOR |
| Crons | `lg` (992px) | Tab navigation: jobs / runs |
| Plugins/Skills | `lg` (992px) | Sidebar → Detail step |
| Dashboard | `md` (768px) | Mobile header nav |
| Lineage | `md` (768px) | Mobile tab: graph / feed |
| SessionDrawer | `md` (768px) | Full-width drawer / compact |
