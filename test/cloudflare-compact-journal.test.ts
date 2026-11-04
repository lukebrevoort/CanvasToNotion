import assert from "node:assert/strict";
import test from "node:test";
import {
  CompactJournalError, CompactSyntheticJournal, compactTriggerId, compactPlanDigest,
  type CompactState, type CompactStorage, type CompactTransaction, type CompactOperation,
} from "../src/cloudflare/compact-journal.js";

class MemoryStorage implements CompactStorage {
  state: CompactState | undefined;
  calls = 0;
  failBefore = new Set<number>();
  failAfter = new Set<number>();
  private tail: Promise<unknown> = Promise.resolve();
  transaction<T>(callback: (transaction: CompactTransaction) => T): Promise<T> {
    const pending = this.tail.then(() => {
      const call = ++this.calls;
      let draft = structuredClone(this.state);
      const value = callback({ get: () => structuredClone(draft), put: state => { draft = structuredClone(state); } });
      assert.equal(value instanceof Promise, false);
      if (this.failBefore.delete(call)) throw Error("synthetic before-commit failure");
      this.state = draft;
      if (this.failAfter.delete(call)) throw Error("synthetic after-commit response loss");
      return structuredClone(value);
    });
    this.tail = pending.catch(() => undefined);
    return pending;
  }
}
const binding = { accountId: "SYNTHETIC_account", sourceId: "SYNTHETIC_source", destinationId: "SYNTHETIC_destination" };
const plan = (): CompactOperation[] => [{ kind: "write", targetId: "SYNTHETIC_target", requestDigest: "a".repeat(64) }];
const request = (generation: number, operations = plan()) => ({ ...binding, expectedGeneration: generation, triggerId: compactTriggerId(generation), plan: operations });
const code = (expected: string) => (error: unknown) => error instanceof CompactJournalError && error.code === expected;
async function fixture() {
  const storage = new MemoryStorage(), journal = new CompactSyntheticJournal(storage);
  await journal.initialize(binding);
  return { storage, journal };
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

test("fresh V2 refuses foreign/V1 stores instead of pruning or migrating their history", async () => {
  const storage = new MemoryStorage();
  const legacy = { schemaVersion: 1, binding, runs: [{ id: "old-history", data: "preserve" }] };
  storage.state = structuredClone(legacy) as unknown as CompactState;
  await assert.rejects(new CompactSyntheticJournal(storage).initialize(binding), code("version"));
  assert.deepEqual(storage.state, legacy);
});

test("10001 completed generations stay bounded while stale and reordered triggers remain rejected", async () => {
  const { storage, journal } = await fixture();
  let effects = 0, firstBytes = 0, peakBytes = 0, priorRoot = "0".repeat(64);
  const samples = new Map<number, ReturnType<typeof request>>();
  for (let generation = 0; generation < 10_001; generation++) {
    const trigger = request(generation);
    if ([0, 1, 10, 100, 1_000, 9_999].includes(generation)) samples.set(generation, structuredClone(trigger));
    const handle = await journal.admit(trigger);
    await journal.execute(handle, 0, async () => { effects++; return { receiptId: "SYNTHETIC_receipt" }; });
    const terminal = await journal.finish(handle);
    assert.notEqual(terminal.rootDigest, priorRoot);
    priorRoot = terminal.rootDigest;
    const bytes = new TextEncoder().encode(JSON.stringify(storage.state)).byteLength;
    if (generation === 0) firstBytes = bytes;
    peakBytes = Math.max(peakBytes, bytes);
    assert.equal(storage.state!.active, null);
  }
  assert.equal(storage.state!.generation, 10_001);
  assert.equal(storage.state!.latestTerminal!.generation, 10_000);
  assert.equal(effects, 10_001);
  assert.ok(peakBytes <= firstBytes + 64, `bounded size: first=${firstBytes}, peak=${peakBytes}`);
  assert.ok(peakBytes < 2_000);
  const restarted = new CompactSyntheticJournal(storage);
  for (const old of samples.values()) await assert.rejects(restarted.admit(old), code("generation"));
  await assert.rejects(restarted.admit(request(10_002)), code("generation"));
  await assert.rejects(restarted.admit({ ...request(10_001), triggerId: compactTriggerId(0) }), code("generation"));
  assert.equal(effects, 10_001);
});

test("generation-derived identity and immutable bounded plan replace arbitrary run IDs", async () => {
  const { storage, journal } = await fixture();
  await assert.rejects(journal.admit({ ...request(0), triggerId: "SYNTHETIC_arbitrary" }), code("generation"));
  await assert.rejects(journal.admit(request(0, Array.from({ length: 21 }, () => plan()[0]!))), code("invalid"));
  const mutable = request(0);
  const pending = journal.admit(mutable);
  mutable.plan[0]!.targetId = "SYNTHETIC_mutated";
  const handle = await pending;
  assert.equal(storage.state!.active!.plan[0]!.targetId, "SYNTHETIC_target");
  await journal.execute(handle, 0, async operation => {
    assert.ok(Object.isFrozen(operation));
    assert.equal(operation.targetId, "SYNTHETIC_target");
    return { receiptId: "SYNTHETIC_receipt" };
  });
  const calls = storage.calls;
  assert.deepEqual(await journal.execute(handle, 0, async () => { throw Error("must not dispatch"); }), { receiptId: "SYNTHETIC_receipt" });
  assert.ok(storage.calls > calls);
});

test("partial plans cannot finalize, skip operations or overlap uncertain effects", async () => {
  const { journal } = await fixture();
  const handle = await journal.admit(request(0, [...plan(), { ...plan()[0]!, kind: "refresh" }]));
  await assert.rejects(journal.finish(handle), code("incomplete"));
  await assert.rejects(journal.execute(handle, 1, async () => ({ receiptId: "SYNTHETIC_late" })), code("incomplete"));
  const started = deferred(), complete = deferred();
  const running = journal.execute(handle, 0, async () => { started.resolve(); await complete.promise; return { receiptId: "SYNTHETIC_first" }; });
  await started.promise;
  await assert.rejects(journal.execute(handle, 1, async () => ({ receiptId: "SYNTHETIC_second" })), code("uncertain"));
  await assert.rejects(journal.finish(handle), code("uncertain"));
  complete.resolve();
  await running;
  await assert.rejects(journal.finish(handle), code("incomplete"));
  await journal.execute(handle, 1, async () => ({ receiptId: "SYNTHETIC_second" }));
  assert.equal((await journal.finish(handle)).generation, 0);
});

for (const kind of ["write", "refresh"] as const) {
  test(`uncertain ${kind} evidence never compacts and survives reconstruction`, async () => {
    const { storage, journal } = await fixture();
    const handle = await journal.admit(request(0, [{ ...plan()[0]!, kind }]));
    let effects = 0;
    await assert.rejects(journal.execute(handle, 0, async () => { effects++; throw Error("synthetic remote loss"); }), code("uncertain"));
    const before = structuredClone(storage.state);
    const restarted = new CompactSyntheticJournal(storage);
    await assert.rejects(restarted.finish(handle));
    await assert.rejects(restarted.admit(request(0)), code("uncertain"));
    await assert.rejects(restarted.execute(handle, 0, async () => { effects++; return { receiptId: "SYNTHETIC_retry" }; }), code("uncertain"));
    assert.deepEqual(storage.state, before);
    assert.equal(storage.state!.active!.plan.length, 1);
    assert.equal(storage.state!.active!.outcomes[0]!.status, "uncertain");
    assert.equal(storage.state!.latestTerminal, null);
    assert.equal(effects, 1);
  });
}

test("remote success then receipt commit failure keeps the complete active evidence", async () => {
  const { storage, journal } = await fixture();
  const handle = await journal.admit(request(0));
  storage.failBefore.add(storage.calls + 2);
  let effects = 0;
  await assert.rejects(journal.execute(handle, 0, async () => { effects++; return { receiptId: "SYNTHETIC_receipt" }; }), code("uncertain"));
  assert.equal(storage.state!.active!.outcomes[0]!.status, "uncertain");
  await assert.rejects(new CompactSyntheticJournal(storage).execute(handle, 0, async () => { effects++; return { receiptId: "SYNTHETIC_duplicate" }; }), code("uncertain"));
  assert.equal(effects, 1);
});

test("lost receipt commit response permits receipt observation but not recovered dispatch or compaction", async () => {
  const { storage, journal } = await fixture();
  const handle = await journal.admit(request(0, [...plan(), plan()[0]!]));
  storage.failAfter.add(storage.calls + 2);
  let effects = 0;
  await assert.rejects(journal.execute(handle, 0, async () => { effects++; return { receiptId: "SYNTHETIC_receipt" }; }), code("uncertain"));
  const restarted = new CompactSyntheticJournal(storage);
  assert.deepEqual(await restarted.execute(handle, 0, async () => { effects++; return { receiptId: "SYNTHETIC_duplicate" }; }), { receiptId: "SYNTHETIC_receipt" });
  await assert.rejects(restarted.execute(handle, 1, async () => { effects++; return { receiptId: "SYNTHETIC_next" }; }), code("inactive"));
  await assert.rejects(restarted.finish(handle), code("inactive"));
  assert.equal(storage.state!.active!.plan.length, 2);
  assert.equal(effects, 1);
});

test("unknown intent commit acknowledgment causes no dispatch and retains its fence", async () => {
  const { storage, journal } = await fixture();
  const handle = await journal.admit(request(0));
  storage.failAfter.add(storage.calls + 1);
  let effects = 0;
  await assert.rejects(journal.execute(handle, 0, async () => { effects++; return { receiptId: "SYNTHETIC_receipt" }; }), /after-commit/);
  assert.equal(effects, 0);
  assert.equal(storage.state!.active!.phase, "uncertain");
  await assert.rejects(new CompactSyntheticJournal(storage).admit(request(0)), code("uncertain"));
});

test("failed final root commit keeps all finalizing evidence without automatic takeover", async () => {
  const { storage, journal } = await fixture();
  const handle = await journal.admit(request(0));
  await journal.execute(handle, 0, async () => ({ receiptId: "SYNTHETIC_receipt" }));
  storage.failBefore.add(storage.calls + 2);
  await assert.rejects(journal.finish(handle), code("uncertain"));
  assert.equal(storage.state!.active!.phase, "finalizing");
  assert.equal(storage.state!.active!.outcomes[0]!.status, "succeeded");
  assert.equal(storage.state!.generation, 0);
  assert.equal(storage.state!.latestTerminal, null);
  await assert.rejects(new CompactSyntheticJournal(storage).admit(request(0)), code("uncertain"));
});

test("lost final terminal acknowledgment does not replay old generation and exposes only compact proof", async () => {
  const { storage, journal } = await fixture();
  const handle = await journal.admit(request(0));
  await journal.execute(handle, 0, async () => ({ receiptId: "SYNTHETIC_receipt" }));
  storage.failAfter.add(storage.calls + 2);
  await assert.rejects(journal.finish(handle), code("uncertain"));
  assert.equal(storage.state!.generation, 1);
  assert.equal(storage.state!.active, null);
  assert.equal(JSON.stringify(storage.state).includes("SYNTHETIC_receipt\""), false);
  await assert.rejects(journal.admit(request(1)), code("uncertain"));
  const restarted = new CompactSyntheticJournal(storage);
  await assert.rejects(restarted.admit(request(0)), code("generation"));
  const next = await restarted.admit(request(1));
  assert.equal(next.generation, 1);
});

test("racing same-generation plans yield only one durable owner", async () => {
  const { storage } = await fixture();
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => new CompactSyntheticJournal(storage).admit(request(0))));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 9);
});

test("maximum plan remains bounded and generation exhaustion never wraps into old identities", async () => {
  const { storage, journal } = await fixture();
  storage.state!.generation = Number.MAX_SAFE_INTEGER - 1;
  const operations = Array.from({ length: 20 }, () => ({ kind: "write" as const, targetId: `SYNTHETIC_${"a".repeat(180)}`, requestDigest: "f".repeat(64) }));
  const handle = await journal.admit(request(Number.MAX_SAFE_INTEGER - 1, operations));
  for (let i = 0; i < 20; i++) await journal.execute(handle, i, async () => ({ receiptId: `SYNTHETIC_${"b".repeat(180)}` }));
  assert.ok(new TextEncoder().encode(JSON.stringify(storage.state)).byteLength < 32_768);
  await journal.finish(handle);
  assert.equal((await journal.inspect()).generation, Number.MAX_SAFE_INTEGER);
  await assert.rejects(journal.admit({ ...binding, expectedGeneration: Number.MAX_SAFE_INTEGER, triggerId: "SYNTHETIC_exhausted", plan: plan() }), code("generation"));
});


test("zero-effect polls can checkpoint without inventing an external write", async () => {
  const { storage, journal } = await fixture();
  const handle = await journal.admit(request(0, []));
  await assert.rejects(journal.execute(handle, 0, async () => { throw Error("no effect may run"); }), code("invalid"));
  const terminal = await journal.finish(handle);
  assert.equal(terminal.generation, 0);
  assert.equal(storage.state!.generation, 1);
  assert.equal(storage.state!.active, null);
  await assert.rejects(journal.admit(request(0, [])), code("generation"));
});


test("canonical plan identity binds scope, generation and ordered operation contents", async () => {
  const operations = [...plan(), { ...plan()[0]!, kind: "refresh" as const }];
  const expected = await compactPlanDigest(binding, 0, operations);
  assert.equal(await compactPlanDigest({ ...binding }, 0, structuredClone(operations)), expected);
  assert.notEqual(await compactPlanDigest(binding, 1, operations), expected);
  assert.notEqual(await compactPlanDigest({ ...binding, sourceId: "SYNTHETIC_other" }, 0, operations), expected);
  assert.notEqual(await compactPlanDigest(binding, 0, [...operations].reverse()), expected);
  const { journal } = await fixture();
  assert.equal((await journal.admit(request(0, operations))).planDigest, expected);
});

test("owned admission assertion is read-only and rejects recovered, foreign and uncertain handles", async () => {
  const { storage, journal } = await fixture();
  const handle = await journal.admit(request(0));
  const before = structuredClone(storage.state);
  await journal.assertOwnedAdmission(handle);
  assert.deepEqual(storage.state, before);
  await assert.rejects(new CompactSyntheticJournal(storage).assertOwnedAdmission(handle), code("inactive"));
  await assert.rejects(journal.assertOwnedAdmission({ ...handle, destinationId: "SYNTHETIC_other" }), code("binding"));
  await assert.rejects(journal.execute(handle, 0, async () => { throw Error("synthetic loss"); }), code("uncertain"));
  await assert.rejects(journal.assertOwnedAdmission(handle), code("uncertain"));
});
