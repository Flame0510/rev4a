# Olympus Design System

Source of truth: `app/design-system.ts` + CSS tokens in `app/globals.css`.

> **Last updated:** 2026-07-03

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

Olympus uses a **square/sharp** visual language:
- Buttons, inputs, modals, cards — **0 border-radius by default** (no rounding).
- `Pill` uses inline rounded shapes where appropriate (status badges).
- No shadows, no gradients (except the login page background).

### Color tokens

Defined in `app/globals.css` as CSS custom properties:

```css
--bg:           #0a0a0a      /* Page background */
--bg2:          #111         /* Slightly lighter surface */
--border:       #222         /* Default border */
--text:         #e0e0e0      /* Primary text */
--text-dim:     #888         /* Muted/secondary text */
--copper:       #d49b35      /* Brand accent */
--copper-bg:    #1a1208     /* Copper-tinted hover/active background */
--green:        #22c55e      /* Success */
--red:          #ef4444      /* Error */
--yellow:       #eab308      /* Warning */
--blue:         #60a5fa      /* Info / links */
```

### Typography

- Monospace by default: `var(--font-mono-stack)`
- Serif (logotype): `var(--font-serif-stack)`
- UI buttons use `monospace` via CSS class or inline `fontFamily`
- No variable fonts — system monospace stack for consistency

## Component design rules

1. **Border radius: 0 everywhere.** `border-radius: 0` or sharp corners. Exceptions: `Pill`, avatar circles, status dots.
2. **No shadows.** Flat design. Use `border: 1px solid var(--border)` to define surfaces.
3. **Copper is the only accent.** `var(--copper)` for active states, primary actions, headings. `var(--copper-bg)` for hover/active backgrounds.
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
| Providers | `md` (768px) | Tab navigation: providers / details |
| Dashboard | `md` (768px) | Mobile header nav |
| Lineage | `md` (768px) | Mobile tab: graph / feed |
| SessionDrawer | `md` (768px) | Full-width drawer / compact |
