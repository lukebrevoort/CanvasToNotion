import assert from "node:assert/strict";
import test from "node:test";
import {
  JournalError, SingleWriterJournal,
  type EffectReceipt, type JournalState, type JournalStorage, type JournalTransaction,
  type OperationIntent,
} from "../src/cloudflare/journal.js";

/** Synthetic durable image shared by fresh kernel instances, never real data. */
class MemoryStorage implements JournalStorage {
  durable: JournalState | undefined;
  calls = 0;
  failBefore = new Set<number>();
  failAfter = new Set<number>();
  durabilityGate: Promise<void> | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  transaction<T>(callback: (transaction: JournalTransaction) => T): Promise<T> {
    const result = this.tail.then(async () => {
      const call = ++this.calls;
      let draft = structuredClone(this.durable);
      const value = callback({
        get: () => structuredClone(draft),
        put: state => { draft = structuredClone(state); },
      });
      assert.equal(value instanceof Promise, false, "journal transaction callbacks must be synchronous");
      if (this.failBefore.delete(call)) throw new Error("synthetic durability failure before commit");
      this.durable = structuredClone(draft);
      if (this.durabilityGate) await this.durabilityGate;
      if (this.failAfter.delete(call)) throw new Error("synthetic durability response lost after commit");
      return structuredClone(value);
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}

const scope = { accountId: "dummy-account", sourceId: "canvas.invalid", destinationId: "dummy-notion-ds" };
const request = { ...scope, runId: "dummy-run", expectedGeneration: 0 };
const intent: OperationIntent = { operationId: "dummy-update", kind: "write", targetId: "dummy-page", requestDigest: "a".repeat(64) };
const receipt: EffectReceipt = { receiptId: "dummy-receipt" };
const code = (expected: string) => (error: unknown) => error instanceof JournalError && error.code === expected;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
};
async function fixture() {
  const storage = new MemoryStorage();
  const journal = new SingleWriterJournal(storage);
  await journal.initialize(scope);
  return { storage, journal };
}

test("initialization binds one account/source/destination and reopening does not reset generation", async () => {
  const { storage, journal } = await fixture();
  const handle = await journal.admit(request);
  await journal.finish(handle);
  const reopened = new SingleWriterJournal(storage);
  await reopened.initialize(scope, 0);
  assert.equal((await reopened.inspect()).generation, 1);
  for (const key of ["accountId", "sourceId", "destinationId"] as const) {
    await assert.rejects(reopened.initialize({ ...scope, [key]: "different" }), code("binding"));
  }
});

test("admission requires exact generation and source/destination/account without mutation", async () => {
  const { storage, journal } = await fixture();
  const before = structuredClone(storage.durable);
  for (const key of ["accountId", "sourceId", "destinationId"] as const) {
    await assert.rejects(journal.admit({ ...request, [key]: "different" }), code("binding"));
  }
  await assert.rejects(journal.admit({ ...request, expectedGeneration: 1 }), code("generation"));
  assert.deepEqual(storage.durable, before);
});

test("duplicate triggers and later alarms cannot replace persistent admission", async () => {
  const { storage, journal } = await fixture();
  await journal.admit(request);
  await assert.rejects(journal.admit(request), code("duplicate"));
  const restarted = new SingleWriterJournal(storage);
  await restarted.initialize(scope);
  await assert.rejects(restarted.admit({ ...request, runId: "alarm-after-arbitrary-delay" }), code("busy"));
  assert.equal((await restarted.inspect()).activeRunId, request.runId);
});

test("racing contenders across kernel instances receive exactly one admission", async () => {
  const { storage } = await fixture();
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
    new SingleWriterJournal(storage).admit({ ...request, runId: `contender-${i}` })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 19);
  assert.equal(storage.durable?.runs.length, 1);
});

test("uncertain intent is durably present before effect, receipt and ack commit together", async () => {
  const { storage, journal } = await fixture();
  const handle = await journal.admit(request);
  const result = await journal.execute(handle, intent, async () => {
    const run = storage.durable!.runs[0]!;
    assert.equal(run.status, "uncertain");
    assert.deepEqual(run.operations, [{ ...intent, outcome: "uncertain", acknowledged: false }]);
    return receipt;
  });
  assert.deepEqual(result, receipt);
  const run = (await journal.inspect()).runs[0]!;
  assert.equal(run.status, "admitted");
  assert.deepEqual(run.operations, [{ ...intent, outcome: "succeeded", acknowledged: true, receipt }]);
});

test("effect waits for durability promise rather than a buffered intent write", async () => {
  const { storage, journal } = await fixture();
  const handle = await journal.admit(request);
  const gate = deferred<void>();
  storage.durabilityGate = gate.promise;
  let effects = 0;
  const pending = journal.execute(handle, intent, async () => { effects++; return receipt; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(storage.durable?.runs[0]?.status, "uncertain");
  assert.equal(effects, 0);
  storage.durabilityGate = undefined;
  gate.resolve();
  await pending;
  assert.equal(effects, 1);
});

test("concurrent operations cannot interleave while an external effect is in flight", async () => {
  const { journal } = await fixture();
  const handle = await journal.admit(request);
  const started = deferred<void>(), finish = deferred<EffectReceipt>();
  let effects = 0;
  const pending = journal.execute(handle, intent, async () => { effects++; started.resolve(); return finish.promise; });
  await started.promise;
  await assert.rejects(journal.execute(handle, intent, async () => { effects++; return receipt; }), code("uncertain"));
  await assert.rejects(journal.execute(handle, { ...intent, operationId: "second" }, async () => { effects++; return receipt; }), code("uncertain"));
  await assert.rejects(journal.finish(handle), code("uncertain"));
  await assert.rejects(journal.admit({ ...request, runId: "racing-alarm" }), code("uncertain"));
  finish.resolve(receipt);
  await pending;
  assert.equal(effects, 1);
});

for (const kind of ["write", "refresh"] as const) {
  test(`${kind} unknown response persists quarantine across restart without replay or secret retention`, async () => {
    const { storage, journal } = await fixture();
    const handle = await journal.admit(request);
    let effects = 0;
    const operation = { ...intent, kind };
    await assert.rejects(journal.execute(handle, operation, async () => {
      effects++;
      throw new Error("DUMMY_SECRET_SHOULD_NOT_BE_SAVED response lost");
    }), code("uncertain"));
    const restarted = new SingleWriterJournal(storage);
    await restarted.initialize(scope);
    await assert.rejects(restarted.execute(handle, operation, async () => { effects++; return receipt; }), code("uncertain"));
    await assert.rejects(restarted.admit({ ...request, runId: "alarm-retry" }), code("uncertain"));
    await assert.rejects(restarted.finish(handle), code("uncertain"));
    assert.equal(effects, 1);
    assert.equal(JSON.stringify(await restarted.inspect()).includes("DUMMY_SECRET"), false);
  });

  test(`${kind} remote success followed by receipt commit failure stays blocked`, async () => {
    const { storage, journal } = await fixture();
    const handle = await journal.admit(request);
    let effects = 0;
    storage.failBefore.add(storage.calls + 2); // Intent commits; receipt transaction fails.
    await assert.rejects(journal.execute(handle, { ...intent, kind }, async () => { effects++; return receipt; }), code("uncertain"));
    const restarted = new SingleWriterJournal(storage);
    await assert.rejects(restarted.execute(handle, { ...intent, kind }, async () => { effects++; return receipt; }), code("uncertain"));
    assert.equal((await restarted.inspect()).runs[0]!.operations[0]!.acknowledged, false);
    assert.equal(effects, 1);
  });
}

test("uncertain intent commit response prevents dispatch and blocks restart without timeout takeover", async () => {
  const { storage, journal } = await fixture();
  const handle = await journal.admit(request);
  storage.failAfter.add(storage.calls + 1);
  let effects = 0;
  await assert.rejects(journal.execute(handle, intent, async () => { effects++; return receipt; }), /after commit/);
  assert.equal(effects, 0);
  const restarted = new SingleWriterJournal(storage);
  await assert.rejects(restarted.execute(handle, intent, async () => { effects++; return receipt; }), code("uncertain"));
  await assert.rejects(restarted.admit({ ...request, runId: "next-day-alarm" }), code("uncertain"));
  assert.equal(effects, 0);
});

test("failed intent persistence never dispatches the external effect", async () => {
  const { storage, journal } = await fixture();
  const handle = await journal.admit(request);
  storage.failBefore.add(storage.calls + 1);
  let effects = 0;
  await assert.rejects(journal.execute(handle, intent, async () => { effects++; return receipt; }), /before commit/);
  assert.equal(effects, 0);
  assert.deepEqual(storage.durable!.runs[0]!.operations, []);
});

test("lost receipt commit response is observed on retry without redispatch", async () => {
  const { storage, journal } = await fixture();
  const handle = await journal.admit(request);
  storage.failAfter.add(storage.calls + 2);
  let effects = 0;
  await assert.rejects(journal.execute(handle, intent, async () => { effects++; return receipt; }), code("uncertain"));
  const restarted = new SingleWriterJournal(storage);
  assert.deepEqual(await restarted.execute(handle, intent, async () => { effects++; return receipt; }), receipt);
  assert.equal(effects, 1);
  await assert.rejects(restarted.finish(handle), code("inactive"));
});

test("completed operation returns only its receipt, rejects changed request, and never repeats effect", async () => {
  const { journal } = await fixture();
  const handle = await journal.admit(request);
  let effects = 0;
  await journal.execute(handle, intent, async () => { effects++; return { ...receipt, ignoredSecret: "DUMMY_SECRET" }; });
  assert.deepEqual(await journal.execute(handle, intent, async () => { effects++; return receipt; }), receipt);
  for (const changed of [{ targetId: "other-page" }, { kind: "refresh" as const }, { requestDigest: "b".repeat(64) }]) {
    await assert.rejects(journal.execute(handle, { ...intent, ...changed }, async () => { effects++; return receipt; }), code("conflict"));
  }
  assert.equal(effects, 1);
  assert.equal(JSON.stringify(await journal.inspect()).includes("DUMMY_SECRET"), false);
});

test("terminal success advances generation once, preserves history and rejects stale execution", async () => {
  const { journal } = await fixture();
  const handle = await journal.admit(request);
  await journal.execute(handle, intent, async () => receipt);
  assert.equal(await journal.finish(handle), 1);
  assert.equal(await journal.finish(handle), 1);
  await assert.rejects(journal.admit({ ...request, runId: "new-run" }), code("generation"));
  await assert.rejects(journal.admit({ ...request, expectedGeneration: 1 }), code("duplicate"));
  await assert.rejects(journal.execute(handle, intent, async () => receipt), code("generation"));
  const next = await journal.admit({ ...request, runId: "next-run", expectedGeneration: 1 });
  assert.equal(next.generation, 1);
  const state = await journal.inspect();
  assert.equal(state.runs[0]!.status, "succeeded");
  assert.equal(state.runs[0]!.operations[0]!.acknowledged, true);
  assert.equal(state.activeRunId, "next-run");
});

test("invalid or unbound calls fail before effect and receipt validation retains uncertainty", async () => {
  const { journal } = await fixture();
  const handle = await journal.admit(request);
  let effects = 0;
  await assert.rejects(journal.execute({ ...handle, destinationId: "wrong" }, intent, async () => { effects++; return receipt; }), code("binding"));
  await assert.rejects(journal.execute(handle, { ...intent, requestDigest: "not-a-digest" }, async () => { effects++; return receipt; }), code("invalid"));
  assert.equal(effects, 0);
  await assert.rejects(journal.execute(handle, intent, async () => { effects++; return { receiptId: "" }; }), code("uncertain"));
  assert.equal((await journal.inspect()).runs[0]!.status, "uncertain");
});


test("receipt durability rejection quarantines new dispatch even if the receipt later appears persisted", async () => {
  const { storage, journal } = await fixture();
  const handle = await journal.admit(request);
  storage.failAfter.add(storage.calls + 2);
  let effects = 0;
  await assert.rejects(journal.execute(handle, intent, async () => { effects++; return receipt; }), code("uncertain"));
  // A proven persisted receipt may be observed, but does not silently resume work.
  assert.deepEqual(await journal.execute(handle, intent, async () => { effects++; return receipt; }), receipt);
  await assert.rejects(journal.execute(handle, { ...intent, operationId: "next-operation" }, async () => { effects++; return receipt; }), code("uncertain"));
  await assert.rejects(journal.finish(handle), code("uncertain"));
  const restarted = new SingleWriterJournal(storage);
  await assert.rejects(restarted.execute(handle, { ...intent, operationId: "next-operation" }, async () => { effects++; return receipt; }), code("inactive"));
  await assert.rejects(restarted.admit({ ...request, runId: "new-trigger" }), code("busy"));
  assert.equal(effects, 1);
});

test("reconstruction cannot dispatch from an admitted handle with no operation intent", async () => {
  const { storage, journal } = await fixture();
  const handle = await journal.admit(request);
  const restarted = new SingleWriterJournal(storage);
  let effects = 0;
  await assert.rejects(restarted.execute(handle, intent, async () => { effects++; return receipt; }), code("inactive"));
  await assert.rejects(restarted.finish(handle), code("inactive"));
  assert.equal(effects, 0);
});


test("lost terminal commit response quarantines the original instance instead of admitting more work", async () => {
  const { storage, journal } = await fixture();
  const handle = await journal.admit(request);
  await journal.execute(handle, intent, async () => receipt);
  storage.failAfter.add(storage.calls + 1);
  await assert.rejects(journal.finish(handle), /after commit/);
  assert.equal((await journal.inspect()).generation, 1);
  // Re-reading a terminal result is safe, but does not lift local quarantine.
  assert.equal(await journal.finish(handle), 1);
  await assert.rejects(journal.admit({ ...request, runId: "next", expectedGeneration: 1 }), code("uncertain"));
});

test("initialization and admission storage failures quarantine the instance without reset", async () => {
  const storage = new MemoryStorage();
  const journal = new SingleWriterJournal(storage);
  storage.failAfter.add(1);
  await assert.rejects(journal.initialize(scope), /after commit/);
  await assert.rejects(journal.admit(request), code("uncertain"));
  const restarted = new SingleWriterJournal(storage);
  await restarted.initialize(scope);
  storage.failAfter.add(storage.calls + 1);
  await assert.rejects(restarted.admit(request), /after commit/);
  await assert.rejects(restarted.admit({ ...request, runId: "another" }), code("uncertain"));
  assert.equal(storage.durable!.activeRunId, request.runId);
});

test("auth preflight verifies local admission without issuing or clearing work", async () => {
  const {storage,journal}=await fixture(); const handle=await journal.admit(request);
  const before=await journal.inspect(); await journal.assertOwnedAdmission(handle);
  assert.deepEqual(await journal.inspect(),before);
  await assert.rejects(new SingleWriterJournal(storage).assertOwnedAdmission(handle),code("inactive"));
  await assert.rejects(journal.assertOwnedAdmission({...handle,generation:1}),code("generation"));
  await journal.execute(handle,intent,async()=>receipt); await journal.assertOwnedAdmission(handle);
  await journal.finish(handle); await assert.rejects(journal.assertOwnedAdmission(handle));
});
test("uncertain journal forbids auth freshness preflight", async () => {
  const {journal}=await fixture(); const handle=await journal.admit(request);
  await assert.rejects(journal.execute(handle,intent,async()=>{throw Error("dummy lost receipt");}));
  await assert.rejects(journal.assertOwnedAdmission(handle),code("uncertain"));
});
