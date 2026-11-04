import {
  SingleWriterJournal, type EffectReceipt, type JournalBinding, type JournalRun,
  type JournalState, type OperationIntent,
} from "./journal.js";

/** Simulation bounds with headroom; not a guarantee about provider subrequests. */
export const DUMMY_REQUEST_LIMIT = 40;
export const DUMMY_EFFECT_LIMIT = 20;

export interface DummyBatchOperation extends OperationIntent {
  /** Number of fake requests the simulator must await for this operation. */
  requestCount: number;
}

export interface DummyBatchPlan {
  mode: "dummy";
  planId: string;
  binding: JournalBinding;
  operations: DummyBatchOperation[];
}

export interface BatchCheckpoint {
  planDigest: string;
  nextIndex: number;
  generation: number;
  completedRunId: string;
}

export interface DummyBatchRequest {
  expectedGeneration: number;
  maxRequests: number;
  maxEffects: number;
  checkpoint?: BatchCheckpoint;
}

export interface DummyRequest {
  operation: Readonly<DummyBatchOperation>;
  requestIndex: number;
}

export interface DummyBatchResult {
  status: "checkpoint" | "complete";
  checkpoint: BatchCheckpoint;
  receipts: { operationId: string; receipt: EffectReceipt }[];
  requestsUsed: number;
  effectsUsed: number;
}

export class BatchError extends Error {
  constructor(readonly code: "invalid" | "budget" | "checkpoint", message: string) {
    super(message);
    this.name = "BatchError";
  }
}

function syntheticId(value: string): void {
  if (typeof value !== "string" || !/^SYNTHETIC_[A-Za-z0-9_.-]{1,80}$/.test(value)) {
    throw new BatchError("invalid", "Only bounded SYNTHETIC_ fixture identifiers are accepted");
  }
}

function integer(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new BatchError("invalid", "Integer outside supported dummy-batch bounds");
  }
}

/** Copy and validate the complete ordered plan before the first await. */
function checkedPlan(input: DummyBatchPlan): DummyBatchPlan {
  if (input.mode !== "dummy") throw new BatchError("invalid", "Only dummy plans are supported");
  syntheticId(input.planId);
  const binding = {
    accountId: input.binding.accountId,
    sourceId: input.binding.sourceId,
    destinationId: input.binding.destinationId,
  };
  Object.values(binding).forEach(syntheticId);
  if (!Array.isArray(input.operations) || input.operations.length === 0 || input.operations.length > 1_000) {
    throw new BatchError("invalid", "A dummy plan requires 1 to 1000 operations");
  }
  const ids = new Set<string>();
  const operations = input.operations.map(operation => {
    syntheticId(operation.operationId);
    syntheticId(operation.targetId);
    if (ids.has(operation.operationId)) throw new BatchError("invalid", "Operation identities must be unique across the plan");
    ids.add(operation.operationId);
    if (!["write", "refresh"].includes(operation.kind) || !/^[a-f0-9]{64}$/.test(operation.requestDigest)) {
      throw new BatchError("invalid", "Valid operation kind and request digest required");
    }
    integer(operation.requestCount, 1, DUMMY_REQUEST_LIMIT);
    return {
      operationId: operation.operationId, kind: operation.kind, targetId: operation.targetId,
      requestDigest: operation.requestDigest, requestCount: operation.requestCount,
    };
  });
  return { mode: "dummy", planId: input.planId, binding, operations };
}

async function digest(plan: DummyBatchPlan): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(plan)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

const planPrefix = (planId: string) => `SYNTHETIC_batch_${planId.length}_${planId}_`;
const runPrefix = (planId: string, planDigest: string) => `${planPrefix(planId)}${planDigest}_`;
const runId = (planId: string, planDigest: string, start: number, end: number) => `${runPrefix(planId, planDigest)}${start}_${end}`;
const receiptId = (planDigest: string, index: number) => `SYNTHETIC_receipt_${planDigest}_${index}`;

function verifyCompletedRun(run: JournalRun, plan: DummyBatchPlan, planDigest: string, start: number, end: number): void {
  if (run.status !== "succeeded" || run.completedGeneration !== run.generation + 1 ||
      run.operations.length !== end - start) {
    throw new BatchError("checkpoint", "Checkpoint requires a terminal batch with all receipts acknowledged");
  }
  for (let index = start; index < end; index++) {
    const expected = plan.operations[index]!;
    const actual = run.operations[index - start]!;
    if (actual.operationId !== expected.operationId || actual.kind !== expected.kind ||
        actual.targetId !== expected.targetId || actual.requestDigest !== expected.requestDigest ||
        actual.outcome !== "succeeded" || !actual.acknowledged || actual.receipt.receiptId !== receiptId(planDigest, index)) {
      throw new BatchError("checkpoint", "Checkpoint operations or receipts do not match the exact ordered plan");
    }
  }
}

/** Verify the full completed prefix, not just a caller-supplied cursor. */
function verifyCheckpoint(state: JournalState, plan: DummyBatchPlan, planDigest: string, checkpoint: BatchCheckpoint): number {
  if (checkpoint.planDigest !== planDigest || checkpoint.generation !== state.generation) {
    throw new BatchError("checkpoint", "Plan or checkpoint generation changed");
  }
  integer(checkpoint.nextIndex, 1, plan.operations.length);
  const batches = state.runs.filter(run => run.runId.startsWith(runPrefix(plan.planId, planDigest)))
    .sort((left, right) => left.generation - right.generation);
  let cursor = 0, completedGeneration: number | undefined;
  for (const run of batches) {
    const match = /_(\d+)_(\d+)$/.exec(run.runId);
    if (!match) throw new BatchError("checkpoint", "Invalid persisted batch identity");
    const start = Number(match[1]), end = Number(match[2]);
    if (start !== cursor || end <= start || end > plan.operations.length ||
        (completedGeneration !== undefined && run.generation !== completedGeneration)) {
      throw new BatchError("checkpoint", "Checkpoint does not describe a contiguous completed prefix");
    }
    verifyCompletedRun(run, plan, planDigest, start, end);
    cursor = end;
    completedGeneration = run.completedGeneration;
    if (run.runId === checkpoint.completedRunId) {
      if (cursor !== checkpoint.nextIndex || completedGeneration !== checkpoint.generation) {
        throw new BatchError("checkpoint", "Checkpoint cursor or generation was altered");
      }
      return cursor;
    }
  }
  throw new BatchError("checkpoint", "Checkpoint batch was not found in durable history");
}

/**
 * Execute one explicitly requested synthetic batch. Never schedules/loops into
 * the next batch and never recovers an active handle. The simulator MUST be an
 * offline fake: this port is not a production transport or a network sandbox.
 * Limits count calls to that fake port, not real provider-internal subrequests.
 * A thrown callback or storage error yields no checkpoint and no automatic retry.
 */
export async function runDummyBatch(
  journal: SingleWriterJournal,
  planInput: DummyBatchPlan,
  requestInput: DummyBatchRequest,
  simulateRequest: (request: DummyRequest) => Promise<void>,
): Promise<DummyBatchResult> {
  const plan = checkedPlan(planInput);
  const request = structuredClone(requestInput);
  integer(request.expectedGeneration, 0, Number.MAX_SAFE_INTEGER - 1);
  integer(request.maxRequests, 1, DUMMY_REQUEST_LIMIT);
  integer(request.maxEffects, 1, DUMMY_EFFECT_LIMIT);
  const planDigest = await digest(plan);
  const state = await journal.inspect();
  if (state.binding.accountId !== plan.binding.accountId || state.binding.sourceId !== plan.binding.sourceId ||
      state.binding.destinationId !== plan.binding.destinationId || state.generation !== request.expectedGeneration) {
    throw new BatchError("checkpoint", "Exact journal binding and expected generation required");
  }
  const previousBatches = state.runs.filter(run => run.runId.startsWith(planPrefix(plan.planId)));
  if (previousBatches.some(run => !run.runId.startsWith(runPrefix(plan.planId, planDigest)))) {
    throw new BatchError("checkpoint", "An existing plan identity cannot change its ordered operations or binding");
  }
  if (!request.checkpoint && previousBatches.length > 0) {
    throw new BatchError("checkpoint", "Existing plans require their verified completed checkpoint; no automatic replay");
  }
  const start = request.checkpoint ? verifyCheckpoint(state, plan, planDigest, request.checkpoint) : 0;
  if (start >= plan.operations.length) throw new BatchError("checkpoint", "Plan is already complete");

  let end = start, requestsPlanned = 0;
  while (end < plan.operations.length && end - start < request.maxEffects) {
    const cost = plan.operations[end]!.requestCount;
    if (requestsPlanned + cost > request.maxRequests) break;
    requestsPlanned += cost;
    end++;
  }
  if (end === start) throw new BatchError("budget", "Next operation does not fit; increase the explicit batch budget");

  const handle = await journal.admit({ ...plan.binding, runId: runId(plan.planId, planDigest, start, end), expectedGeneration: request.expectedGeneration });
  const receipts: DummyBatchResult["receipts"] = [];
  let requestsUsed = 0;
  for (let index = start; index < end; index++) {
    const operation = plan.operations[index]!;
    const receipt = await journal.execute(handle, operation, async () => {
      for (let requestIndex = 0; requestIndex < operation.requestCount; requestIndex++) {
        // Increment before dispatch; failed/unknown requests consume budget too.
        if (requestsUsed >= request.maxRequests) throw new BatchError("budget", "Dummy request budget exhausted");
        requestsUsed++;
        await simulateRequest({ operation: Object.freeze({ ...operation }), requestIndex });
      }
      return { receiptId: receiptId(planDigest, index) };
    });
    receipts.push({ operationId: operation.operationId, receipt });
  }
  // finish atomically marks success and advances generation only after receipts.
  // No continuation is returned until that durability acknowledgment resolves.
  const nextGeneration = await journal.finish(handle);
  return {
    status: end === plan.operations.length ? "complete" : "checkpoint",
    checkpoint: { planDigest, nextIndex: end, generation: nextGeneration, completedRunId: handle.runId },
    receipts, requestsUsed, effectsUsed: end - start,
  };
}
