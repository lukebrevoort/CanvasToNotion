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

## Next implementation gates

1. Add the canonical mirror adapter and a verified import/export format,
   preserving pending revisions, snapshots, watermarks and existing Notion IDs.
2. Implement bounded projection steps with a conservative request budget. Free
   Workers allow 50 subrequests per invocation; the current full pipeline cannot
   be moved wholesale into one free invocation. Persist completion between
   batches, and never resume an uncertain external effect automatically.
3. Add one serialized Canvas refresh owner and durable encrypted credential
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
