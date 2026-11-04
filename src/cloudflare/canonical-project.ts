/** Dummy-only whole-projector integration. Fresh admission only, no replay or
 * recovery. The trusted aggregate owner serializes source/projection writers and
 * supplies verified immutable course context. This never finishes a sync run.
 * Terminal means THIS BATCH only. Earlier detailed outcomes are replaced after
 * verified adjacent-generation transition; attempted IDs prevent starvation but
 * do not retain full-cycle success/deferred counts or prove aggregate completion.
 * Future cycle finalization needs separate durable per-cycle coverage evidence.
 * Adjacent-generation transitions intentionally forbid interleaved refresh batches;
 * this helper implements neither recurrence nor a full-cycle finalizer. */
import type { Client } from "@notionhq/client";
import { createStore, type StoreDependencies } from "../store/core.js";
import { upsertAssignmentPage } from "../notion/projector-core.js";
import { createDurableSqlDatabase } from "./canonical-sql.js";
import { revalidateCanonicalPendingBatch, revalidateCanonicalPendingOperation, type CanonicalPendingPlan, type CanonicalPlannedOperation } from "./canonical-plan.js";
import { createCompactAuthJournal } from "./compact-auth.js";
import type { CompactHandle, CompactSyntheticJournal, CompactTerminal } from "./compact-journal.js";
import type { SyntheticAuthStateAdapter } from "./auth-state.js";
import { createSyntheticNotionClient } from "./notion-client.js";
import { SyntheticJsonTransport } from "./transport.js";
import type { DurableSqlStorage } from "./sqlite-storage.js";

const TABLE = "synthetic_canonical_projection_v1";
export interface CanonicalProjectionCycle { cycleId: string; revision: number; runId: number }
export interface CanonicalProjectionOutcome {
  index: number; assignmentId: number; revision: string; requestDigest: string;
  pageId: string; pushed: boolean; acknowledged: boolean; receiptId: string;
  requestsUsed: number;
}
export interface CanonicalProjectionState {
  version: 1; cycle: CanonicalProjectionCycle; phase: "running" | "terminal";
  generation: number; journalPlanDigest: string; plan: CanonicalPendingPlan;
  attemptedAssignmentIds: number[]; outcomes: CanonicalProjectionOutcome[];
  previousTerminal: CompactTerminal | null; terminal: CompactTerminal | null;
}
export interface CanonicalProjectionRequest {
  plan: CanonicalPendingPlan; handle: CompactHandle; cycle: CanonicalProjectionCycle;
  journal: CompactSyntheticJournal; auth: SyntheticAuthStateAdapter; authGeneration: number;
  /** Required only for an explicit next batch; must exactly match durable terminal. */
  previousTerminal?: CompactTerminal;
  nowMs: () => number; minValidityMs: number;
  /** Remaining actual HTTP calls for this whole invocation, after upstream reserves. */
  requestBudget: number; timeoutMs: number; operationTimeoutMs: number; maxResponseBytes: number;
  /** Whole invocation deadline including auth/storage waits; defaults to operationTimeoutMs. */
  batchTimeoutMs?: number;
  /** Trusted OFFLINE dummy service, never a real-provider/global fetch. */
  fetch: typeof fetch;
  /** Trusted synchronous binding/course page/label/domain/destination verification.
   * Called within local transactions too: must be read-only and never return a Promise. */
  verifyContext: (cycle: Readonly<CanonicalProjectionCycle>, plan: CanonicalPendingPlan) => boolean;
  /** Synthetic service readback oracle. No token or transport escapes to it.
   * Portable projector success alone does not prove every property readback. */
  verifyResult: (operation: CanonicalPlannedOperation, result: Readonly<{ pageId: string; pushed: boolean }>) => Promise<boolean>;
}
export class CanonicalProjectionError extends Error {
  constructor(readonly code: "invalid" | "source" | "context" | "blocked" | "stale" | "capacity" | "uncertain") {
    super(`Synthetic canonical projection: ${code}`); this.name = "CanonicalProjectionError";
  }
}
function fail(code: CanonicalProjectionError["code"]): never { throw new CanonicalProjectionError(code); }
function json(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(json).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${json((value as Record<string, unknown>)[k])}`).join(",")}}`;
}
const same = (a: unknown, b: unknown) => json(a) === json(b);
const receiptId = (generation: number, index: number, digest: string) => `SYNTHETIC_projection_${generation}_${index}_${digest}`;

export class SyntheticCanonicalProjector {
  private readonly db;
  private storeValue?: ReturnType<typeof createStore>;
  private failed = false;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly storage: DurableSqlStorage, private readonly dependencies: StoreDependencies) {
    this.db = createDurableSqlDatabase(storage);
  }
  private store() { return this.storeValue ??= createStore(this.db, this.dependencies); }
  private read(): CanonicalProjectionState | undefined {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(TABLE)) return undefined;
    const row = this.db.prepare(`SELECT document FROM ${TABLE} WHERE slot=1`).get() as { document: string } | undefined;
    return row ? JSON.parse(row.document) as CanonicalProjectionState : undefined;
  }
  private put(state: CanonicalProjectionState): void {
    const document = JSON.stringify(state);
    if (new TextEncoder().encode(document).byteLength > 1_048_576 || state.outcomes.length > 20 || state.attemptedAssignmentIds.length > 1000) fail("capacity");
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE}(slot INTEGER PRIMARY KEY CHECK(slot=1),document TEXT NOT NULL)`);
    this.db.prepare(`INSERT INTO ${TABLE} VALUES(1,?) ON CONFLICT(slot) DO UPDATE SET document=excluded.document`).run(document);
  }
  private async commit<T>(fn: () => T): Promise<T> {
    if (this.failed) fail("blocked");
    try {
      const result = this.storage.transactionSync(fn);
      await this.storage.sync();
      return result;
    } catch { this.failed = true; fail("uncertain"); }
  }
  private source(request: CanonicalProjectionRequest): void {
    const row = this.db.prepare("SELECT document FROM synthetic_canonical_cycle_v1 WHERE slot=1").get() as { document: string } | undefined;
    const source = row ? JSON.parse(row.document) : null;
    if (!source || source.syntheticOnly !== true || source.schemaVersion !== 1 || source.cycleId !== request.cycle.cycleId ||
        source.revision !== request.cycle.revision || source.runId !== request.cycle.runId || source.phase !== "source_complete" || source.status !== "source_complete" ||
        !same(source.courses.map((c: { id: number }) => c.id).sort((a: number, b: number) => a - b), request.plan.observedCourses.map(c => c.courseId))) fail("source");
    const run = this.db.prepare("SELECT * FROM sync_runs WHERE id=?").get(request.cycle.runId) as { status: string; started_at: string; finished_at: string | null } | undefined;
    const latest = this.db.prepare("SELECT id FROM sync_runs ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
    if (!run || latest?.id !== request.cycle.runId || run.status !== "running" || run.finished_at !== null || run.started_at !== source.startedAt) fail("source");
    if (request.verifyContext(Object.freeze({ ...request.cycle }), request.plan) !== true) fail("context");
  }
  /** Read evidence only. Existing running state never grants resumed ownership. */
  async inspect(): Promise<CanonicalProjectionState | undefined> {
    await this.tail;
    const value = this.read();
    return value ? structuredClone(value) : undefined;
  }
  run(input: CanonicalProjectionRequest): Promise<{ terminal: CompactTerminal; receiptId: string; state: CanonicalProjectionState }> {
    // Retain only trusted function/port references; copy all mutable controls.
    const request = { ...input, cycle: structuredClone(input.cycle), handle: structuredClone(input.handle),
      previousTerminal: input.previousTerminal ? structuredClone(input.previousTerminal) : undefined };
    const work = this.tail.then(() => this.runOwned(request));
    this.tail = work.then(() => undefined, () => undefined);
    return work;
  }
  private async runOwned(r: CanonicalProjectionRequest): Promise<{ terminal: CompactTerminal; receiptId: string; state: CanonicalProjectionState }> {
    if (this.failed) fail("blocked");
    const batchTimeoutMs = r.batchTimeoutMs ?? r.operationTimeoutMs;
    if (!Number.isSafeInteger(batchTimeoutMs) || batchTimeoutMs < 1 || batchTimeoutMs > 300000) fail("invalid");
    const batchDeadline = performance.now() + batchTimeoutMs;
    let batchRequests = 0;
    const remainingTime = () => { const left = Math.floor(batchDeadline - performance.now()); if (left < 1) fail("uncertain"); return left; };
    const guardedFetch: typeof fetch = async (input, init) => {
      remainingTime();
      if (batchRequests >= r.requestBudget) fail("capacity");
      batchRequests++;
      return r.fetch(input, init);
    };
    if (!Number.isSafeInteger(r.minValidityMs) || r.minValidityMs > 300_000 || r.minValidityMs < r.operationTimeoutMs + 1000 ||
        !Number.isSafeInteger(r.operationTimeoutMs) || r.operationTimeoutMs < 1 ||
        !Number.isSafeInteger(r.requestBudget) || r.requestBudget < 1 || r.requestBudget > 50 ||
        !Number.isSafeInteger(r.timeoutMs) || r.timeoutMs < 1 || r.timeoutMs > 25000 ||
        !Number.isSafeInteger(r.maxResponseBytes) || r.maxResponseBytes < 1 || r.maxResponseBytes > 1_048_576 ||
        typeof r.fetch !== "function" || typeof r.verifyResult !== "function" || typeof r.verifyContext !== "function") fail("invalid");
    try {
      if ((r.plan.attemptedAssignmentIds?.length ?? 0) + r.plan.operations.length > 1000) fail("capacity");
      // Reserve bounded result/receipt/terminal overhead before any dispatch.
      if (new TextEncoder().encode(JSON.stringify(r.plan)).byteLength + r.plan.operations.length * 2048 + 32768 > 1_048_576) fail("capacity");
      const store = this.store();
      this.source(r); revalidateCanonicalPendingBatch(store, r.plan);
      await r.journal.assertOwnedAdmission(r.handle);
      const journalBefore = await r.journal.inspect();
      const intents = r.plan.operations.map((op, index) => ({ kind: op.kind, targetId: op.targetId, requestDigest: op.requestDigest,
        operationId: `SYNTHETIC_projection_op_${r.handle.generation}_${index}` }));
      const bridge = await createCompactAuthJournal({ journal: r.journal, handle: r.handle, operations: intents });
      const prior = this.read();
      if (prior) {
        if (prior.phase !== "terminal" || !prior.terminal || prior.outcomes.length !== prior.plan.operations.length) fail("blocked");
        for (const [index, outcome] of prior.outcomes.entries()) {
          const operation = prior.plan.operations[index]!;
          if (outcome.index !== index || outcome.assignmentId !== operation.assignmentId || outcome.revision !== operation.revision ||
              outcome.requestDigest !== operation.requestDigest || outcome.acknowledged !== outcome.pushed ||
              outcome.receiptId !== receiptId(prior.generation, index, operation.requestDigest)) fail("blocked");
        }
        const receipts = prior.outcomes.map(o => ({ status: "succeeded", receipt: { receiptId: o.receiptId } }));
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(receipts)));
        const receiptDigest = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
        if (receiptDigest !== prior.terminal.receiptDigest) fail("blocked");
        const expectedAttempts = [...(prior.plan.attemptedAssignmentIds ?? []), ...prior.outcomes.map(o => o.assignmentId)].sort((a,b) => a-b);
        if (!same(expectedAttempts, prior.attemptedAssignmentIds)) fail("blocked");
      }
      await this.commit(() => {
        this.source(r); revalidateCanonicalPendingBatch(store, r.plan);
        if (!same(r.plan.binding, { accountId: r.handle.accountId, sourceId: r.handle.sourceId, destinationId: r.handle.destinationId })) fail("context");
        const old = this.read();
        if (!same(old, prior)) fail("stale");
        if (old) {
          if (old.version !== 1 || old.phase !== "terminal" || !old.terminal || !r.previousTerminal || !same(old.terminal, r.previousTerminal) ||
              !same(old.terminal, journalBefore.latestTerminal) || !same(old.cycle, r.cycle) || old.generation + 1 !== r.handle.generation ||
              !same(old.attemptedAssignmentIds, r.plan.attemptedAssignmentIds ?? [])) fail("blocked");
        } else if (r.previousTerminal || (r.plan.attemptedAssignmentIds ?? []).length) fail("blocked");
        // Only an explicitly verified terminal transition summarizes old detail.
        this.put({ version: 1, cycle: r.cycle, phase: "running", generation: r.handle.generation,
          journalPlanDigest: r.handle.planDigest, plan: r.plan, attemptedAssignmentIds: [...(old?.attemptedAssignmentIds ?? [])],
          outcomes: [], previousTerminal: old?.terminal ?? null, terminal: null });
      });
      for (const [index, operation] of r.plan.operations.entries()) {
        remainingTime();
        if (batchRequests >= r.requestBudget) fail("capacity");
        const receipt = await r.auth.withAccessToken({ expectedGeneration: r.authGeneration, journal: bridge.journal, handle: bridge.handle,
          intent: intents[index]!, nowMs: r.nowMs, minValidityMs: r.minValidityMs, use: async token => {
            if (!/^dummy-/.test(token)) fail("invalid");
            this.source(r); revalidateCanonicalPendingOperation(store, r.plan, operation);
            const transport = new SyntheticJsonTransport({ syntheticOnly: true, origin: "https://notion.invalid", fetch: guardedFetch,
              requestBudget: r.requestBudget - batchRequests, timeoutMs: r.timeoutMs, operationTimeoutMs: Math.min(r.operationTimeoutMs, remainingTime()), maxResponseBytes: r.maxResponseBytes });
            const client = createSyntheticNotionClient(transport) as unknown as Client;
            const result = Object.freeze(await upsertAssignmentPage(client, operation.row, operation.context.domain, {
              isNew: Boolean(operation.pending.is_new), revision: operation.revision, changedFields: JSON.parse(operation.pending.changed_fields),
              coursePageId: operation.context.coursePageId, courseLabel: operation.context.courseLabel, forceDetails: Boolean(operation.pending.force_details),
            }, r.plan.destinations));
            if (!/^(?:dummy-|SYNTHETIC_)[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(result.pageId) || typeof result.pushed !== "boolean" ||
                await r.verifyResult(operation, result) !== true) fail("uncertain");
            transport.assertOperationComplete();
            const id = receiptId(r.handle.generation, index, operation.requestDigest);
            await this.commit(() => {
              this.source(r); revalidateCanonicalPendingOperation(store, r.plan, operation);
              const state = this.read();
              if (!state || state.phase !== "running" || state.generation !== r.handle.generation || state.plan.planDigest !== r.plan.planDigest ||
                  state.journalPlanDigest !== r.handle.planDigest || !same(state.cycle, r.cycle) || state.outcomes.length !== index) fail("stale");
              // Full pending + full row were checked IN THIS transaction. Never
              // substitute revision-only completeProjection for this protocol.
              if (result.pushed && this.db.prepare("DELETE FROM pending_assignment_projections WHERE assignment_id=?").run(operation.assignmentId).changes !== 1) fail("stale");
              state.outcomes.push({ index, assignmentId: operation.assignmentId, revision: operation.revision, requestDigest: operation.requestDigest,
                pageId: result.pageId, pushed: result.pushed, acknowledged: result.pushed, receiptId: id, requestsUsed: transport.state().used });
              state.attemptedAssignmentIds.push(operation.assignmentId); state.attemptedAssignmentIds.sort((a, b) => a - b);
              this.put(state);
            });
            // No HTTP dispatch is possible after this point. A failed journal
            // receipt commit leaves durable ack/outcome evidence but no replay.
            transport.assertOperationComplete();
            return { receiptId: id };
          } });
        if (receipt.receiptId !== receiptId(r.handle.generation, index, operation.requestDigest)) fail("uncertain");
      }
      const checked = await r.journal.inspect();
      this.source(r);
      const evidence = this.read();
      if (!evidence || evidence.phase !== "running" || evidence.outcomes.length !== r.plan.operations.length ||
          !checked.active || checked.active.phase !== "admitted" || checked.active.generation !== r.handle.generation ||
          checked.active.planDigest !== r.handle.planDigest || checked.active.outcomes.length !== evidence.outcomes.length) fail("uncertain");
      const verifiedActive = checked.active;
      const checkCanonical = () => {
      for (const [index, outcome] of evidence.outcomes.entries()) {
        const receipt = verifiedActive.outcomes[index]!;
        if (receipt.status !== "succeeded" || receipt.receipt.receiptId !== outcome.receiptId) fail("uncertain");
        const operation = r.plan.operations[index]!;
        if (!same(store.getAssignment(operation.assignmentId), operation.row)) fail("stale");
        if (outcome.acknowledged) {
          if (store.pendingProjectionsForCourse(operation.context.courseId).some(p => p.assignment_id === operation.assignmentId)) fail("stale");
        } else revalidateCanonicalPendingOperation(store, r.plan, operation);
      }
      };
      checkCanonical();
      remainingTime();
      const terminal = await r.journal.finish(r.handle);
      await this.commit(() => {
        remainingTime(); this.source(r); checkCanonical();
        const state = this.read();
        if (!state || !same(state, evidence)) fail("stale");
        state.phase = "terminal"; state.terminal = terminal; this.put(state);
      });
      return { terminal, receiptId: `SYNTHETIC_projection_batch_${r.handle.generation}_${r.plan.planDigest}`, state: structuredClone(this.read()!) };
    } catch { this.failed = true; fail("uncertain"); }
  }
}
