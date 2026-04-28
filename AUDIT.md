# Security & Code Audit — bright-endospine-line-channel

**Audit date:** 2026-04-29
**Auditor:** Kairyu (Claude Opus 4.7, on behalf of Dr. Siravich Suvithayasiri)
**Forked from:** [elchika-inc/line-to-cc](https://github.com/elchika-inc/line-to-cc) at upstream commit (28 commits as of fork date)
**Audit scope:** Full source review of `src/` (8 files, ~30 KB) plus security-critical test coverage in `tests/`
**Purpose:** Decide whether this Claude Code Channels plugin is safe to run on Mac Mini with full Claude Code session access.

---

## Verdict

**PASS — safe to deploy on Mac Mini for personal single-user use, with the operational notes below.**

The author understood the security model required of a webhook bridge and implemented it correctly. All foundational security primitives are in place: HMAC verification before parsing, sender allowlist with cryptographically secure pairing codes, minimal MCP tool surface, localhost-only HTTP binding, and graceful shutdown. Test coverage hits every security-critical invariant. No malicious patterns, no obvious bugs, no over-broad permissions.

Risk profile is "early version, unproven by community" rather than "code defect." Acceptable for personal use with the standard guardrails.

---

## What was reviewed

| File | Lines | Role |
|---|---|---|
| `src/signature.ts` | 23 | HMAC-SHA256 webhook signature verification |
| `src/types.ts` | 63 | LINE webhook type definitions and access config schema |
| `src/tunnel.ts` | 62 | Cloudflared quick tunnel lifecycle |
| `src/webhook.ts` | 83 | Hono HTTP handler — signature verify, dedup, dispatch |
| `src/line-api.ts` | 108 | LINE Messaging API client (push, webhook config) |
| `src/access-control.ts` | 138 | Pairing flow + allowlist enforcement |
| `src/permission.ts` | 130 | Permission relay via Flex Message |
| `src/server.ts` | 269 | MCP server entry, tool registration, orchestration |
| `tests/signature.test.ts` | 30 | HMAC valid/invalid/tampered/wrong-secret |
| `tests/access-control.test.ts` | 125 | 15 tests covering all access invariants |
| `tests/webhook.test.ts` | 213 | 8 tests covering all signature + dispatch paths |
| `package.json` | — | Dependencies: only `@modelcontextprotocol/sdk`, `hono`, `zod` (all official/mainstream) |
| `.mcp.json` | — | MCP server registration: spawns `bun src/server.ts` over stdio |

---

## Strengths

### Security foundations are correct

- **HMAC-SHA256 implementation** uses native Web Crypto API (`crypto.subtle.verify`) — constant-time, no custom crypto, correct algorithm per LINE spec. Body is verified as raw bytes BEFORE JSON parsing (correct order — prevents resource exhaustion via huge JSON from unauth requests).
- **Pairing codes** generated via `crypto.getRandomValues` (cryptographically secure RNG). 6 chars from a 36-char alphabet = ~2.18 billion possibilities. Combined with 2-attempt limit and 1-hour expiry, brute-force is infeasible.
- **Allowlist auto-locks** after first successful pairing — `addUser()` automatically sets `mode = 'allowlist'`, which silently drops any unallowed sender thereafter. No window of vulnerability after initial setup.
- **Concurrent pairing serialization** — only one pairing-in-progress at a time, blocks parallel attempts from different LINE accounts.
- **MCP tool surface is minimal** — exactly 2 tools exposed to Claude: `line_reply` (send LINE message) and `line_verify_pairing` (approve user). No filesystem, shell, or arbitrary network. Claude cannot be tricked through this plugin into doing more than these two narrow actions.
- **HTTP server bound to `127.0.0.1`** — not exposed externally. Cloudflared tunnel is the only public ingress.
- **Subprocess execution uses `execFileSync` with array args** (NOT `exec` with shell) — no command injection possible.

### Architectural choices are sane

- Returns `200 OK` immediately, processes events asynchronously via `queueMicrotask` — correct pattern for LINE's webhook timeout requirements.
- Event ID deduplication with bounded map (1000 entries, oldest evicted) — handles LINE redeliveries.
- Webhook URL set with retry + backoff (3s, 5s, 7s, 9s) and verified via `getWebhookUrl()` cross-check — robust to tunnel propagation timing.
- Connectivity tested via LINE's `testWebhook` API after configuration.
- Graceful shutdown on stdin close — kills tunnel + stops HTTP server.
- Stored config at standard path `~/.claude/channels/line/access.json` — matches Channels framework convention.

### Test coverage hits the right places

All 4 HMAC behaviors tested. All 15 access-control invariants tested (including expiry via test-only escape hatch, concurrent rejection, persistence round-trip). All 8 webhook paths tested (missing/invalid sig, empty events, text dispatch, verdict dispatch, group/room replyTo handling, dedup). The author wrote tests that would catch real bugs, not coverage padding.

---

## Concerns (none are blockers, ranked by severity)

### Operational — worth addressing

| # | Concern | File | Impact | Recommended fix |
|---|---|---|---|---|
| **OP-1** | No LINE rate-limit awareness. LINE free plan = 200 push messages/month. Errors are logged to stderr but not surfaced to Claude/user. | `line-api.ts` | Could silently exceed quota. | Add a counter that warns at 150/month via MCP notification. |
| **OP-2** | `pkill -f 'cloudflared tunnel'` kills ANY cloudflared tunnel owned by user, not just ours. | `tunnel.ts` | If you run another cloudflared tunnel for unrelated purposes, it'll be killed on plugin start. | Document this. Or change pkill to match a more specific pattern. |

### Robustness — minor

| # | Concern | File | Impact | Recommended fix |
|---|---|---|---|---|
| **R-1** | `JSON.parse(rawBody)` after sig verify is not wrapped in try/catch. Malformed body would throw. | `webhook.ts` | Hono catches and returns 500 — request handler doesn't crash, but error response is uglier than necessary. | Wrap in try/catch, return 400 on parse failure. |
| **R-2** | `fetch` calls in line-api.ts have no explicit timeout. Slow LINE API could block. | `line-api.ts` | Bun's implicit fetch timeout applies, but explicit would be cleaner. | Add `AbortSignal.timeout(10_000)` to fetch calls. |
| **R-3** | Non-null assertion `seenEventIds.keys().next().value!` in dedup eviction. | `webhook.ts` | Brittle if Map state ever desyncs. | Add defensive check before `!`. |

### Design — worth knowing, not changing

| # | Concern | File | Impact | Note |
|---|---|---|---|---|
| **D-1** | `lastReplyTo` and `lastPendingRequestId` are module-level mutable state. | `server.ts` | Single-user assumption is implicit. Permission requests always go to whoever Claude last talked to. | For Dr. Bright (single-user setup) this is fine. Document the assumption. |
| **D-2** | Permission Flex Message `altText` and labels are hardcoded Japanese. | `permission.ts` | Cosmetic. | Dr. Bright reads Japanese, so no functional issue. Could parameterize for multi-language support if ever needed. |
| **D-3** | Pairing flow auto-starts when ANY unallowed user messages the OA during initial pairing window. They receive a code but can't act on it without terminal access. | `server.ts` + `access-control.ts` | Small information leak (attacker learns bot is alive) only during initial pairing window. After Dr. Bright pairs, mode auto-switches to `allowlist`, dropping unauth users silently. | Acceptable. Pair quickly to close the window. |

### Documentation — operational reality

| # | Concern | Note |
|---|---|---|
| **DOC-1** | Repo had 0 stars / 0 forks / 0 issues at fork time. We are the first real users. | Risk is "undiscovered bugs" not "malicious code." Watch first-week behavior carefully. |
| **DOC-2** | Documentation primarily in Japanese. | Dr. Bright is bilingual — fits well. Means smaller community pool for debugging. |

---

## Recommended fixes to apply (Option B scope — light, in-place)

Apply these in the audit pass. Skip everything else (cosmetic, design preferences) for upstream consideration.

1. **OP-1**: Add rate-limit warning at 150 messages/month in `line-api.ts`
2. **R-1**: Wrap `JSON.parse` in try/catch in `webhook.ts`, return 400 on failure
3. **R-2**: Add 10s `AbortSignal.timeout` to all `fetch` calls in `line-api.ts`

Skipped (would change behavior or add complexity beyond audit scope):
- OP-2 (pkill scope) — would change tunnel reliability tradeoff
- R-3 (non-null assertion) — code paths show it can't actually fire, fix is style not safety
- D-* — design notes, not bugs

---

## Operational guardrails for deployment

When deploying on Mac Mini, regardless of code-level fixes:

1. **Run with `--permission-mode default`** (NOT `--dangerously-skip-permissions`). Permission relay via Flex Message means destructive Claude Code actions still require explicit Allow/Deny from your phone — that's the whole point.
2. **Pair immediately and lock the allowlist.** As soon as the channel goes live, send the first message from your LINE account, get the pairing code, approve in Claude Code terminal. Mode auto-switches to `allowlist`, all other senders silently dropped.
3. **Monitor first-week behavior via git diff.** Every Kairyu action via LINE produces file changes on Mac Mini. Review the commits to verify Kairyu is doing what you expect.
4. **Watch the LINE message counter.** With OP-1 fix applied, you'll get warned at 150/month. Without it, watch for `[line] Push API error (429)` in logs.
5. **Mac Mini sleep must stay disabled** (separate decision — energy cost ~220 THB/year, infrastructure prerequisite).

---

## Conclusion

The code is honestly written and architecturally sound. Author chose the right primitives, implemented them correctly, and wrote tests that prove the security-critical paths actually work. The risk to Dr. Bright is operational ("first user, unfamiliar territory") not technical ("the code might do something bad").

Proceed with deployment after applying the three recommended fixes (OP-1, R-1, R-2) and following the operational guardrails above.
