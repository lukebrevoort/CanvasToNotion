import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { CompactSyntheticJournal, compactTriggerId, type CompactState, type CompactStorage, type CompactTransaction, type CompactOperation } from "../src/cloudflare/compact-journal.js";
import { CompactSyntheticCoordinator, CompactCoordinatorError, type CompactCoordinatorState, type CompactReady, type CompactAdmissionRequest } from "../src/cloudflare/compact-coordinator.js";
import type { DurableSqlStorage } from "../src/cloudflare/sqlite-storage.js";

class MemoryJournalStorage implements CompactStorage {
  state: CompactState | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  transaction<T>(callback: (transaction: CompactTransaction) => T): Promise<T> {
    const pending = this.tail.then(() => {
      let draft = structuredClone(this.state);
      const result = callback({ get: () => structuredClone(draft), put: state => { draft = structuredClone(state); } });
      this.state = draft;
      return structuredClone(result);
    });
    this.tail = pending.catch(() => undefined);
    return pending;
  }
}
const binding = { accountId: "SYNTHETIC_account", sourceId: "SYNTHETIC_source", destinationId: "SYNTHETIC_destination" };
const initial = { artifactId: "SYNTHETIC_artifact", artifactDigest: "a".repeat(64), cursorId: "SYNTHETIC_cursor_0", journalGeneration: 0, journalRootDigest: "0".repeat(64) };
const operation: CompactOperation = { kind: "write", targetId: "SYNTHETIC_page", requestDigest: "b".repeat(64) };
const code = (expected: string) => (error: unknown) => error instanceof CompactCoordinatorError && error.code === expected;
function fixture() {
  const db = new Database(":memory:"), journalStorage = new MemoryJournalStorage();
  const journal = new CompactSyntheticJournal(journalStorage);
  const controls = { sync: async () => {}, failTransaction: false, validMirror: true, cursor: initial.cursorId, effects: 0 };
  const storage: DurableSqlStorage = {
    sql: { exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string, ...bindings: (string | number | null)[]) {
      const statement = db.prepare(query);
      const rows = statement.reader ? statement.all(...bindings) : (statement.run(...bindings), []);
      return { toArray: () => rows as T[] };
    } },
    transactionSync: callback => {
      if (controls.failTransaction) { controls.failTransaction = false; throw Error("synthetic transaction loss"); }
      return db.transaction(callback)();
    },
    sync: () => controls.sync(),
  };
  const verify = async (ready: CompactReady) => {
    const state = await journal.inspect();
    return controls.validMirror && ready.reference.artifactId === initial.artifactId && ready.reference.artifactDigest === initial.artifactDigest &&
      ready.reference.cursorId === controls.cursor && ready.reference.journalGeneration === state.generation &&
      ready.reference.journalRootDigest === state.rootDigest && state.active === null &&
      JSON.stringify(ready.terminal) === JSON.stringify(state.latestTerminal) && ready.receiptId === "SYNTHETIC_ready";
  };
  const create = () => new CompactSyntheticCoordinator(storage, binding, verify);
  const gate = create();
  const raw = () => JSON.parse((db.prepare("SELECT document FROM synthetic_compact_coordinator_v2 WHERE slot=1").get() as { document: string }).document) as CompactCoordinatorState;
  const bootstrap = async () => {
    await gate.initialize();
    return gate.importArtifact(initial, async () => { await journal.initialize(binding); return { receiptId: "SYNTHETIC_ready" }; });
  };
  const complete = async (request: CompactAdmissionRequest, cursor: string) => {
    const handle = await journal.admit(request);
    for (let index = 0; index < request.plan.length; index++) await journal.execute(handle, index, async () => { controls.effects++; return { receiptId: "SYNTHETIC_effect" }; });
    // Model exact durable source/cursor acknowledgement BEFORE compaction.
    controls.cursor = cursor;
    assert.equal(controls.validMirror, true);
    return { terminal: await journal.finish(handle), receiptId: "SYNTHETIC_ready" };
  };
  return { db, storage, journal, journalStorage, controls, gate, create, raw, bootstrap, complete };
}

test("10001 coordinator generations stay bounded and late/reordered triggers cannot replay", async () => {
  const f = fixture();
  try {
    let ready = await f.bootstrap(), firstBytes = 0, peakBytes = 0;
    const old = structuredClone(ready.reference);
    for (let generation = 0; generation < 10_001; generation++) {
      const nextCursorId = `SYNTHETIC_cursor_${generation + 1}`;
      ready = await f.gate.run({ triggerId: compactTriggerId(generation), expected: ready.reference, nextCursorId, plan: [] }, request => f.complete(request, nextCursorId));
      const bytes = new TextEncoder().encode(JSON.stringify(f.raw())).byteLength;
      if (generation === 0) firstBytes = bytes;
      peakBytes = Math.max(peakBytes, bytes);
    }
    assert.ok(peakBytes < 4_096);
    assert.ok(peakBytes <= firstBytes + 80, `bounded size: first=${firstBytes}, peak=${peakBytes}`);
    assert.equal(f.raw().generation, 10_001);
    assert.equal(f.raw().active, null);
    assert.equal(f.controls.effects, 0);
    let calls = 0;
    await assert.rejects(f.create().run({ triggerId: compactTriggerId(0), expected: old, nextCursorId: "SYNTHETIC_late", plan: [] }, async request => { calls++; return f.complete(request, "SYNTHETIC_late"); }), code("generation"));
    await assert.rejects(f.create().run({ triggerId: compactTriggerId(0), expected: ready.reference, nextCursorId: "SYNTHETIC_relabel", plan: [] }, async request => { calls++; return f.complete(request, "SYNTHETIC_relabel"); }), code("generation"));
    assert.equal(calls, 0);
  } finally { f.db.close(); }
});

test("legacy V1 object namespaces cannot be silently reinitialized as V2", async () => {
  const f = fixture();
  try {
    f.db.exec("CREATE TABLE sync_journal_v1(document TEXT); INSERT INTO sync_journal_v1 VALUES ('preserve-old-history')");
    await assert.rejects(f.gate.initialize(), code("version"));
    assert.deepEqual(f.db.prepare("SELECT document FROM sync_journal_v1").all(), [{ document: "preserve-old-history" }]);
    assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='synthetic_compact_coordinator_v2'").all().length, 0);
  } finally { f.db.close(); }
});

test("composed V2 plan and exact current readiness survive a successful restart", async () => {
  const f = fixture();
  try {
    const imported = await f.bootstrap();
    const next = await f.gate.run({ triggerId: compactTriggerId(0), expected: imported.reference, nextCursorId: "SYNTHETIC_cursor_1", plan: [operation] }, request => f.complete(request, "SYNTHETIC_cursor_1"));
    const restarted = f.create();
    await restarted.initialize();
    await restarted.run({ triggerId: compactTriggerId(1), expected: next.reference, nextCursorId: "SYNTHETIC_cursor_2", plan: [operation] }, request => f.complete(request, "SYNTHETIC_cursor_2"));
    assert.equal(f.controls.effects, 2);
    assert.equal(f.raw().generation, 2);
    assert.equal(f.raw().ready!.terminal!.generation, 1);
  } finally { f.db.close(); }
});

test("unknown external outcome retains complete coordinator and journal evidence without compaction", async () => {
  const f = fixture();
  try {
    const imported = await f.bootstrap();
    await assert.rejects(f.gate.run({ triggerId: compactTriggerId(0), expected: imported.reference, nextCursorId: "SYNTHETIC_cursor_1", plan: [operation] }, async request => {
      const handle = await f.journal.admit(request);
      await f.journal.execute(handle, 0, async () => { f.controls.effects++; throw Error("synthetic lost effect receipt"); });
      throw Error("unreachable");
    }), code("uncertain"));
    assert.equal(f.raw().phase, "uncertain");
    assert.deepEqual(f.raw().active!.plan, [operation]);
    assert.equal(f.journalStorage.state!.active!.phase, "uncertain");
    assert.equal(f.journalStorage.state!.latestTerminal, null);
    await assert.rejects(f.create().run({ triggerId: compactTriggerId(0), expected: imported.reference, nextCursorId: "SYNTHETIC_cursor_1", plan: [operation] }, request => f.complete(request, "SYNTHETIC_cursor_1")), code("not_ready"));
    assert.equal(f.controls.effects, 1);
  } finally { f.db.close(); }
});

test("lost final ready acknowledgment revalidates terminal evidence before any distinct generation", async () => {
  const f = fixture();
  try {
    const imported = await f.bootstrap();
    f.controls.sync = async () => { if (f.raw().phase === "ready") throw Error("synthetic ready response loss"); };
    await assert.rejects(f.gate.run({ triggerId: compactTriggerId(0), expected: imported.reference, nextCursorId: "SYNTHETIC_cursor_1", plan: [operation] }, request => f.complete(request, "SYNTHETIC_cursor_1")), code("uncertain"));
    const terminalReference = f.raw().ready!.reference;
    assert.equal(f.raw().phase, "ready");
    assert.equal(f.controls.effects, 1);
    f.controls.sync = async () => {};
    await assert.rejects(f.gate.run({ triggerId: compactTriggerId(1), expected: terminalReference, nextCursorId: "SYNTHETIC_cursor_2", plan: [] }, request => f.complete(request, "SYNTHETIC_cursor_2")), code("uncertain"));
    const restarted = f.create();
    await assert.rejects(restarted.run({ triggerId: compactTriggerId(0), expected: imported.reference, nextCursorId: "SYNTHETIC_cursor_1", plan: [operation] }, request => f.complete(request, "SYNTHETIC_cursor_1")), code("generation"));
    await restarted.run({ triggerId: compactTriggerId(1), expected: terminalReference, nextCursorId: "SYNTHETIC_cursor_2", plan: [] }, request => f.complete(request, "SYNTHETIC_cursor_2"));
    assert.equal(f.controls.effects, 1);
  } finally { f.db.close(); }
});

test("mismatched mirror or cursor acknowledgment blocks before a new journal admission", async () => {
  const f = fixture();
  try {
    const imported = await f.bootstrap();
    f.controls.validMirror = false;
    let callbacks = 0;
    await assert.rejects(f.create().run({ triggerId: compactTriggerId(0), expected: imported.reference, nextCursorId: "SYNTHETIC_cursor_1", plan: [] }, async request => { callbacks++; return f.complete(request, "SYNTHETIC_cursor_1"); }), code("uncertain"));
    assert.equal(callbacks, 0);
    assert.equal(f.journalStorage.state!.active, null);
    assert.equal(f.raw().phase, "uncertain");
  } finally { f.db.close(); }
});

test("post-callback terminal with wrong plan identity is never promoted to ready", async () => {
  const f = fixture();
  try {
    const imported = await f.bootstrap();
    await assert.rejects(f.gate.run({ triggerId: compactTriggerId(0), expected: imported.reference, nextCursorId: "SYNTHETIC_cursor_1", plan: [operation] }, async request => {
      const completed = await f.complete(request, "SYNTHETIC_cursor_1");
      return { ...completed, terminal: { ...completed.terminal, planDigest: "c".repeat(64) } };
    }), code("uncertain"));
    assert.equal(f.raw().phase, "uncertain");
    assert.equal(f.raw().generation, 0);
    assert.deepEqual(f.raw().active!.plan, [operation]);
  } finally { f.db.close(); }
});

test("unpersisted ready transition leaves the prior admission blocked after reconstruction", async () => {
  const f = fixture();
  try {
    const imported = await f.bootstrap();
    await assert.rejects(f.gate.run({ triggerId: compactTriggerId(0), expected: imported.reference, nextCursorId: "SYNTHETIC_cursor_1", plan: [] }, async request => {
      const completed = await f.complete(request, "SYNTHETIC_cursor_1");
      f.controls.failTransaction = true;
      return completed;
    }), code("uncertain"));
    assert.equal(f.raw().phase, "running");
    assert.equal(f.raw().active!.triggerId, compactTriggerId(0));
    await assert.rejects(f.create().run({ triggerId: compactTriggerId(0), expected: imported.reference, nextCursorId: "SYNTHETIC_cursor_1", plan: [] }, request => f.complete(request, "SYNTHETIC_cursor_1")), code("not_ready"));
  } finally { f.db.close(); }
});
