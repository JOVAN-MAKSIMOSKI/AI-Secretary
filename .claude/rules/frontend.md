# Frontend Rules — apps/web

Applies when Claude touches any file under `apps/web/**`.

---

## Data Access — Critical Rule

The frontend must **never** query the database directly for client data.

```
❌ frontend → Supabase DB (direct query)
✅ frontend → apps/agent → Prisma/Supabase (with tenantId guard)
```

All client data (clients, documents, interactions, approvals) must be fetched by calling `apps/agent` on `:3001`.

**The only exception:** `@supabase/supabase-js` in `src/lib/supabase.ts` for session management only — never for data queries.

Tenant/business identity in UI must come from `apps/web/src/store/app-context.ts` — do not read tenant or business IDs directly from session objects inside pages or components.

---

## Component Rules

- One component = one responsibility
- No business logic in components — logic lives in hooks or services
- No direct API calls from components
- No prop-drilling beyond 2 levels → escalate to context or URL state
- Large or slow components must be code-split or lazy-loaded

---

## Routing

- Use a `pages/` folder for route-level components
- All route components must be lazy-loaded with `React.lazy()` + `Suspense`
- Implement a `NotFound` fallback page
- Use an `AppLayout` component to avoid layout duplication
- Route components must not contain heavy business logic

```tsx
const InvoicePage = React.lazy(() => import('./pages/InvoicePage'));

<Suspense fallback={<LoadingSpinner />}>
  <InvoicePage />
</Suspense>
```

---

## Styling

- **Default:** Tailwind CSS — utility classes directly on JSX
- **Component library:** shadcn/ui
- No custom CSS files except `globals.css` for base resets and CSS variable overrides
- Design tokens (colors, spacing, radius) are defined in `tailwind.config.ts` — never hardcode hex or px values in `className` strings
- Dark mode: class-based (`class="dark"` on root) — not media query
- Responsive: mobile-first always (`sm/md/lg/xl`)
- Do not use `@apply` outside of `globals.css`
- Do not mix multiple styling paradigms without approval

### shadcn/ui Rules

- All UI primitives come from shadcn/ui unless a component does not exist there
- Custom components live in `src/components/admin/`, `src/components/portal/`, or `src/components/shared/`
- Never modify files inside `src/components/ui/` — that folder is shadcn-owned
- Use shadcn variants — do not override with ad-hoc Tailwind at the call site unless the change is minor
- Forms always use `react-hook-form` + `zod` + shadcn Form components — never raw controlled inputs with `useState`

---

## State Management

| Category | Tool |
|---|---|
| Local UI State | `useState`, `useRef`, `useReducer` |
| Global UI State | URL state, Context API |
| Global Remote State | React Query |
| Complex orchestration | Redux (only when justified) |

- Prefer URL / query params for filters, pagination, and sorting — URL is the canonical source of truth for navigational state
- One context per logical state domain; always expose a custom hook (`useXxxContext()`)
- Do not store frequently changing state in context
- Redux only when: many unrelated components share state, complex orchestration, or middleware/undo is needed

---

## Effects (Strict)

`useEffect` is a last resort. Before using it, evaluate:
- Custom hook
- React Query
- Router state

When `useEffect` is used:
- Explain why in a comment
- Include all reactive values in the dependency array
- Never ignore ESLint dependency warnings
- Do not place objects or arrays directly in dependencies

---

## Performance

Use `useMemo` / `useCallback` only when:
1. Preventing wasted renders (with `React.memo`)
2. Avoiding expensive recalculations
3. Stabilizing dependencies of other hooks

---

## MCP Boundary (applies to frontend)

- Never keep MCP protocol logic inside React components or hooks
- Never call MCP tools directly from React
- UI renders state and emits intents; the agent/orchestrator performs reasoning

---

## Actual Frontend Structure

### Pages

| Path | File | Purpose |
|---|---|---|
| `/login` | `pages/auth/Login.tsx` | Supabase Auth login |
| `/callback` | `pages/auth/Callback.tsx` | OAuth callback handler |
| `/signup` | `pages/auth/SignUp.tsx` | Registration |
| `/admin/dashboard` | `pages/admin/Dashboard.tsx` | Admin overview (stub) |
| `/admin/tenants` | `pages/admin/Tenants.tsx` | Tenant management |
| `/admin/templates` | `pages/admin/Templates.tsx` | Invoice/offer template management |
| `/admin/audit-logs` | `pages/admin/AuditLogs.tsx` | Audit log viewer |
| `/portal/dashboard` | `pages/portal/Dashboard.tsx` | Main chat interface for generating docs |
| `/portal/documents` | `pages/portal/Documents.tsx` | List invoices/offers |
| `/portal/approvals` | `pages/portal/Approvals.tsx` | Human approval gate UI |
| `/portal/clients` | `pages/portal/Clients.tsx` | Client list and management |
| `/portal/calendar` | `pages/portal/Calendar.tsx` | Google Calendar integration |
| `/portal/law` | `pages/portal/LawQuestions.tsx` | RAG-based law Q&A |
| `/portal/settings` | `pages/portal/Settings.tsx` | User/tenant settings |

### Key Hooks

- `hooks/useSession.ts` — reads `user` + `tenantId` from Supabase session. Use this, not raw Supabase session in components.
- `hooks/useAgent.ts` — Axios calls to agent service (`POST /agent/resolve-and-run`, `POST /documents/extract*`, etc.). All agent communication goes through this hook.
- `hooks/useApprovals.ts` — Supabase Realtime subscription for live approval updates on the `Approvals` page.

### State

- `store/session.ts` — Zustand store holding `user`, `tenantId`, `role`, `permissions`. This is the canonical source for tenant identity in the UI — never read it directly from a Supabase session object inside a component or page.
- `store/app-context.ts` — App-level context (theme, notifications).

### Routing Guards

- `router/guards.tsx` exports `AdminGuard` and `PortalGuard` — wrap route elements with these, do not add role-checking logic inside pages.

### Axios

- `lib/axios.ts` — Axios instance pointed at the agent service. Import and use this; never create ad-hoc `axios` instances in components. The instance is pre-configured with the base URL and auth token injection.

### Realtime

- `connection/supabase-client.ts` — Supabase browser client for Auth + Realtime. Import from here, not from `lib/supabase.ts`.

---

## Integration Checklist

Before shipping a feature:
- [ ] No business logic in components
- [ ] No prop-drilling beyond 2 levels
- [ ] URL state used for navigational state (filters, pagination, sorting)
- [ ] No `useEffect` where Context / React Query / Router could work
- [ ] Dependency array is complete and accurate
- [ ] No unnecessary memoization
- [ ] All route components are lazy-loaded
- [ ] Forms use `react-hook-form` + `zod` + shadcn Form
- [ ] No hardcoded hex or px values in Tailwind classes
- [ ] `src/components/ui/` is not modified
- [ ] Dark mode uses `class="dark"` on root
- [ ] Mobile-first responsive design
- [ ] Semantic HTML, ARIA labels, keyboard navigation
