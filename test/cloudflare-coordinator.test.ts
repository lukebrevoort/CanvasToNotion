import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { SyntheticCoordinator, CoordinatorError, type CoordinatorReceipt, type CoordinatorState, type ReadinessReference } from "../src/cloudflare/coordinator.js";
import type { DurableSqlStorage } from "../src/cloudflare/sqlite-storage.js";

const binding = { accountId: "SYNTHETIC_account", sourceId: "SYNTHETIC_canvas", destinationId: "SYNTHETIC_notion" };
const initial: ReadinessReference = { artifactId: "SYNTHETIC_import", artifactDigest: "a".repeat(64), cursorId: "SYNTHETIC_start", journalGeneration: 0 };
const next: ReadinessReference = { ...initial, cursorId: "SYNTHETIC_batch1", journalGeneration: 1 };
const later: ReadinessReference = { ...initial, cursorId: "SYNTHETIC_batch2", journalGeneration: 2 };
const receipt = (suffix = "import"): CoordinatorReceipt => ({ receiptId: `SYNTHETIC_receipt_${suffix}`, componentReceiptIds: [`SYNTHETIC_component_${suffix}`] });
const rejected = (expected: string) => (error: unknown) => error instanceof CoordinatorError && error.code === expected;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
function fixture() {
  const db = new Database(":memory:");
  const controls = {
    sync: async () => {},
    verify: async (_reference: ReadinessReference, _receipt: CoordinatorReceipt) => true,
    failTransaction: false,
  };
  const verifications: { reference: ReadinessReference; receipt: CoordinatorReceipt }[] = [];
  const storage: DurableSqlStorage = {
    sql: { exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string, ...bindings: (string | number | null)[]) {
      const statement = db.prepare(query);
      const rows = statement.reader ? statement.all(...bindings) : (statement.run(...bindings), []);
      return { toArray: () => rows as T[] };
    } },
    transactionSync: callback => {
      if (controls.failTransaction) { controls.failTransaction = false; throw Error("synthetic transaction failure"); }
      return db.transaction(callback)();
    },
    sync: () => controls.sync(),
  };
  const create = (scope = binding) => new SyntheticCoordinator(storage, scope, async (reference, receipt) => {
    verifications.push(structuredClone({ reference, receipt }));
    return controls.verify(reference, receipt);
  });
  const raw = () => JSON.parse((db.prepare("SELECT document FROM synthetic_coordinator_v1 WHERE slot=1").get() as { document: string }).document) as CoordinatorState;
  return { db, controls, create, raw, verifications, gate: create() };
}
async function ready(f: ReturnType<typeof fixture>) {
  await f.gate.initialize();
  return f.gate.importArtifact({ operationId: "SYNTHETIC_import_op", reference: initial }, async () => receipt());
}

test("aggregate import and run persist non-ready admission before callbacks and verify all receipts", async () => {
  const f = fixture();
  try {
    await f.gate.initialize();
    await f.gate.importArtifact({ operationId: "SYNTHETIC_import_op", reference: initial }, async () => {
      assert.equal(f.raw().phase, "importing");
      return receipt();
    });
    const result = await f.gate.run({ operationId: "SYNTHETIC_run", expected: initial, next }, async () => {
      assert.equal(f.raw().phase, "running");
      return receipt("run");
    });
    assert.deepEqual(result, { reference: next, receipt: receipt("run") });
    assert.deepEqual(f.verifications.map(value => value.reference), [initial, initial, next]);
    assert.equal(f.raw().phase, "ready");
    assert.deepEqual(f.raw().completedOperationIds, ["SYNTHETIC_import_op", "SYNTHETIC_run"]);
  } finally { f.db.close(); }
});

test("separate ready component rows cannot bypass an empty aggregate gate", async () => {
  const f = fixture();
  try {
    await f.gate.initialize();
    f.db.exec("CREATE TABLE synthetic_component_ready (ready INTEGER); INSERT INTO synthetic_component_ready VALUES (1)");
    let calls = 0;
    await assert.rejects(f.gate.run({ operationId: "SYNTHETIC_bypass", expected: initial, next }, async () => { calls++; return receipt(); }), rejected("not_ready"));
    assert.equal(calls, 0);
    assert.equal(f.verifications.length, 0);
    assert.equal(f.raw().phase, "empty");
  } finally { f.db.close(); }
});

test("delayed admission sync holds all callbacks and serial local operations", async () => {
  const f = fixture(), wait = deferred();
  try {
    await f.gate.initialize();
    let first = true, calls = 0;
    f.controls.sync = async () => { if (first) { first = false; await wait.promise; } };
    const importing = f.gate.importArtifact({ operationId: "SYNTHETIC_import_op", reference: initial }, async () => { calls++; return receipt(); });
    const duplicate = f.gate.importArtifact({ operationId: "SYNTHETIC_other", reference: initial }, async () => { calls++; return receipt(); });
    const outcomes = Promise.allSettled([importing, duplicate]);
    await tick();
    assert.equal(f.raw().phase, "importing");
    assert.equal(calls, 0);
    wait.resolve();
    assert.deepEqual((await outcomes).map(outcome => outcome.status), ["fulfilled", "rejected"]);
    assert.equal(calls, 1);
  } finally { f.db.close(); }
});

test("failed admission sync never calls components and reconstruction cannot clear importing", async () => {
  const f = fixture();
  try {
    await f.gate.initialize();
    f.controls.sync = async () => { throw Error("synthetic sync failure"); };
    let calls = 0;
    await assert.rejects(f.gate.importArtifact({ operationId: "SYNTHETIC_import_op", reference: initial }, async () => { calls++; return receipt(); }), /sync failure/);
    f.controls.sync = async () => {};
    const restarted = f.create();
    await restarted.initialize();
    await assert.rejects(restarted.importArtifact({ operationId: "SYNTHETIC_new_import", reference: initial }, async () => { calls++; return receipt(); }), rejected("not_ready"));
    await assert.rejects(restarted.run({ operationId: "SYNTHETIC_new_run", expected: initial, next }, async () => { calls++; return receipt(); }), rejected("not_ready"));
    assert.equal(calls, 0);
    assert.equal(f.raw().phase, "importing");
  } finally { f.db.close(); }
});

test("unknown import outcome keeps durable uncertainty without exposing failure contents", async () => {
  const f = fixture();
  try {
    await f.gate.initialize();
    let calls = 0;
    await assert.rejects(f.gate.importArtifact({ operationId: "SYNTHETIC_import_op", reference: initial }, async () => {
      calls++; throw Error("SYNTHETIC_PRIVATE_RESPONSE_BODY");
    }), rejected("uncertain"));
    assert.equal(f.raw().phase, "uncertain");
    assert.equal(JSON.stringify(f.raw()).includes("PRIVATE_RESPONSE"), false);
    const restarted = f.create();
    await restarted.initialize();
    await assert.rejects(restarted.importArtifact({ operationId: "SYNTHETIC_retry", reference: initial }, async () => { calls++; return receipt(); }), rejected("not_ready"));
    assert.equal(calls, 1);
  } finally { f.db.close(); }
});

test("active or uncertain underlying journal evidence blocks run before its callback", async () => {
  const f = fixture();
  try {
    await ready(f);
    f.controls.verify = async () => false; // E.g. journal has active/uncertain work.
    let calls = 0;
    await assert.rejects(f.create().run({ operationId: "SYNTHETIC_run", expected: initial, next }, async () => { calls++; return receipt("run"); }), rejected("uncertain"));
    assert.equal(calls, 0);
    assert.equal(f.raw().phase, "uncertain");
  } finally { f.db.close(); }
});

test("component receipt failure after callback never publishes aggregate ready", async () => {
  const f = fixture();
  try {
    await ready(f);
    f.controls.verify = async reference => reference.journalGeneration === 0;
    await assert.rejects(f.gate.run({ operationId: "SYNTHETIC_run", expected: initial, next }, async () => receipt("run")), rejected("uncertain"));
    assert.equal(f.raw().phase, "uncertain");
    assert.deepEqual(f.raw().reference, initial);
    assert.deepEqual(f.raw().pendingReference, next);
    assert.equal(f.raw().completedOperationIds.includes("SYNTHETIC_run"), false);
  } finally { f.db.close(); }
});

test("callback response loss blocks current and reconstructed coordinators", async () => {
  const f = fixture();
  try {
    await ready(f);
    let calls = 0;
    await assert.rejects(f.gate.run({ operationId: "SYNTHETIC_run", expected: initial, next }, async () => {
      calls++; throw Error("synthetic remote response loss");
    }), rejected("uncertain"));
    for (const gate of [f.gate, f.create()]) {
      await assert.rejects(gate.run({ operationId: "SYNTHETIC_retry", expected: initial, next }, async () => { calls++; return receipt("retry"); }));
    }
    assert.equal(calls, 1);
  } finally { f.db.close(); }
});

test("failed final ready transaction leaves its prior durable non-ready intent", async () => {
  const f = fixture();
  try {
    await f.gate.initialize();
    await assert.rejects(f.gate.importArtifact({ operationId: "SYNTHETIC_import_op", reference: initial }, async () => {
      f.controls.failTransaction = true;
      return receipt();
    }), rejected("uncertain"));
    assert.equal(f.raw().phase, "importing");
    await assert.rejects(f.create().run({ operationId: "SYNTHETIC_run", expected: initial, next }, async () => receipt("run")), rejected("not_ready"));
  } finally { f.db.close(); }
});

test("lost final ready acknowledgment allows only reverified terminal evidence and never duplicate operation replay", async () => {
  const f = fixture();
  try {
    await ready(f);
    let calls = 0;
    f.controls.sync = async () => { if (f.raw().phase === "ready") throw Error("synthetic final response lost"); };
    await assert.rejects(f.gate.run({ operationId: "SYNTHETIC_run", expected: initial, next }, async () => { calls++; return receipt("run"); }), rejected("uncertain"));
    assert.equal(f.raw().phase, "ready");
    assert.deepEqual(f.raw().reference, next);
    f.controls.sync = async () => {};
    await assert.rejects(f.gate.run({ operationId: "SYNTHETIC_next", expected: next, next: later }, async () => { calls++; return receipt("next"); }), rejected("uncertain"));
    const restarted = f.create();
    await assert.rejects(restarted.run({ operationId: "SYNTHETIC_run", expected: next, next: later }, async () => { calls++; return receipt("duplicate"); }), rejected("duplicate"));
    const verifiedBefore = f.verifications.length;
    await restarted.run({ operationId: "SYNTHETIC_next", expected: next, next: later }, async () => { calls++; return receipt("next"); });
    assert.deepEqual(f.verifications.slice(verifiedBefore).map(value => value.reference), [next, later]);
    assert.equal(calls, 2);
  } finally { f.db.close(); }
});

test("delayed final readiness acknowledgment never releases a pending result", async () => {
  const f = fixture(), wait = deferred();
  try {
    await f.gate.initialize();
    f.controls.sync = async () => { if (f.raw().phase === "ready") await wait.promise; };
    let returned = false;
    const pending = f.gate.importArtifact({ operationId: "SYNTHETIC_import_op", reference: initial }, async () => receipt()).then(result => { returned = true; return result; });
    await tick();
    assert.equal(f.raw().phase, "ready");
    assert.equal(returned, false);
    wait.resolve();
    await pending;
    assert.equal(returned, true);
  } finally { f.db.close(); }
});

test("binding, source artifact, cursor and expected generation cannot drift", async () => {
  const f = fixture();
  try {
    await ready(f);
    for (const field of ["accountId", "sourceId", "destinationId"] as const) {
      await assert.rejects(f.create({ ...binding, [field]: "SYNTHETIC_other" }).initialize(), rejected("binding"));
    }
    let calls = 0;
    for (const altered of [{ cursorId: "SYNTHETIC_other" }, { artifactId: "SYNTHETIC_other" }, { artifactDigest: "b".repeat(64) }, { journalGeneration: 1 }]) {
      const expected = { ...initial, ...altered };
      await assert.rejects(f.gate.run({ operationId: "SYNTHETIC_drift", expected, next: { ...expected, journalGeneration: expected.journalGeneration + 1 } }, async () => { calls++; return receipt(); }), rejected("not_ready"));
    }
    assert.equal(calls, 0);
    assert.equal(f.raw().phase, "ready");
  } finally { f.db.close(); }
});

test("racing coordinator instances cannot enter separate component callbacks", async () => {
  const f = fixture(), started = deferred(), finish = deferred();
  try {
    await f.gate.initialize();
    let calls = 0;
    const first = f.gate.importArtifact({ operationId: "SYNTHETIC_first", reference: initial }, async () => { calls++; started.resolve(); await finish.promise; return receipt(); });
    await started.promise;
    await assert.rejects(f.create().importArtifact({ operationId: "SYNTHETIC_race", reference: initial }, async () => { calls++; return receipt(); }), rejected("not_ready"));
    assert.equal(calls, 1);
    finish.resolve();
    await first;
  } finally { f.db.close(); }
});

test("reference and receipts are bounded snapshots, not mutable payload or provider proof", async () => {
  const f = fixture();
  try {
    await f.gate.initialize();
    const mutable = { ...initial };
    const pending = f.gate.importArtifact({ operationId: "SYNTHETIC_import_op", reference: mutable }, async () => ({ ...receipt(), ignored: "DUMMY_PRIVATE_PAYLOAD" }));
    mutable.cursorId = "SYNTHETIC_mutated";
    const result = await pending;
    assert.deepEqual(result.reference, initial);
    assert.equal(JSON.stringify(f.raw()).includes("PRIVATE_PAYLOAD"), false);
    await assert.rejects(f.gate.run({ operationId: "real-world-id", expected: initial, next }, async () => receipt()), rejected("invalid"));
    await assert.rejects(f.gate.run({ operationId: "SYNTHETIC_bad", expected: initial, next: { ...next, journalGeneration: 7 } }, async () => receipt()), rejected("invalid"));
  } finally { f.db.close(); }
});

test("failed running admission acknowledgment blocks callbacks across reconstruction", async () => {
  const f = fixture();
  try {
    await ready(f);
    f.controls.sync = async () => { throw Error("synthetic running sync loss"); };
    let calls = 0;
    await assert.rejects(f.gate.run({ operationId: "SYNTHETIC_run", expected: initial, next }, async () => { calls++; return receipt("run"); }), /running sync loss/);
    f.controls.sync = async () => {};
    assert.equal(f.raw().phase, "running");
    await assert.rejects(f.create().run({ operationId: "SYNTHETIC_retry", expected: initial, next }, async () => { calls++; return receipt("retry"); }), rejected("not_ready"));
    assert.equal(calls, 0);
  } finally { f.db.close(); }
});

test("failed empty gate creation may reopen safely because no component callback has started", async () => {
  const f = fixture();
  try {
    f.controls.sync = async () => { throw Error("synthetic initial sync loss"); };
    await assert.rejects(f.gate.initialize(), /initial sync loss/);
    assert.equal(f.raw().phase, "empty");
    f.controls.sync = async () => {};
    const restarted = f.create();
    await restarted.initialize();
    let calls = 0;
    await restarted.importArtifact({ operationId: "SYNTHETIC_import_op", reference: initial }, async () => { calls++; return receipt(); });
    assert.equal(calls, 1);
    assert.equal(f.raw().phase, "ready");
  } finally { f.db.close(); }
});
