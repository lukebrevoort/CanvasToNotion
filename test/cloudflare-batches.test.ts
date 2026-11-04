import assert from "node:assert/strict";
import test from "node:test";
import { SingleWriterJournal, type JournalState, type JournalStorage, type JournalTransaction } from "../src/cloudflare/journal.js";
import { BatchError, runDummyBatch, type DummyBatchPlan, type DummyRequest } from "../src/cloudflare/batches.js";

class MemoryStorage implements JournalStorage {
  state: JournalState | undefined;
  failTerminal: "before" | "after" | undefined;
  terminalGate: Promise<void> | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  transaction<T>(callback: (transaction: JournalTransaction) => T): Promise<T> {
    const pending = this.tail.then(async () => {
      let draft = structuredClone(this.state);
      const result = callback({ get: () => structuredClone(draft), put: value => { draft = structuredClone(value); } });
      const terminal = this.state?.activeRunId !== null && draft?.activeRunId === null && draft?.generation !== this.state?.generation;
      if (terminal && this.failTerminal === "before") { this.failTerminal = undefined; throw Error("synthetic terminal commit failure"); }
      this.state = draft;
      if (terminal && this.terminalGate) await this.terminalGate;
      if (terminal && this.failTerminal === "after") { this.failTerminal = undefined; throw Error("synthetic terminal response loss"); }
      return structuredClone(result);
    });
    this.tail = pending.catch(() => undefined);
    return pending;
  }
}
const scope = { accountId: "SYNTHETIC_account", sourceId: "SYNTHETIC_canvas", destinationId: "SYNTHETIC_notion" };
const plan = (costs = [2, 2, 3, 1]): DummyBatchPlan => ({
  mode: "dummy", planId: "SYNTHETIC_plan", binding: { ...scope },
  operations: costs.map((requestCount, index) => ({
    operationId: `SYNTHETIC_op${index}`, kind: index === 1 ? "refresh" : "write",
    targetId: `SYNTHETIC_target${index}`, requestDigest: String(index % 10).repeat(64), requestCount,
  })),
});
const request = { expectedGeneration: 0, maxRequests: 4, maxEffects: 2 };
const batchCode = (code: string) => (error: unknown) => error instanceof BatchError && error.code === code;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
async function fixture() {
  const storage = new MemoryStorage(), calls: DummyRequest[] = [];
  const journal = new SingleWriterJournal(storage);
  await journal.initialize(scope);
  const simulate = async (value: DummyRequest) => { calls.push(structuredClone(value)); };
  return { storage, journal, calls, simulate };
}

test("one invocation respects request/effect bounds and returns a checkpoint only after all receipts", async () => {
  const f = await fixture();
  const first = await runDummyBatch(f.journal, plan(), request, f.simulate);
  assert.equal(first.status, "checkpoint");
  assert.equal(first.checkpoint.nextIndex, 2);
  assert.equal(first.checkpoint.generation, 1);
  assert.equal(first.requestsUsed, 4);
  assert.equal(first.effectsUsed, 2);
  assert.equal(f.calls.length, 4);
  assert.ok(f.storage.state!.runs[0]!.operations.every(operation => operation.outcome === "succeeded" && operation.acknowledged));
  assert.equal(f.storage.state!.activeRunId, null);
  // No automatic second batch, even though more operations remain.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 4);
  const second = await runDummyBatch(f.journal, plan(), { ...request, expectedGeneration: 1, checkpoint: first.checkpoint }, f.simulate);
  assert.equal(second.status, "complete");
  assert.equal(second.requestsUsed, 4);
  assert.equal(second.checkpoint.nextIndex, 4);
  assert.equal(second.checkpoint.generation, 2);
  assert.equal(f.calls.length, 8);
});

test("effect cap can yield before the request cap; complete checkpoints cannot start more work", async () => {
  const f = await fixture();
  const first = await runDummyBatch(f.journal, plan([1, 1]), { ...request, maxRequests: 40, maxEffects: 1 }, f.simulate);
  assert.equal(first.effectsUsed, 1);
  const second = await runDummyBatch(f.journal, plan([1, 1]), { ...request, expectedGeneration: 1, checkpoint: first.checkpoint }, f.simulate);
  await assert.rejects(runDummyBatch(f.journal, plan([1, 1]), { ...request, expectedGeneration: 2, checkpoint: second.checkpoint }, f.simulate), /already complete/);
  assert.equal(f.calls.length, 2);
});

test("an operation that cannot fit fails before admission or fake request", async () => {
  const f = await fixture();
  await assert.rejects(runDummyBatch(f.journal, plan([5]), request, f.simulate), batchCode("budget"));
  assert.equal(f.storage.state!.runs.length, 0);
  assert.equal(f.calls.length, 0);
});

test("invalid mode, live identifiers, duplicate operations and unsafe budgets fail before admission", async () => {
  const f = await fixture();
  const invalid = plan(); invalid.operations[1]!.operationId = invalid.operations[0]!.operationId;
  for (const candidate of [invalid, { ...plan(), mode: "live" as "dummy" }, { ...plan(), binding: { ...scope, sourceId: "actual.example" } }, plan([41]), plan([])]) {
    await assert.rejects(runDummyBatch(f.journal, candidate, request, f.simulate), batchCode("invalid"));
  }
  for (const limits of [{ maxRequests: 41 }, { maxEffects: 21 }, { maxRequests: 0 }, { maxEffects: 1.5 }]) {
    await assert.rejects(runDummyBatch(f.journal, plan(), { ...request, ...limits }, f.simulate), batchCode("invalid"));
  }
  assert.equal(f.storage.state!.runs.length, 0);
  assert.equal(f.calls.length, 0);
});

test("duplicate batches cannot replay by omitting a checkpoint or changing the budget", async () => {
  const f = await fixture();
  await runDummyBatch(f.journal, plan(), request, f.simulate);
  for (const limits of [{}, { maxRequests: 40, maxEffects: 20 }]) {
    await assert.rejects(runDummyBatch(f.journal, plan(), { ...request, ...limits, expectedGeneration: 1 }, f.simulate), batchCode("checkpoint"));
  }
  assert.equal(f.calls.length, 4);
});

test("terminal checkpoints permit a fresh instance to admit the next batch, never an active recovered handle", async () => {
  const f = await fixture();
  const first = await runDummyBatch(f.journal, plan(), request, f.simulate);
  const restarted = new SingleWriterJournal(f.storage);
  await restarted.initialize(scope);
  const second = await runDummyBatch(restarted, plan(), { ...request, expectedGeneration: 1, checkpoint: first.checkpoint }, f.simulate);
  assert.equal(second.status, "complete");
  assert.equal(f.calls.length, 8);
});

test("forged cursor, run identity, digest and old generation cannot advance a batch", async () => {
  const f = await fixture();
  const first = await runDummyBatch(f.journal, plan(), request, f.simulate);
  for (const changed of [{ nextIndex: 3 }, { completedRunId: "SYNTHETIC_forged" }, { planDigest: "b".repeat(64) }, { generation: 0 }]) {
    await assert.rejects(runDummyBatch(f.journal, plan(), { ...request, expectedGeneration: 1, checkpoint: { ...first.checkpoint, ...changed } }, f.simulate), batchCode("checkpoint"));
  }
  await assert.rejects(runDummyBatch(f.journal, plan(), { ...request, checkpoint: first.checkpoint }, f.simulate), batchCode("checkpoint"));
  assert.equal(f.calls.length, 4);
});

test("changed operations, ordering or declared request costs cannot reuse a plan identity", async () => {
  const f = await fixture();
  const first = await runDummyBatch(f.journal, plan(), request, f.simulate);
  const changedTarget = plan(); changedTarget.operations[2]!.targetId = "SYNTHETIC_changed";
  const reordered = plan(); reordered.operations.reverse();
  const changedCost = plan(); changedCost.operations[2]!.requestCount = 2;
  for (const changed of [changedTarget, reordered, changedCost]) {
    for (const checkpoint of [first.checkpoint, undefined]) {
      await assert.rejects(runDummyBatch(f.journal, changed, { ...request, expectedGeneration: 1, checkpoint }, f.simulate), batchCode("checkpoint"));
    }
  }
  assert.equal(f.calls.length, 4);
});

test("plan and request are copied before awaits, and fake request descriptors are frozen", async () => {
  const f = await fixture(), mutable = plan([1, 1]), mutableRequest = { ...request, maxEffects: 1 };
  const started = runDummyBatch(f.journal, mutable, mutableRequest, async value => {
    assert.ok(Object.isFrozen(value.operation));
    await f.simulate(value);
  });
  mutable.operations[0]!.operationId = "SYNTHETIC_mutated";
  mutable.operations[1]!.requestCount = 40;
  mutableRequest.maxEffects = 20;
  const result = await started;
  assert.equal(result.effectsUsed, 1);
  assert.equal(f.calls[0]!.operation.operationId, "SYNTHETIC_op0");
});

test("checkpoint verification requires every persisted receipt, not a terminal label alone", async () => {
  const f = await fixture();
  const first = await runDummyBatch(f.journal, plan(), request, f.simulate);
  f.storage.state!.runs[0]!.operations[0] = { ...plan().operations[0]!, outcome: "uncertain", acknowledged: false };
  await assert.rejects(runDummyBatch(f.journal, plan(), { ...request, expectedGeneration: 1, checkpoint: first.checkpoint }, f.simulate), batchCode("checkpoint"));
  assert.equal(f.calls.length, 4);
});

test("unknown fake request stops the remaining batch, yields no checkpoint and blocks restart replay", async () => {
  const f = await fixture();
  await assert.rejects(runDummyBatch(f.journal, plan(), request, async value => {
    await f.simulate(value);
    if (f.calls.length === 3) throw Error("synthetic committed response loss");
  }), /reconciliation required/);
  assert.equal(f.calls.length, 3);
  assert.equal(f.storage.state!.generation, 0);
  assert.equal(f.storage.state!.runs[0]!.status, "uncertain");
  assert.equal(f.storage.state!.runs[0]!.operations[0]!.acknowledged, true);
  assert.equal(f.storage.state!.runs[0]!.operations[1]!.acknowledged, false);
  const restarted = new SingleWriterJournal(f.storage);
  await assert.rejects(runDummyBatch(restarted, plan(), request, f.simulate), batchCode("checkpoint"));
  assert.equal(f.calls.length, 3);
});

for (const failure of ["before", "after"] as const) {
  test(`terminal ${failure}-commit failure emits no checkpoint and does not authorize another batch`, async () => {
    const f = await fixture();
    f.storage.failTerminal = failure;
    await assert.rejects(runDummyBatch(f.journal, plan(), request, f.simulate), /synthetic terminal/);
    assert.equal(f.calls.length, 4);
    const restarted = new SingleWriterJournal(f.storage);
    await assert.rejects(runDummyBatch(restarted, plan(), { ...request, expectedGeneration: f.storage.state!.generation }, f.simulate), batchCode("checkpoint"));
    assert.equal(f.calls.length, 4);
  });
}

test("no checkpoint is returned until terminal durability acknowledgment settles", async () => {
  const f = await fixture(), gate = deferred<void>();
  f.storage.terminalGate = gate.promise;
  let settled = false;
  const pending = runDummyBatch(f.journal, plan(), request, f.simulate).then(result => { settled = true; return result; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  gate.resolve();
  const result = await pending;
  assert.equal(result.checkpoint.nextIndex, 2);
  assert.equal(settled, true);
});

test("racing batch contenders cannot double dispatch even with different declared budgets", async () => {
  const f = await fixture();
  const outcomes = await Promise.allSettled([
    runDummyBatch(f.journal, plan(), request, f.simulate),
    runDummyBatch(new SingleWriterJournal(f.storage), plan(), { ...request, maxEffects: 1 }, f.simulate),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === "rejected").length, 1);
  assert.ok(f.calls.length === 2 || f.calls.length === 4);
  assert.equal(f.storage.state!.runs.length, 1);
});

test("deterministic operation and batch identities survive equivalent plan copies", async () => {
  const left = await fixture(), right = await fixture();
  const a = await runDummyBatch(left.journal, plan(), request, left.simulate);
  const b = await runDummyBatch(right.journal, structuredClone(plan()), { ...request }, right.simulate);
  assert.deepEqual(a, b);
});
