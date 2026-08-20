---
id: api-boundary-trace
name: Monorepo FE/BE API contract tracing
summary: In a monorepo, frontend API calls must be traced to backend definitions to verify method/path/required params; backend signature changes must find callers
modes: [diff, batch, segment]
match: []
priority: 25
---

# Monorepo FE/BE API contract tracing (required)

Use when frontend and backend live in the **same repository** (or monorepo).
Goal: decide whether **this change** breaks the other side's contract.
Callee/definition code is **evidence only** — do not report unrelated legacy issues there.

## When you must trace

Trace if this change adds or updates any of:

1. **Client HTTP/API calls**: `fetch` / `axios` / `request` / `http.*` / GraphQL / wrappers like `api.xxx` / `*.get|post|put|patch|delete`
2. **URL, method, query, body, headers, or path params**
3. **Backend route / handler / DTO / validation** signatures (path, required fields, types, defaults)

## Suggested tool order (multiple TOOL_CALL in one turn is OK)

1. From the changed snippet extract: `method`, path (or path fragment), request param names (query/body/headers)
2. `search_in_repo`: locate the backend definition via path fragment, route decorators, `router.|app.|@Get|@Post|@RequestMapping`, handler names
3. `read_symbol_context` / `read_around` / `read_file`: read validation, DTO, required fields
4. If reviewing a backend signature change: `find_references` / `search_in_repo` / `trace_callers` to find in-repo callers and check they still match

## Contract checks

Against the **backend definition (or OpenAPI/DTO)**, check whether this call:

| Check | Example |
|--------|---------|
| Method | GET vs POST |
| Path | `/users/:id` matches the call path |
| Required params | Missing body/query/path fields, typos |
| Type / enum | Object where string expected; illegal enum |
| Auth headers | Token/cookie required but not sent (when visible in the snippet) |

## How to report

- **Issue location**: always on the **changed file/snippet** (frontend call → frontend; breaking backend signature → backend).
- **Risk reason**: cite definition fields/validation as evidence and explain how **this** call/signature mismatches.
- **Definition not found**: if this change clearly calls a path/symbol, report **Medium** with "no matching in-repo route/handler; needs human confirmation". Do **not** downgrade to Suggestion.
- If the repo is clearly frontend-only or backend-only and the other side cannot be found: skip cross-boundary checks; do not invent a backend.

## Correct / incorrect examples

- Correct: frontend adds `POST /api/order` without `userId`; handler requires it → report on the frontend call snippet.
- Incorrect: tracing finds an unrelated old log in the handler → do not report it.
- Correct: backend makes `userId` required; in-repo frontend callers omit it → report on the backend change (with caller evidence).
