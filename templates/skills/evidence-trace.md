---
id: evidence-trace
name: Evidence-trace review
summary: Trace definitions/call chains and in-repo APIs to judge this change; traced code is context only, not a new review target
modes: [diff, batch, segment]
match: []
priority: 30
---

# Evidence-trace review (required)

Purpose of tracing: **judge this change accurately**.
When a call, type, config, import, or **HTTP/API call** in this change cannot be judged from the snippet alone, you must use tools.

## What tracing is / is not

**Is**: reading callee definitions, param contracts, auth/validation to decide whether **this new call / new args / new branch** is wrong.
**Is not**: treating traced legacy code as a new review target and reporting historical issues there.

Incorrect: this change only adds one arg to `login()`; tracing finds an old log line in `validateUser` → **do not** report that log.
Correct: this change passes a frontend `userId` into `login()`; tracing shows `validateUser` skips tenant checks → **do** report that this change newly exposes an unchecked path.

## When you must trace (not limited to security dirs)

Trace whenever accuracy needs any of:

- New/changed function or method calls
- Newly imported symbols, types, constants, config keys
- Whether error handling covers failures the callee may throw
- Whether this change makes an old path reachable with new input
- **In-repo API**: client request path/params; or backend signature impact on callers

Applies to helpers, data processing, UI events, SQL wrappers, and route handlers — not only auth/security.

## Available tools (multiple TOOL_CALL in one reply is OK)

| Tool | Use |
|------|-----|
| `read_file` / `read_around` | Read a file or lines around a line |
| `list_files` | List files to locate modules |
| `search_in_file` / `search_in_repo` | Keyword search (including route paths) |
| `get_file_outline` | File structure (functions/classes) |
| `resolve_import` | Auto-resolves imports via tsconfig/Vite `@`/`~`/`#` aliases, pnpm/npm workspaces, go.mod/composer, and follows barrel `export … from` up to 2 hops; falls back to `search_in_repo` |
| `find_references` | Definitions / calls / all refs; pass `fromPath` to rank same-file/same-dir matches above homonyms |
| `trace_callers` | Who calls this symbol |
| `read_symbol_context` | Code around a definition |
| `get_file_diff` / `get_staged_diff` / `list_changed_files` | Confirm what changed |

Suggested order:

- Symbols: `resolve_import` → `read_symbol_context` / `read_around` → `trace_callers` if needed
- **Workspace packages** (`@scope/pkg`, shared libs): `resolve_import` first; if empty, `search_in_repo` by package folder or export name
- **Barrel/index files**: `resolve_import` may return the underlying source after re-export hops — read that file, not only the barrel
- **`import type`**: still trace the type definition; erased imports can hide contract mismatches
- **Generated code** (pb/grpc/OpenAPI stubs): review how this change uses generated symbols; trace `.proto`/`.thrift`/schema when generation or contracts change — do not treat generated files as the primary review target
- **In-repo API**: extract path/method/param names → `search_in_repo` for route/handler → `read_around` for validation/DTO → compare with this call
- **If resolve_import returns empty**: use `search_in_repo` with path fragments or symbol names (works across languages and path aliases)

## Decision protocol (report vs omit)

- **Verified**: symbol/API used in this change has no in-file declaration and tools found no definition → **must report Medium**. Put residual doubt in the reason ("needs human confirmation"); do not omit.
- **Incomplete evidence**: keep tracing, or report Medium with an incomplete-evidence note. **Do not** silently omit because it "might be a global / example / not necessarily a bug".
- Labels like "good sample", "demo", or "test fixture" do **not** exempt runtime defects from reporting.
- Style-only issues with no runtime impact may be omitted or Suggestion.

## Evidence chain

1. Identify symbols or APIs from the **changed snippet**.
2. Resolve definition via `resolve_import` / `read_symbol_context` / `find_references(kind=definition)`; for APIs, search the route definition.
3. Use `trace_callers` for blast radius of this change — do not re-review callers' legacy issues.
4. Ask: **without this change, would the same issue be introduced the same way?** If yes, do not report.
5. If still unsure after tools: report with confirmation note — do not drop the finding.

## Output rules

- Issues must land on the changed file/snippet.
- Risk reasons may cite definition lines as **context evidence** and explain how they make **this** change risky.
- If tools find no definition for a newly used symbol or API path: report as a **runtime defect (Medium)**; "needs human confirmation" may appear in the reason; **do not** downgrade to Suggestion.
- Confidence ≠ risk level. Test/example paths do not auto-downgrade.
- Do not invent unseen implementation details.
