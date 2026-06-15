# Development Guidelines

These guidelines define the coding standards and practices for the Swipeer project. Adherence to these rules is mandatory to ensure code quality, stability, and maintainability.

## 1. Error Handling: "Fail Fast & Loud"

We prioritize explicit error handling over silent failures or "graceful degradation" that hides underlying issues.

*   **Do Not Swallow Errors:** Never catch an error just to log it and continue as if nothing happened (unless checking for existence of optional resources).
*   **No Hidden Fallbacks:** Avoid returning empty objects or fake data when a critical configuration fails to load.
*   **Throw Early:** If a function cannot perform its core duty (e.g., loading `default-models.json`), it MUST throw an error immediately.
*   **User Visibility:** Errors that prevent core functionality MUST be visible to the user (e.g., via notifications or error screens), not buried in the console.

**✅ Correct:**
```javascript
if (!response.ok) {
    throw new Error(`Failed to load config: ${response.status}`);
}
return await response.json();
```

**❌ Incorrect:**
```javascript
try {
   // ... fetch config
} catch (e) {
   console.error(e);
   return {}; // BAD: Hides the fact that config is missing!
}
```

## 2. Testing & Quality Assurance

We maintain high confidence in our code through automated testing across multiple layers.

### 2.1 Test Layers & Commands
*   **Unit Tests (`npm run test:unit`):** Fast, isolated tests focusing on business logic (e.g., Parsers, Validators, Calculators). Located in `/tests/`. These run using Jest and JSDOM.
*   **Backend Tests (`npm run test:backend`):** Tests specifically for the standalone update server in `/update-server/`.
*   **Integration & Script Tests (`npm run test:integration`, `npm run test:scripts`):** Verify that multiple components, release scripts, or the database interact correctly.
*   **Full Test Suite (`npm run test`):** Runs both unit and backend tests. **Always run this before submitting changes!** `npm run test:all` is used for full comprehensive checks including bash scripts.

### 2.2 Test-Driven Rules
*   **New Features = New Tests:** Every new core logic component (e.g., a new Manager, Config, or Parser) MUST have accompanying unit tests.
*   **Credit & Business Logic First:** Core business logic (`CreditCalculator`, DB Migrations, License Checks) must be rigorously tested before UI is fully built.
*   **GUI Exceptions:** Pure GUI/rendering code can be exempted from unit tests if testing cost > benefit, BUT should be covered by integration/manual tests where possible.
*   **Property-Based Testing:** For complex data transformations, parsers, or text handling, we utilize `fast-check` (e.g., `*.property.test.js`) to generate extensive edge cases and verify invariants, rather than relying solely on hardcoded examples.

### 2.3 Mocking & Environment
*   **Isolate Electron & Node:** When testing renderer logic, always use Jest mocks for `window.electronAPI` and avoid actual filesystem/Node interactions. Global setup and console error suppression is handled in `tests/setup.js`.
*   **Mock External Services:** Never hit production APIs (like LLM Providers, Supabase, or Hetzner) during unit tests. Use established mocks or dependency injection.

## 3. Database Modifications

Database integrity is paramount. Never assume the schema state. We have a supabase folder with the current functions, cronjobs and triggers. If you need to adjust those functions, update the files in the supabase folder first.

*   **Inspect First:** Before planning ANY migration or DB change, you MUST inspect the current schema and run a backup.
Prefered way: USE MCP for supabase. 

If MCP is not working, use following command: 
    *   Command: `npm run inspect:database`
*   **Verify Plan:** Base your migration scripts on the *actual* inspected state, not on memory or outdated docs.
*   **Safe Migrations:** Use transactions where possible and verify migrations locally (`npm run dev:db`) before deploying.

## 4. Code Hygiene

*   **No Dead Code:** Delete commented-out code, unused functions, or deprecated logic immediately. Do not leave "just in case" blocks (e.g., support for removed APIs like OpenAI direct).
*   **Clear Dependencies:** Avoid hidden dependencies. Structure code so dependencies are explicit (passed in constructor/arguments).

## 5. Security & API Safety

We maintain a "Secure by Default" posture for all external and internal interfaces.

*   **Secure by Default:** Every API endpoint MUST require authentication/authorization unless there is a documented reason for it to be public.
*   **No Sensitive Exposure:** Error messages and public responses must not leak system internals (e.g., database versions, full file paths, internal IP addresses).
*   **Endpoint Hijacking Prevention:** Validate all inputs on the server/backend side, regardless of client-side checks.

### 5.1 Health Checks

Health checks (e.g., `/health`, `/status`) are critical for infrastructure but can be a vector for information leakage.

*   **Public Access:** Health checks are allowed to be unauthenticated if required by infrastructure (e.g., Kubernetes, Load Balancers).
*   **Minimal Payload:** Unauthenticated health checks MUST return a simple status (e.g., `{"status": "ok"}`). They MUST NOT return detailed component health (e.g., "Database connected", "Redis 6.2 reachable") to unauthenticated users.
*   **Resource Usage:** Health check logic must be lightweight. Avoid triggering heavy database queries or disk I/O in a status endpoint that can be called frequently.

### 5.2 Supabase Security & RLS Patterns

When integrating with Supabase (or PostgreSQL), specifically when using custom authentication methods (like License Keys) rather than built-in Supabase Auth, follow these security patterns:

*   **Avoid Direct RLS Exposure:** Do NOT open direct `SELECT` access to sensitive tables like `users` or `device_activations` to the `anon` or `authenticated` roles, even with complex RLS policies.
*   **Prefer Secure RPCs:** Instead of direct table access (`supabase.from('table').select()`), implement server-side PostgreSQL functions (RPCs) with the `SECURITY DEFINER` flag.
*   **Validate Within RPC:** The RPC must explicitly validate identity (e.g., checking the provided `p_license_key`) before querying internal tables.
*   **Encapsulation:** Only return the specific columns required for the frontend.

**Example Pattern:**
```sql
-- Create a secure wrapper function
CREATE OR REPLACE FUNCTION public.get_user_data(p_license_key text)
RETURNS TABLE (column1 text, column2 integer)
LANGUAGE plpgsql
SECURITY DEFINER -- Runs with elevated permissions, bypassing direct table RLS
SET search_path TO 'public'
AS $$
BEGIN
    RETURN QUERY
    SELECT t.col1, t.col2
    FROM internal_table t
    JOIN licenses l ON t.user_id = l.user_id
    WHERE l.license_key = p_license_key; -- Strict validation
END;
$$;
```

## 6. LLM Request Routing Architecture

When working on LLM-related features (e.g. streaming, tool calling, timeouts, error handling), it is critical to understand that **two fundamentally different code paths** exist depending on how the user authenticates:

### 6.1 The Two Paths

**Path A — BYOK (Bring Your Own Key):**
The user has entered their own OpenRouter API key. Requests go **directly** from the renderer to `openrouter.ai` using `OpenRouterProvider`.

```
LLMManager.sendMessageWithCredits()
  └── selectProviderForRequest() → reason: 'own_api_key'
  └── executeWithToolCallLoop(messages, OpenRouterProvider, ...)
        └── sendNonStreamingForToolDetection()
              └── fetch() directly to openrouter.ai   ← Timeout: AbortSignal.timeout(90s)
        └── callTool() via IPC (MCPClientManager)      ← Timeout: Promise.race 60s
```

**Path B — Credit System (Backend):**
The user uses Swipeer credits. Requests are routed **through the Vercel backend** (`/api/secure-chat`) which holds the system API key. A fake `backendProvider` object is used as a shim.

```
LLMManager.sendMessageWithCredits()
  └── selectProviderForRequest() → reason: 'backend_keys_with_credits'
  └── executeWithToolCallLoop(messages, backendProvider, ...)
        └── sendNonStreamingForToolDetection()
              └── provider.isBackend === true
                    └── sendMessageThroughBackend()    ← Timeout: AbortSignal.timeout(90s/120s)
        └── callTool() via IPC (MCPClientManager)      ← Timeout: Promise.race 60s
```

### 6.2 Shared Components

Both paths converge on these shared functions:
- **`executeWithToolCallLoop()`** — MCP tool-call loop (max 5 rounds), used by both paths
- **`MCPClientManager.callTool()`** — executed in the main process via IPC, shared by both paths

### 6.3 Rules for Changes in This Area

*   **Never assume one path:** Any fix or feature touching streaming, tool calling, timeouts, or error handling MUST be verified in **both** Path A and Path B.
*   **Timeouts are mandatory:** Every `fetch()` to an external API MUST have an `AbortSignal.timeout()`. The backend path (`sendMessageThroughBackend`) and the direct path (`sendNonStreamingForToolDetection`) each have their own fetch calls — both need timeouts.
*   **No silent empty responses:** `onComplete('')` must never be called with an empty string. An empty LLM response is an error state — use `onError()` (Fail Fast, see Section 1).
*   **MCP `callTool` timeouts:** Wrap IPC calls to `mcpApi.callTool()` in a `Promise.race()` with a timeout (currently 60s) to prevent the chat UI from hanging at `_Calling tool..._`.
*   **`backendProvider` is a shim, not a real provider:** The `backendProvider` object in Path B exists solely to satisfy `executeWithToolCallLoop`'s interface. It delegates to `sendMessageThroughBackend()`. Do not add business logic to it directly.

## 7. AI-Ready Development

To facilitate development with AI agents (like Antigravity) and ensure future-proof code, we follow these practices:

*   **Contextual Documentation (JSDoc):** Use JSDoc for all public functions and classes. Focus on the *intent* ("Why does this exist?") and *constraints* ("What can go wrong?"), as AI can usually infer the "how" from the code.
*   **Modular & Atomic Logic:** Prefer small, single-purpose functions. AI reasoning performance significantly improves when dealing with atomic "pure" functions rather than monolithic methods.
*   **Explicit Schemas & Constants:** Avoid "magical" strings or dynamic objects. Define constants or clear schema objects (even if just in comments/JSDoc) so AI can accurately map data structures.
*   **Consistency is Key:** Stick to established patterns (like Section 1's "Fail Fast" rule). Consistent code allows AI to better predict the correct implementation style and reduces hallucinations.
