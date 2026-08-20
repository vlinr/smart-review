---
id: security-deep
name: Deep security review
summary: Injection, authz, IDOR, sensitive data, SSRF, deserialization, and session security checklist
modes: [diff, batch, segment]
match: []
priority: 20
---

# Deep security review checklist

Extra checks for this change (not limited to auth directories; any new input surface, auth, outbound network, or sensitive data applies):

1. **Injection**: SQL/NoSQL/command/LDAP/template injection; unsanitized dynamic queries
2. **Auth & authz**: identity/permission checks; horizontal/vertical privilege escalation; IDOR
3. **Sensitive data**: hardcoded secrets/tokens/passwords or logging them; real secret-shaped values in tests stay High
4. **Session & cookies**: HttpOnly, Secure, SameSite; fixation / invalidation
5. **Input validation**: length, type, allowlists; upload type and path handling
6. **SSRF / outbound requests**: user-controlled URLs hitting internal or metadata endpoints
7. **Deserialization / prototype pollution**: untrusted data into deserialize or object merge
8. **CORS / redirects**: overly open CORS; open redirects

Each issue must include: file path, code snippet, risk reason, actionable fix.
Grade by severity; do not downgrade to Suggestion for "needs human confirmation" or test paths.
