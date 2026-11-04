import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableSyntheticMirrorStore, MirrorStorageError } from "../src/cloudflare/mirror-storage.js";
import { listPending, type RevisionToken } from "../src/cloudflare/mirror-state.js";
import type { DurableSqlStorage } from "../src/cloudflare/sqlite-storage.js";
const row = { canvas_id: 990000020, course_id: 990000001, name: "Dummy assignment", sub_score: 1 };
function fixture() { return { schemaVersion: 1, scope: "synthetic-only", importId: "dummy-import-1", binding: { accountId: "SYNTHETIC_account", sourceId: "SYNTHETIC_canvas", destinationId: "SYNTHETIC_notion" }, courses: [{ canvas_id: 990000001, name: "Dummy course" }], assignments: [row], snapshots: [], watermark: null, notionState: { assignmentsDbId: "dummy-db", assignmentsDsId: "SYNTHETIC_notion", coursesDbId: "dummy-courses-db", coursesDsId: "dummy-courses-ds" }, protectedPages: [{ assignmentId: row.canvas_id, pageId: "dummy-page", hidden: true, inProgress: true, doNotSync: false, notes: [{ content: "opaque" }], activity: [{ icon: null }] }], pendingProjections: [], unresolvedRuns: [] }; }
const token = (p: RevisionToken): RevisionToken => ({ importId: p.importId, assignmentId: p.assignmentId, revision: p.revision });
function setup(path = ":memory:") {
  const db = new Database(path);
  const control = { fault: "" as "" | "before" | "after", sync: async () => {}, transactions: 0 };
  const storage: DurableSqlStorage = {
    sql: { exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string, ...bindings: (string | number | null)[]) { const s = db.prepare(query); const rows = s.reader ? s.all(...bindings) : (s.run(...bindings), []); return { toArray: () => rows as T[] }; } },
    transactionSync: callback => { control.transactions++; return db.transaction(() => { if (control.fault === "before") throw Error("synthetic before"); const r = callback(); if (control.fault === "after") throw Error("synthetic after"); return r; })(); },
    sync: () => control.sync(),
  };
  return { db, control, storage, store: new DurableSyntheticMirrorStore(storage) };
}
const code = (value: string) => (e: unknown) => e instanceof MirrorStorageError && e.code === value;
test("SQLite close/reopen preserves revisions/pending; old ack cannot clear newer work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-mirror-")); const path = join(dir, "dummy.sqlite");
  let s = setup(path);
  try {
    const doc = fixture(); await s.store.initialize(doc);
    const first = await s.store.observeAssignment({ ...row, sub_score: 2 }); const firstToken = token(first.pending!);
    s.db.close(); s = setup(path);
    assert.deepEqual(listPending((await s.store.inspect())!), [first.pending]);
    const second = await s.store.observeAssignment({ ...row, sub_score: 3 });
    assert.equal((await s.store.acknowledgeRevision(firstToken)).status, "stale");
    assert.equal((await s.store.inspectMetadata())!.pendingCount, 1);
    assert.equal((await s.store.acknowledgeRevision(token(second.pending!))).status, "acknowledged");
    s.db.close(); s = setup(path);
    const restored = (await s.store.inspect())!; assert.deepEqual(listPending(restored), []); assert.equal(restored.revisions[0]!.revision, 2);
    assert.deepEqual(restored.document.protectedPages, doc.protectedPages); assert.deepEqual(restored.document.snapshots, doc.snapshots); assert.equal(restored.document.watermark, null);
    await assert.rejects(s.store.initialize(doc), code("exists"));
  } finally { s.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("transaction failures before and after SQL roll back and poison queued operations", async () => {
  for (const fault of ["before", "after"] as const) {
    const s = setup(); try {
      await s.store.initialize(fixture()); const baseline = await s.store.inspect();
      s.control.fault = fault;
      const first = s.store.observeAssignment({ ...row, sub_score: 2 }); const queued = s.store.observeAssignment({ ...row, sub_score: 3 });
      await assert.rejects(first, code("uncertain")); await assert.rejects(queued, code("uncertain"));
      s.control.fault = ""; assert.deepEqual(await s.store.inspect(), baseline);
      await assert.rejects(s.store.observeAssignment(row), code("uncertain"));
    } finally { s.db.close(); }
  }
});
test("lost sync acknowledges nothing, blocks queued ack, and exposes committed pending read-only", async () => {
  const s = setup(); try {
    await s.store.initialize(fixture()); s.control.sync = async () => { throw Error("synthetic lost acknowledgment"); };
    const observation = s.store.observeAssignment({ ...row, sub_score: 2 });
    const ack = s.store.acknowledgeRevision({ importId: "dummy-import-1", assignmentId: row.canvas_id, revision: 1 });
    await assert.rejects(observation, code("uncertain")); await assert.rejects(ack, code("uncertain"));
    assert.equal((await s.store.inspectMetadata())!.uncertain, true); assert.equal((await s.store.inspect())!.revisions[0]!.pending, true);
    // New instance can inspect durable state; this does NOT authorize resuming effects.
    const reopened = new DurableSyntheticMirrorStore(s.storage); assert.equal((await reopened.inspect())!.revisions[0]!.revision, 1);
  } finally { s.db.close(); }
});
test("queue includes sync, captures caller input, and reads cannot overtake durability", async () => {
  const s = setup(); try {
    await s.store.initialize(fixture()); let release!: () => void;
    s.control.sync = () => new Promise<void>(resolve => { release = resolve; });
    const changed = { ...row, sub_score: 2 }; const first = s.store.observeAssignment(changed); changed.sub_score = 99;
    let readDone = false; const read = s.store.inspect().then(v => { readDone = true; return v; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(readDone, false);
    s.control.sync = async () => {}; release();
    assert.equal((await first).state.document.assignments[0]!.sub_score, 2); assert.equal((await read)!.revisions[0]!.pending, true);
  } finally { s.db.close(); }
});
test("initialization rejects non-pristine journal and competing legacy mirror without modifying them", async () => {
  for (const legacy of [false, true]) {
    const s = setup(); try {
      const name = legacy ? "synthetic_mirror_v1" : "sync_journal_v1";
      s.db.exec(`CREATE TABLE ${name} (slot INTEGER PRIMARY KEY, document TEXT)`);
      const value = legacy ? "{}" : JSON.stringify({ schemaVersion: 1, binding: fixture().binding, generation: 1, activeRunId: null, runs: [] });
      s.db.prepare(`INSERT INTO ${name} VALUES(1, ?)`).run(value);
      await assert.rejects(s.store.initialize(fixture()), code("not-pristine"));
      assert.equal(await s.store.inspect(), undefined); assert.equal((s.db.prepare(`SELECT document FROM ${name}`).get() as any).document, value);
    } finally { s.db.close(); }
  }
});
test("DoNotSync and opaque protected data remain frozen; invalid queued-input accessors never execute", async () => {
  const s = setup(); try {
    const doc = fixture(); doc.protectedPages[0]!.doNotSync = true; await s.store.initialize(doc);
    assert.equal((await s.store.observeAssignment({ ...row, sub_score: 5 })).status, "frozen");
    assert.deepEqual((await s.store.inspect())!.document, doc);
    let invoked = false; const bad = { ...row }; Object.defineProperty(bad, "name", { enumerable: true, get() { invoked = true; return "bad"; } });
    await assert.rejects(s.store.observeAssignment(bad), code("invalid")); assert.equal(invoked, false);
  } finally { s.db.close(); }
});
test("lost acknowledgment sync may persist clearing but never reports success or permits continuation", async () => {
  const s = setup(); try {
    await s.store.initialize(fixture()); const changed = await s.store.observeAssignment({ ...row, sub_score: 2 });
    s.control.sync = async () => { throw Error("synthetic sync failure after ack commit"); };
    const ack = s.store.acknowledgeRevision(token(changed.pending!));
    const queued = s.store.observeAssignment({ ...row, sub_score: 3 });
    await assert.rejects(ack, code("uncertain")); await assert.rejects(queued, code("uncertain"));
    const observed = (await s.store.inspect())!; assert.equal(observed.revisions[0]!.pending, false); assert.equal(observed.revisions[0]!.revision, 1);
    assert.equal((await s.store.inspectMetadata())!.uncertain, true);
    // This visible row cannot establish external success or restart admission.
  } finally { s.db.close(); }
});
