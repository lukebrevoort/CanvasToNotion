# Canonical orchestration contract

This document describes the remaining integration boundaries. It is not an
installed runner, a migration, or proof that production writes are admitted.

## Source cycles and projection batches are different units

A source cycle captures the previous successful run's **start** timestamp once.
Every course uses that same incremental watermark. Its observed course IDs and
time zones, groups, pagination checkpoints and staged assignments must survive
restarts. Completing one endpoint or all source observations does not finish the
canonical sync run. Pending work is drained even when the incremental response
contains no changed assignments, and only for courses observed in that cycle.

Canonical observations, snapshots and pending revisions use the existing store
logic. Do Not Sync remains a Notion projection decision; it does not freeze the
canonical source mirror. A successful source-only step leaves the run running.

## Plan from current state, not a queued payload

A trusted planner reads canonical pending records and current assignment rows,
plus immutable destination, domain, course-page and label context. It captures
and fingerprints that content before admission and revalidates it after awaits.
The canonical pending revision remains the stable Activity identity. A new
journal generation is not permission to replay stale payloads under a new ID.

A batch effect limit is not an HTTP request budget. One assignment projection can
paginate identity queries, retrieve overrides, update properties, replace Details
and reconcile Activity. Enforce a separate actual-request/body/deadline budget.
Course-page writes and their relation IDs are explicit prerequisites, not hidden
assignment effects.

## Acknowledge exactly what was verified

Per-operation validation must remain possible after earlier operations have been
acknowledged. Whole-plan equality alone is insufficient once its first pending
record is removed. Completion needs a durable verified prefix or per-operation
receipts, not a caller assertion that earlier work completed.

For the Cloudflare path, the exact pending flags and captured canonical content
must still match at acknowledgment, not only the revision string: a forced
unchanged observation can change pending flags without rotating its revision.
Perform that check and the acknowledgment in one synchronous transaction, then
await durability before terminal readiness. Keep the Node store semantics
unchanged unless a separate verified change is intended.

A Do Not Sync result preserves pending work and advances a cycle-local attempted
cursor so deferred rows cannot starve later assignments. A deferred result is
not proof that no writes occurred: the projector may update properties/Details
before a later Activity check observes that flag. Capture the actual verified
result and retain ambiguous effects rather than inventing a no-write receipt.

## Terminal success is an aggregate fact

Only after source completion, all planned attempts accounted for, exact receipt
and acknowledgment checks, no active unresolved effect, and durable terminal
journal evidence may the run become successful. The canonical successful
watermark must not become visible in a crash window where the aggregate gate is
still unresolved. Couple the successful run update and readiness checkpoint in
the same storage transaction or an equivalent independently verified protocol.

Frozen pending work may remain after a successful cycle, matching existing
semantics. Report its count separately from actionable failures. Unknown effect
or refresh outcomes stop writes and require evidence-based reconciliation;
passing time, an expired lease, a new process or a new generation is not proof
that old work can no longer write.

## Real-provider compatibility still needs verification

The existing client sends `include=submission` and `updated_since` on assignment
lists. The adapter's initial goal is wire compatibility with that client, not a
claim that the server honors every filter or includes submission-only changes.
Verify representative authenticated responses before relying on incremental
coverage or request-cost estimates. Likewise validate provider pagination and
cursor shapes without silently weakening destination/origin restrictions.

## Initial whole-projection execution boundary

For the initial dummy integration, call auth.withAccessToken through the compact
auth bridge directly: it owns the single journal.execute boundary. Run the whole
logical projector inside its use callback. Do not wrap withAccessToken in another
execute call or nest admission checks inside the projector. This remains a
fail-closed logical operation, not mutation-level resumability.

Its digest commits to captured projection inputs, not every dynamic HTTP request.
Any interruption or uncertain result leaves pending work and operation evidence
blocked. A restarted process cannot automatically replay that projection.

Any refresh is an explicit preceding operation in the immutable plan. Use the
resulting auth generation; never insert or implicitly refresh mid-projection.
Require token validity to cover the bounded whole-projection deadline, not just
one request timeout. The current auth adapter permits at most five minutes of
required validity and does not recheck expiry inside its callback.

Construct the guarded transport inside that execution boundary with an aggregate
operationTimeoutMs shorter than the required validity window, with a conservative
clock/dispatch margin. It counts idle
time between requests, caps request deadlines and refuses dispatch after expiry.
Before accepting a receipt, assertOperationComplete must succeed: active or
uncertain requests and an expired whole-operation deadline all prevent success.
This check does not prove provider state or seal the transport. The trusted owner
must verify projected/deferred results, stop further dispatch and retain evidence.
