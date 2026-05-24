# Frontend Architecture Instructions

## General Rules

- Follow these instructions as the default architecture and ruleset.
- If you believe a better solution exists outside this scope, do not implement it directly:
  - Explicitly suggest the alternative
  - Explain why it may be better
  - Wait for approval
- Always briefly explain decisions and trade-offs when generating non-trivial code.
- Prefer clarity, predictability, and maintainability over clever abstractions.

---

## Data Access — Critical Rule

> ⚠️ **The frontend must NEVER query the database directly to fetch client data.**

All client data (clients, documents, interactions, approvals) must be fetched by calling the **Agent Service** (`apps/agent` on `:3001`), not Supabase directly.

```
❌ frontend → Supabase DB (direct query)
✅ frontend → apps/agent → Prisma/Supabase (with tenantId guard)
```

**Why:** The Agent Service enforces multi-tenancy at the repository layer — every query is scoped to the authenticated tenant. Querying Supabase directly from the frontend, even with RLS, bypasses this enforcement layer and makes cross-tenant data leaks possible.

**The only exception:** Supabase Auth (`@supabase/supabase-js`) is allowed in `src/lib/supabase.ts` for session management only — never for data queries.

---

## Component & Architecture Rules

- **One component = one responsibility.**
- Large or slow components must be:
  - Code-split
  - Lazy-loaded
  - Or passed as children to avoid unnecessary re-renders
- Avoid prop-drilling beyond 2 levels → escalate to context or URL state.

---

## Routing

- Use a `pages/` folder for route-level components.
- Always implement:
  - Lazy-loaded routes
  - A `NotFound` fallback page
- Use an `AppLayout` component and follow the AppLayout pattern to avoid duplication.
- Route components must not contain heavy business logic.

---

## Styling

- **Default styling:** Tailwind CSS
- **Component library:** shadcn/ui
  - Install components directly into `src/components/ui/`
  - Never modify shadcn primitives directly — extend them via wrapper components
  - Use shadcn as the base for all forms, dialogs, tables, buttons, and inputs
- If styling complexity becomes hard to manage:
  - Suggest styled-components
  - Explain why
  - Wait for approval before introducing it
- **Do not mix multiple styling paradigms without approval.**

### Tailwind Rules

- Use Tailwind utility classes directly on JSX — no custom CSS files except `globals.css` for base resets and CSS variable overrides
- Design tokens (colors, spacing, radius) are defined in `tailwind.config.ts` — never hardcode hex values or px values in `className` strings
- **Dark mode:** class-based (`class="dark"` on root) — Supabase Auth theme and shadcn both follow this convention
- Responsive breakpoints follow Tailwind defaults (`sm/md/lg/xl`) — **mobile-first always**
- Do not use `@apply` outside of `globals.css`

### shadcn/ui Rules

- All UI primitives come from shadcn/ui unless a component does not exist there
- Custom components live in `src/components/admin/`, `src/components/portal/`, or `src/components/shared/` — **never in `src/components/ui/`** (that folder is shadcn-owned)
- Use shadcn variants (`variant="destructive"`, `variant="outline"`, etc.) — do not override with ad-hoc Tailwind at the call site unless the change is minor
- **Forms always use `react-hook-form` + `zod` + shadcn Form components** — never raw controlled inputs with `useState` for form state

---

## State Management

### State Categories

| Category | Tool |
|---|---|
| Local UI State | `useState`, `useRef`, `useReducer` |
| Local Remote State | `fetch` + `useEffect` (small apps only) |
| Global UI State | URL state, Context API, Redux |
| Global Remote State | React Query |

> **Ask whether the app is small or large before choosing Local vs Global Remote State.**

### URL as State

- Prefer URL / query params for:
  - Filters
  - Pagination
  - Sorting
- The URL should be the canonical source of truth for navigational UI state.

### Context API Rules

- One context per logical state domain.
- Always:
  - Create a dedicated Provider
  - Move state logic to a separate file
  - Expose a custom hook: `useXxxContext()`
- Do not store frequently changing state in context.
- Tenant/business identity in UI must come from a global app context store (for this repo: `apps/web/src/store/app-context.ts`).
- Do not read tenant/business IDs directly from session objects inside pages/components.
- Optimize context only if **all** are true:
  1. App feels laggy
  2. State changes frequently
  3. Context has many consumers

### Redux Rules

Use Redux only when:
- Many unrelated components share state
- Complex orchestration is required
- Middleware / undo / advanced debugging is needed

**Action naming:** `domain/actionDescription`

### React Query Rules

Use React Query for Global Remote State when data is:
- Used in multiple components, **or**
- Accessed across navigations

Redux is **not** for server data unless explicitly approved.

---

## Performance & Memoization

Use `useMemo` / `useCallback` only when justified.

**Valid cases:**
1. Prevent wasted renders (with `React.memo`)
2. Avoid expensive recalculations
3. Stabilize dependencies of other hooks

If used outside these cases:
- Explain why
- Ask for permission before implementing

---

## Effects (Strict)

`useEffect` is a **last resort**.

Before using it, re-evaluate if any of these solve it better:
- A custom hook
- React Query
- Router state

When `useEffect` is used:
- Explain why
- Explicitly point out where it exists in the project

### Dependency Array Rules

- Include all reactive values
- Never ignore ESLint dependency warnings
- Do not place objects or arrays directly in dependencies

To fix dependency issues:
- Move functions into the effect
- Memoize functions if reused
- Depend on primitive values only
- Move static objects outside components
- Use `useReducer` if necessary

---

## Code Splitting

- **All route components must be lazy-loaded.**
- Prefer dynamic imports over monolithic bundles.
- Use `React.lazy()` + `Suspense` for route-based code splitting.

```tsx
// ✅ CORRECT: Lazy-loaded route
const InvoicePage = React.lazy(() => import('./pages/InvoicePage'));

<Suspense fallback={<LoadingSpinner />}>
  <InvoicePage />
</Suspense>
```

---

## Integration Checklist

Before shipping a feature:
- [ ] No business logic in components
- [ ] No prop-drilling beyond 2 levels
- [ ] URL state used for navigational state (filters, pagination, sorting)
- [ ] No `useEffect` where Context / React Query / Router could work
- [ ] Dependencies array is complete and accurate
- [ ] No unnecessary memoization
- [ ] All route components are lazy-loaded
- [ ] Forms use `react-hook-form` + `zod` + shadcn Form
- [ ] No hardcoded hex or px values in Tailwind classes
- [ ] No modifications to `src/components/ui/` (shadcn-owned)
- [ ] Dark mode uses `class="dark"` on root, not media query
- [ ] Mobile-first responsive design
- [ ] Accessibility reviewed (semantic HTML, ARIA labels, keyboard nav)
