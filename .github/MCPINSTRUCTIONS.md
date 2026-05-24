# MCP Architecture & Collaboration Instructions

## Collaboration Preferences (Jovan)

- When a prompt ends with a question mark, answer only and do not perform actions.
- Before a larger single code update, provide a brief implementation plan first.
- Do not start code changes with missing context.
- When making code changes, include comments describing the changes.
- Follow these instructions as the default architecture and ruleset.
- **If you believe a better solution exists outside this scope:** explicitly suggest the alternative, explain why it may be better, and wait for approval before implementing.
- Always briefly explain decisions and trade-offs when generating non-trivial code.
- Prefer clarity, predictability, and maintainability over clever abstractions.

---

## MCP Architecture Boundaries (Mandatory)

1. **Do not keep MCP protocol logic inside React components or hooks**
   - Components/hooks may only consume UI-ready state and callbacks.
   - Protocol handlers, client lifecycle, request routing must live in orchestration modules.

2. **Do not treat MCP client as a UI concern**
   - Instantiate and manage MCP clients in orchestration code (e.g., `src/connection/` or `src/services/`).
   - UI must not own transport setup, handler registration, or protocol lifecycle.

3. **Do not treat server-declared prompts as server-executed logic**
   - Prompt declarations are metadata/templates.
   - Host application composes messages and sends them to the LLM.
   - Server prompt registration does not execute the prompt by itself.

4. **Keep responsibility split explicit**
   - **Server:** declares tools/resources/prompts and business capabilities.
   - **Host/client orchestration:** resolves prompt templates + runtime context, applies safety policy.
   - **React UI:** presents state, captures user input, renders approval/elicitation UX.

---

## Host-Driven Agent Architecture (Mandatory)

### Rule 1 — The Host Owns Intelligence
- **Host owns:** LLM calls, tool-use decisions, orchestration, memory.
- **Server owns:** capability exposure and deterministic execution.
- The server does not "think" and must not contain agent reasoning behavior.

### Rule 2 — Never Mix UI and Orchestration
- UI components must NOT call MCP directly, run tool loops, or inject prompts.
- UI renders state and emits intents; agent/orchestrator performs reasoning.

### Rule 3 — One Directional Dependencies Only
```
UI → Agent → LLM + MCP → Transport
```
Never invert this dependency direction.

### Rule 4 — Servers Must Be Model-Agnostic
- Switching LLM providers (GPT ↔ Claude) must not require server changes.
- Server code must not depend on model vendor, model name, or provider SDK behavior.

### Rule 5 — Agent Controls the Loop
- Only one module is allowed to interpret tool calls, call tools, re-prompt the LLM, and stop infinite loops.
- That module is `agentLoop.ts` (or a single equivalent orchestrator entrypoint).
- Never place loop control in React, MCP transport modules, or generic utilities.

### Rule 6 — Transport Is Dumb
- MCP client responsibilities: send JSON-RPC requests, return responses.
- LLM client responsibilities: send provider requests, return responses.
- Transport modules must not contain business rules or orchestration logic.

### Rule 7 — Prompt Templates Are Metadata
- Server prompts are templates discovered via handshake/registry.
- Host injects prompt content into LLM context at runtime.
- Prompts do not execute by themselves on the server.

### Rule 8 — Design for Swap-ability and Headless Execution
Every architecture decision must pass these checks:
- Can we swap the UI layer without rewriting orchestration?
- Can we swap LLM providers without server changes?
- Can we add a second MCP server without rewriting UI?
- Can the agent run headless (without React)?

If any answer is **No**, boundaries must be refactored before feature completion.

---

## Transport & SDK Standards

- **Use MCP Streamable HTTP transport** as the project standard.
- **Environment value:** `MCP_TRANSPORT=http`.
- **Client transport:** `StreamableHTTPClientTransport`.
- **Always use:** the official `@modelcontextprotocol/sdk` from npm.
- Client-side initialization must include capabilities for:
  - `sampling` - LLM message creation and sampling
  - `roots` - File system resource exposure

---

## Sampling (LLM Calls) - Security Requirement

**All `sampling/createMessage` requests to the LLM must include a Human-in-the-loop check before execution:**
- Present a confirmation modal in the UI
- Show the user what the agent intends to do
- Require explicit user approval before invoking LLM calls
- Log all sampling requests for audit purposes
- Consider including a `tools` array inside the sampling request so custom tools can be used by the LLM during message generation

---

## Roots (File System Access) - Security Requirement

**Restrict file system exposure:**
- **Only expose directories:** `./user-data` and `./workouts` to the server
- **Never expose:** Root system directories, sensitive folders (`.git`, `node_modules`, `.env`), parent directories
- Configure roots in `mcpClient.ts` during initialization

---

## MCP Implementation Guardrails

### 1. Capability Handshake
- Always initialize the `McpClient` with explicit capabilities.
- Ensure `sampling: {}` and `roots: {}` are present in the initialization object.

### 2. Async Request Handling & Type Casting
- Use `AbortController` or `setTimeout` to prevent indefinite blocking (60-second timeout).
- **Type Casting Requirement:** Client must ensure data returned in accept response matches the type defined in `requestedSchema`.
  - Convert string inputs to numbers or booleans as required
  - Validate array/object structures before returning
  - Never return raw form data—transform it to match schema types

### 3. Filesystem Security (Roots)
- Use strict whitelisting for directory access.
- Only provide paths related to `./workout-logs` or `./user-profiles`.

### 4. Prompt Engineering (Context Mixing)
- Always wrap server-provided `systemPrompt` with local safety constraints.
- Prepend or append specific app rules to prevent context mixing/injection.

---

## System Instructions Registration

**Helper Function Signature:**
```typescript
function registerSystemInstructions(server: McpServer, instructions: string): void
```

- Registers an MCP prompt with name `system-instructions`
- Sets metadata flag `isSystem: true` so clients can auto-load it as base system message
- Keep system prompts consistent across servers
- Makes it easy for clients to detect and auto-load the authoritative system message

**Client-Side Enforcement:**
- Fetch system instructions from server at app startup
- Prepend system message to every LLM sampling call at position 0 (highest priority)
- This ensures consistent enforcement across all sampling requests

---

## Elicitation Pattern (Schema-Driven UI)

**Principle:** Server defines what data is needed via `requestedSchema` (JSON Schema), client dynamically generates UI components to collect that data.

**Benefits:**
- Frontend doesn't need hardcoded forms for specific tools
- Server controls data structure requirements
- Easy to iterate tool inputs without frontend changes

**Requirements:**
1. **Visibility:** All elicitation events must be visible to the user
2. **Context Preservation:** Include clear `message` field explaining why data is needed
3. **Decline & Cancel Handling:** Users must be able to cancel and decline to provide data

**Global Listener Pattern:**
- Initialize request handlers for both `elicitation/create` and `sampling/createMessage` in a dedicated orchestration module
- This keeps protocol responsibilities outside React while keeping handlers globally active

---

## Client Architecture Structure

```
client/
├── src/
│   ├── ui/                    # React components (UI only)
│   ├── core/
│   │   ├── llm/               # LLM interaction / prompt construction
│   │   ├── mcp/
│   │   │   ├── client.ts      # MCP client setup
│   │   │   └── registry.ts    # Client-side discovery
│   │   └── agent/             # Agent planning/execution loops
│   ├── state/                 # App & conversation state
│   └── config/                # Config and constants
```

---

## Core Component Rules

**DO:**
- One component per file
- Props clearly typed via interfaces
- Separated concerns (UI vs logic)
- Reusable and composable

**DON'T:**
- Mix business logic with UI
- Perform calculations in components
- Store business state locally
- Make direct API calls from components
- Prop-drill beyond 2 levels (use Context API, URL state, or state management)

---

## State Management Boundary

Only these cross from MCP to UI:
- User messages and action intents
- Current view identifiers
- Selected IDs
- Lightweight UI hints

**DO NOT store in UI:**
- Business calculations
- Derived metrics
- Authorization logic
- Business rules

---

## Common Pitfalls & Guardrails

### Type Casting (CRITICAL)
**Requirement:** Helper functions must validate and cast types before returning data to tools.

```typescript
// WRONG: Returning form data as-is (all strings)
const formData = { weight: "85", isInjured: "true" };
return formData; // Tool receives strings, expects number/boolean

// RIGHT: Casting before return
const casted = {
  weight: Number(formData.weight),        // Now: 85 (number)
  isInjured: formData.isInjured === 'true', // Now: true (boolean)
};
return casted;
```

### Error Handling & Cancellation
```typescript
// Cancellation Signal Class
export class OperationCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationCancelledError';
  }
}

// In tool, catch and handle gracefully
async function handleTool(args, ctx) {
  try {
    const clean = await ensureParams(ctx, args, requirements);
  } catch (error) {
    if (error instanceof OperationCancelledError) {
      return { error: error.message, isError: true }; // Graceful return
    }
  }
}
```

### No Hardcoding
- Ensure prompts and schemas are passed as variables to helpers
- Keep helpers purely functional and project-agnostic

---

## Integration Checklist

Before shipping a feature:
- [ ] No business logic in components
- [ ] All server calls go through `mcpClient.ts`
- [ ] Types match server definitions
- [ ] Error states handled
- [ ] Loading states implemented
- [ ] Accessibility reviewed
- [ ] Mobile responsive
- [ ] Routes are lazy-loaded
- [ ] Prop drilling does not exceed 2 levels
- [ ] URL state used for navigational state
- [ ] No useEffect where Context/Query/Router could work
- [ ] Dependencies array is complete and accurate
- [ ] Styling uses Tailwind (or approved alternative)

---

## Styling & Performance

- **Default:** Tailwind CSS
- **Lazy load routes** and code split by feature
- Use `useMemo`/`useCallback` only when justified (prevent wasted renders, avoid expensive recalculations, stabilize dependencies)
- Memoize expensive components with `React.memo`
- Debounce/throttle event handlers

---

## Accessibility Requirements

- Semantic HTML
- Keyboard navigation support
- ARIA labels where needed
- Color contrast compliance
- Screen reader testing
