# Cloudflare cutover checklist

This is a preparation checklist, not an enabled deployment. The current adapter
is tested with dummy providers and must not be pointed at live databases merely
because its tests pass.

## Preserve the canonical state

- Use a reviewed immutable code revision and a consistent source SQLite backup.
- Preserve the existing canonical tables, snapshot JSON, pending projection UUIDs,
  source timestamps, metadata, unresolved run records and SQLite sequence values.
  Do not import via observation/upsert APIs: those would create new history.
- Inspect the export format for credentials before any upload. Authentication
  material belongs in approved secret storage, never an import, log or PR.
- Compare row counts, checksums and foreign-key integrity after import, then
  verify existing Notion IDs. Keep import incomplete until all checks pass.
- Prove source and projection parity on representative dummy fixtures first,
  including omitted submissions, time zones, pending revisions and Do Not Sync.

## Establish one writer and one refresh owner

- Identify every scheduled, manual, MCP and already-running writer. Disabling a
  trigger does not terminate a previously admitted process or remote request.
- Establish actual termination or an enforceable credential/resource boundary
  before recurring cutover. A new local lock cannot fence an old direct token.
- Assign exactly one owner of OAuth refresh and durable token-version updates.
  Do not allow old and new runtimes to refresh shared credentials concurrently.
- Unknown effects or refresh outcomes remain blocked pending evidence-based
  reconciliation. Time passing is not proof that an earlier request ended.

## Provision explicitly

- Confirm the Cloudflare account, resource names, plan and spending constraints.
  No paid plan or cost guarantee is implied by a free-tier design target.
- Obtain approval for persistent credentials/access and any real-data transfer.
  Provision secrets through an approved secure flow, never chat or repository.
- Provide a separately recoverable encryption key and versioned encrypted auth
  state. Verify restart and recovery without printing token values.
- Keep the operational entry point private/authenticated. Low-level SQL and
  journal methods are internal ports, not public HTTP or RPC capabilities.
- Deploy initially with polling disabled and production writes gated off.

## Admit the first controlled cycle

- Verify imported canonical state and exact destination binding again.
- Derive work from durable current pending revisions and source cursors. Never
  assign a fresh generation to a stale queued request merely to make it pass.
- Enforce transport deadlines, full-body limits, request budgets and cancellation
  tracking. An abort signal is not proof of remote cancellation.
- Order writes: verified provider receipt, durable matching revision/cursor
  acknowledgment, terminal journal record, independently verified readiness.
- Inspect the durable terminal record, error count and remaining pending work.
  A successful process exit or ready status label alone is insufficient.

## Enable recurring operation only after verification

- Start with a measured, bounded polling cadence, provisionally 15 minutes from
  the end of a successful cycle. Continue a verified partial batch separately.
- Revalidate generation, readiness and next-wake state on every delivery. Alarms
  can repeat; do not overlap work or burst through missed intervals.
- Measure CPU, external requests, row reads/writes, physical storage, duration
  and account-wide quotas before tightening the cadence. Free overages can fail.
- Persist actionable failure/uncertainty telemetry and stop affected writes;
  routine success can remain quiet. Monitor backlog and source freshness.
- Test restart, duplicate alarm, response loss, storage uncertainty and rollback.
  Rolling hashes are commitments, not recoverable logs or provider evidence.

## Rollback

Pause future admissions and alarms, retaining unresolved evidence. Account for
already admitted requests before re-enabling any old writer. Restore only a
verified checkpoint with its matching credential version and destination binding;
do not recreate databases or reset state to work around a failed import or run.
