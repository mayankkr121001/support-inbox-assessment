# Architecture & Decisions

## What was built
- **Inbound webhooks (`POST /webhooks/pigeon`):** Raw-body HMAC-SHA256 signature verification (`x-pigeon-signature`, `±300s` replay window), `400` on invalid JSON/payloads, `200` on unknown event types/workspaces, and idempotent storage in MongoDB (`messages`, `conversations`, `webhook_events`) with monotonic `lastActivityAt` (`$max`).
- **Conversation management & tenant isolation:** Session-authenticated REST APIs (`GET /api/conversations`, `GET /api/conversations/:contact`, `/claim`, `/close`, `/reopen`) enforcing workspace membership (`401`/`403`) and atomic single-winner claiming (`409` on conflict) via `findOneAndUpdate`.
- **Outbound replies:** `POST /api/conversations/:contact/replies` and `POST /__grader/reply` store replies as `queued` (`202`) with `(workspace, clientRef)` unique index deduplication. A background worker uses an atomic 15s MongoDB lease (`lockedUntil`), Redis-backed per-workspace token-bucket rate limiting + `429 Retry-After` cool-off, `Idempotency-Key`, and exponential backoff on `503`/timeouts. `message.status` updates enforce monotonic status precedence (`queued < sent < delivered/failed`).
- **Auth & real-time:** OIDC Authorization Code + PKCE (`S256`) with Redis-backed one-time `state` and dynamic `/jwks` `RS256` verification, Redis sessions (`sid` cookie), and `/ws?workspace=<id>&after=<seq>` WebSockets with Redis Pub/Sub and `workspace_events` replay.
- **Frontend:** React shared inbox (`scaffold/web`) with Mock IdP login, workspace switcher, paginated conversation list, message history with delivery badges, claim/close/reopen controls, and live WebSocket updates.

## What was cut and why
- **End-to-end encrypted private notes (`PROTOCOL.md`):** Cut to focus time on core reliability, tenant isolation, and the automated check levels.
- **Elasticsearch search & Paybox billing (`BONUS_BILLING.md`):** Cut as optional/bonus scope under the two-hour time limit.

## Assumptions
- Known workspaces are determined by `config.pigeon.apiKeys` (`ws_acme`, `ws_globex`).
- Session cookies (`sid`) use `HttpOnly; SameSite=Lax` over localhost HTTP in development.

## Known issues / limitations
- **Windows `npm run check`:** On Windows, `harness/check.js` spawns `sh` (requires Git Bash or `Git\bin` on `PATH`) and `SIGKILL` on process groups leaves child server processes listening on `:4001` between runs unless stopped manually.
- **Live harness verification:** Unit/contract tests (26/26) and builds pass with mocked DB/fetch; full end-to-end `npm run check:full` against Docker services must be run in Git Bash with clean ports `4000`–`4003`.
