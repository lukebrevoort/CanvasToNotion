# Cloudflare adapter prototype: dummy data only

This is an incremental foundation, **not a deployed or production-ready sync**.
There is no Wrangler deployment configuration, scheduled handler, credential
binding, production database import or live Canvas/Notion transport here.

## Implemented

- `src/notion/projector-core.ts` takes explicit destination IDs and has no Node
  runtime imports. The existing Node wrapper retains its API and behavior.
- `src/cloudflare/journal.ts` records account/source/destination binding,
  generation, active run and operation intents/receipts. Admission is exclusive.
  An uncertain operation, duplicate trigger or recovered active handle cannot
  dispatch another effect. There is no timeout takeover or reset operation.
- `src/cloudflare/sqlite-storage.ts` adapts that journal to SQLite-backed Durable
  Object storage. Transactions and `storage.sync()` are serialized together;
  external work cannot start on an unconfirmed durability acknowledgment. A
  failed acknowledgment blocks the adapter instance. Transaction callbacks are
  synchronous and isolated values are returned.
- Local Miniflare/workerd tests exercise real SQLite persistence across runtime
  disposal/restart, duplicate and concurrent triggers, lost effect receipts, and
  loading/rendering the pure projector. The fixture has dummy identifiers only;
  every outbound fetch is intercepted, rejected and counted (expected count zero).

- `mirror-import.ts` validates a bounded synthetic-only interchange document and
  atomically stores it without overwriting existing data. Pending or unresolved
  inputs and non-pristine journals are rejected. Notes, historical Activity and
  user flags are preserved as supplied. This is not a production SQLite importer.
- `batches.ts` runs one explicit offline batch at a time. Its checkpoint is tied
  to a contiguous terminal receipt history and the exact full ordered plan.
  Only completed batches can continue after runtime restart. Budgets count fake
  request-port calls, not real provider calls, redirects or retries.
- `auth-state.ts` encrypts dummy tokens with AES-GCM bound to scope/version and
  generation. Refresh is journaled, uses CAS and retains the old refresh token
  when the synthetic response omits one. Unknown responses or durability block
  further refresh. There is no public token-read/header-generation interface.
- Expanded local runtime checks persist the synthetic mirror and encrypted auth
  state, resume between completed batches, preserve omitted refresh tokens, and
  refuse lost-receipt batch/auth retries across restarts. No provider calls occur.

- `coordinator.ts` adds a durable aggregate admission gate for trusted callbacks.
  It persists non-ready state before import or a batch, verifies exact durable
  component references before/after work, and records completed operation IDs.
  Interrupted work stays blocked. A lost final ready acknowledgment may be
  revalidated after reconstruction only when the referenced effects are already
  terminal; it does not authorize replay of the same operation.
- `transport.ts` bounds actual injected fetch calls, refuses redirects, omits
  credentials and allows only `.invalid` fixture origins. Its deadline covers
  headers and streamed JSON; ignored cancellation remains tracked until settled
  and leaves sticky uncertainty. There is no real-provider/auth mode.
- `mirror-state.ts` supplies pure observation/revision/acknowledgment transitions.
  Identical source observations keep stable pending identity; stale acknowledgments
  cannot clear newer work. Do Not Sync freezes observations/acks without deleting
  pending work. These helpers do not themselves persist or verify remote effects.
- The local composed fixture gates mirror import and checkpointed journal batches
  through the coordinator and bounded transport. It verifies durable artifact
  digests and terminal journal receipts, resumes completed batches across restart,
  and refuses uncertain import/effect retries without duplicating dummy effects.

- `mirror-storage.ts` persists revision transitions atomically and serializes
  through durability acknowledgment. The additional workerd pipeline combines
  this store, encrypted auth and the gate. Known token expiry is rejected before
  any intent so an explicit refresh can proceed; token use rechecks freshness.
  Provider receipt precedes mirror acknowledgment, which precedes journal finish
  and aggregate readiness. Lost-effect restarts preserve pending work and refuse
  another dispatch. Protected and Do Not Sync assignments remain unchanged.

## Tests

Run `npm run typecheck` and `node --import tsx --test test/*.test.ts`.
The workerd fixture uses compatibility date `2026-07-01` and versions pinned in
the lockfile. It establishes local runtime compatibility, **not** production
availability, current account quotas or Cloudflare network failure semantics.

## Deliberate limits

The journal is a single bounded JSON row, not the canonical assignment mirror.
It has no compaction; the SQL adapter refuses documents over 1 MiB. Storage and
orchestration are trusted ports, not authentication boundaries. Handles are not
credentials; caller-supplied request digests/receipts are not provider proof.
The effect callback must await all work it starts and must not leak concurrent
background writes. There is no production HTTP/RPC route exposing these ports.

No retry/reconciliation authority has been implemented. A crash may leave an
admitted run permanently blocked even before an effect began. That is an
intentional fail-closed result until evidence-based recovery is designed. A
stopped or reconstructed object is not proof a remote request was cancelled.
Generation checks cannot fence a process that still holds direct provider
credentials outside this journal.

### Cross-component boundary

The coordinator closes aggregate admission for the composed import/batch fixture,
not for arbitrary direct use of low-level ports. All component writes must occur
inside its awaited callbacks, and its verifier must read exact durable evidence.
Separate component queues are not independently a global lock. The additional composed pipeline integrates encrypted auth refresh/use and durable
mirror revisions under that gate. Production still needs one authenticated entry
point with no raw-port bypass, real key provisioning and provider-specific
transport. None of those production capabilities is enabled by these fixtures.

Auth persistence precedes journal acknowledgment; a crash between those commits
leaves that journal blocked even if the auth row says ready. Do not use auth state
with a replacement journal or treat its ready status as permission to use tokens.
A coordinator ready row after lost delivery is usable only after revalidating all
referenced terminal component receipts; a non-ready row never expires or clears
itself. Fixture keys and token strings are public dummy values, never provisioning
advice. Transport aborts are not proof of cancellation at a remote service.

## Next implementation gates

1. Integrate a canonical mirror adapter and verified production import/export format,
   preserving pending revisions, snapshots, watermarks and existing Notion IDs.
2. Connect bounded batches to actual projection and a transport-enforced request budget. Free
   Workers allow 50 subrequests per invocation; the current full pipeline cannot
   be moved wholesale into one free invocation. Persist completion between
   batches, and never resume an uncertain external effect automatically.
3. Connect the synthetic auth protocol to one serialized Canvas refresh owner and real encrypted credential
   versions. Canvas documents renewed access tokens with the original refresh
   token reused; do not assume a single-use refresh token. Unknown refresh
   outcomes still need explicit recovery. No secrets belong in fixtures or logs.
4. Design actual Notion receipt reconciliation and manual recovery authority.
   Preserve Notes, historical Activity, manual overrides and Do Not Sync.
5. Add sanitized durable operational telemetry, encrypted checkpoint recovery,
   retention and failure/quota tests. R2 is not a live SQLite filesystem.
6. Obtain scoped authorization for any provider resources, real-data migration,
   credentials/security changes, paid plan and eventual deployment/schedule.
   Keep earlier writers disabled and resolve their containment before cutover.

## Platform references checked November 4, 2026

- [SQLite transactions and durable sync](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Alarms are at-least-once and retry](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Object concurrency and lifecycle](https://developers.cloudflare.com/durable-objects/api/state/)
- [Workers CPU and subrequest limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Canvas OAuth refresh behavior](https://developerdocs.instructure.com/services/canvas/oauth2/file.oauth)

The free tier is a target to measure, not a cost guarantee. Alarms can retry and
objects can restart; persistent admission must guard both. Do not put a long
network operation inside `blockConcurrencyWhile` as a substitute for the journal.

- [Workers Web Crypto and AES-GCM](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)

## Recurring operation design (not enabled)

The pure `schedule.ts` policy starts at a 15-minute interval measured from a
fully completed cycle (96 baseline polls per day). A verified terminal batch with
remaining work may continue after 5 seconds. Missed polls coalesce instead of
catching up in a burst. Active work holds its admission; uncertain or unverified
state stops scheduling. Every wake must revalidate durable evidence and expected
generation; alarm delivery itself is never permission to replay.

Cloudflare alarms are at-least-once, may retry six times, and cancellation is
best-effort. Workers Free cron CPU is 10 ms; Durable Objects have separate CPU
limits. This is why a thin trigger and small durable batches are preferable to one
long cron invocation. No quota fit is claimed until CPU, requests, row operations,
duration and account-wide usage are measured.

The V1 prototype also has deliberate history caps (1000 coordinator operations,
64 KiB coordinator state, 1 MiB journal). At frequent polling these eventually
stop progress, potentially much sooner than 1000 cycles when cycles have multiple
batches. They must not be silently pruned: generation-bound deduplication and
verified terminal retention need a separately tested contract before indefinite
scheduled operation can be claimed.

- [Durable Object free-tier quotas](https://developers.cloudflare.com/durable-objects/platform/pricing/)
