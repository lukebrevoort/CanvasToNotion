import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableSyntheticCanvasStore, CanvasStorageError } from "../src/cloudflare/canvas-storage.js";
import { createCanvasPageState } from "../src/cloudflare/canvas-pages.js";
import { SyntheticJsonTransport } from "../src/cloudflare/transport.js";
import type { DurableSqlStorage } from "../src/cloudflare/sqlite-storage.js";
const initial = () => createCanvasPageState({ syntheticOnly: true, endpoint: { kind: "assignments", courseId: 990000001 }, maxPages: 3, maxItems: 20 });
const submission = { assignment_id: 990000020, workflow_state: "graded", submitted_at: "2026-10-01T00:00:00Z", graded_at: null, score: 5, grade: "5", attempt: 1, late: false, excused: false, missing: false, points_deducted: null };
const assignment = { id: 990000020, course_id: 990000001, name: "Dummy assignment", submission };
const code = (value: string) => (e: unknown) => e instanceof CanvasStorageError && e.code === value;
function transport(fetcher: typeof fetch) { return new SyntheticJsonTransport({ syntheticOnly: true, origin: "https://canvas.invalid", fetch: fetcher, requestBudget: 10 }); }
const response = (items: unknown[], link?: string) => new Response(JSON.stringify(items), { headers: link ? { Link: link } : {} });
function setup(path = ":memory:") {
  const db = new Database(path);
  const control = { failTransaction: 0, transactions: 0, sync: async () => {} };
  const storage: DurableSqlStorage = {
    sql: { exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string, ...bindings: (string | number | null)[]) { const s = db.prepare(query); const rows = s.reader ? s.all(...bindings) : (s.run(...bindings), []); return { toArray: () => rows as T[] }; } },
    transactionSync: callback => { control.transactions++; return db.transaction(() => { const r = callback(); if (control.transactions === control.failTransaction) throw Error("synthetic rollback"); return r; })(); },
    sync: () => control.sync(),
  };
  return { db, control, storage, store: new DurableSyntheticCanvasStore(storage) };
}
test("SQLite close/reopen persists complete normalized submission and exact cursor; stale work never reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-canvas-")); const path = join(dir, "dummy.sqlite"); let s = setup(path);
  try {
    const start = await s.store.initialize(initial()); let calls = 0;
    const next = `${start.page.nextUrl}&page=2`;
    const first = await s.store.ingestPage(start, transport(async () => { calls++; return response([assignment], `<${next}>; rel="next"`); }));
    assert.deepEqual(first.items[0], assignment); assert.equal(first.page.pagesRead, 1); assert.equal(first.status, "ready");
    s.db.close(); s = setup(path); assert.deepEqual(await s.store.inspect(), first);
    const empty = transport(async () => { calls++; return response([]); });
    await assert.rejects(s.store.ingestPage(start, empty), code("stale")); assert.equal(calls, 1);
    const final = await s.store.ingestPage(first, empty); assert.equal(final.page.nextUrl, null); assert.deepEqual(final.items, [assignment]);
    await assert.rejects(s.store.ingestPage(final, empty), code("complete"));
    await assert.rejects(s.store.initialize(initial()), code("exists")); assert.deepEqual(await s.store.inspect(), final); assert.equal(calls, 2);
    assert.equal(Object.hasOwn(final, "watermark"), false);
  } finally { s.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("reading admission is synced before request; concurrent/restarted adapter cannot repeat unknown read", async () => {
  const s = setup(); try {
    const start = await s.store.initialize(initial()); let releaseSync!: () => void; let resolveFetch!: (r: Response) => void; let calls = 0;
    s.control.sync = () => new Promise<void>(resolve => { releaseSync = resolve; });
    const pending = s.store.ingestPage(start, transport(async () => { calls++; return new Promise<Response>(resolve => { resolveFetch = resolve; }); }));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 0);
    const restarted = new DurableSyntheticCanvasStore(s.storage); const reading = (await restarted.inspect())!;
    assert.equal(reading.status, "reading"); assert.deepEqual(reading.items, []); assert.deepEqual(reading.page, start.page);
    await assert.rejects(restarted.ingestPage(start, transport(async () => { calls++; return response([]); })), code("blocked"));
    s.control.sync = async () => {}; releaseSync(); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
    resolveFetch(response([assignment])); assert.equal((await pending).items.length, 1);
  } finally { s.db.close(); }
});
test("failed read and malformed or duplicate page retain admission, old cursor and all prior items", async () => {
  for (const failure of ["network", "malformed", "duplicate"] as const) {
    const s = setup(); try {
      const start = await s.store.initialize(initial());
      const first = await s.store.ingestPage(start, transport(async () => response([assignment], `<${start.page.nextUrl}&page=2>; rel="next"`)));
      let calls = 0;
      await assert.rejects(s.store.ingestPage(first, transport(async () => { calls++; if (failure === "network") throw Error("dummy failure"); return response(failure === "duplicate" ? [assignment] : [{ id: 99 }]); })));
      const restored = new DurableSyntheticCanvasStore(s.storage); const state = (await restored.inspect())!;
      assert.equal(state.status, "reading"); assert.deepEqual(state.page, first.page); assert.deepEqual(state.items, first.items);
      await assert.rejects(restored.ingestPage(state, transport(async () => { calls++; return response([]); })), code("blocked")); assert.equal(calls, 1);
    } finally { s.db.close(); }
  }
});
test("final commit rollback preserves only reading admission, never items without cursor", async () => {
  const s = setup(); try {
    const start = await s.store.initialize(initial()); s.control.failTransaction = s.control.transactions + 2;
    await assert.rejects(s.store.ingestPage(start, transport(async () => response([assignment]))), code("uncertain"));
    const state = (await new DurableSyntheticCanvasStore(s.storage).inspect())!;
    assert.equal(state.status, "reading"); assert.deepEqual(state.page, start.page); assert.deepEqual(state.items, []);
    await assert.rejects(s.store.ingestPage(start, transport(async () => response([]))), code("uncertain"));
  } finally { s.db.close(); }
});
test("admission sync failure dispatches nothing and poisons adapter; persisted reading blocks restart", async () => {
  const s = setup(); try {
    const start = await s.store.initialize(initial()); let calls = 0; s.control.sync = async () => { throw Error("dummy lost acknowledgment"); };
    const t = transport(async () => { calls++; return response([]); });
    await assert.rejects(s.store.ingestPage(start, t), code("uncertain")); assert.equal(calls, 0);
    await assert.rejects(s.store.ingestPage(start, t), code("uncertain"));
    await assert.rejects(new DurableSyntheticCanvasStore(s.storage).ingestPage(start, t), code("blocked")); assert.equal(calls, 0);
  } finally { s.db.close(); }
});
test("final sync receipt loss exposes atomic ready or old reading, never claims success", async () => {
  for (const loseCommit of [false, true]) {
    const s = setup(); try {
      const start = await s.store.initialize(initial()); let count = 0; let readingDocument = "";
      s.control.sync = async () => {
        count++;
        if (count === 1) readingDocument = (s.db.prepare("SELECT document FROM synthetic_canvas_pages_v1").get() as { document: string }).document;
        if (count === 2) {
          // Model storage losing its latest unacknowledged commit on restart.
          if (loseCommit) s.db.prepare("UPDATE synthetic_canvas_pages_v1 SET document=?").run(readingDocument);
          throw Error("dummy final acknowledgment loss");
        }
      };
      await assert.rejects(s.store.ingestPage(start, transport(async () => response([assignment]))), code("uncertain"));
      await assert.rejects(s.store.ingestPage(start, transport(async () => response([]))), code("uncertain"));
      const restarted = new DurableSyntheticCanvasStore(s.storage); const state = (await restarted.inspect())!;
      assert.equal(state.status, loseCommit ? "reading" : "ready"); assert.equal(state.page.pagesRead, loseCommit ? 0 : 1); assert.equal(state.items.length, loseCommit ? 0 : 1);
      await assert.rejects(restarted.ingestPage(state, transport(async () => response([]))), code(loseCommit ? "blocked" : "complete"));
    } finally { s.db.close(); }
  }
});
test("queued duplicate is refused and input mutation cannot redirect admitted work", async () => {
  const s = setup(); try {
    const start = await s.store.initialize(initial()); let calls = 0;
    const t = transport(async () => { calls++; return response([assignment], `<${initial().nextUrl}&page=2>; rel="next"`); });
    const first = s.store.ingestPage(start, t); const duplicate = s.store.ingestPage(start, t); start.page.nextUrl = "https://evil.invalid";
    const saved = await first; await assert.rejects(duplicate, code("stale")); assert.equal(calls, 1); assert.equal(saved.items.length, 1);
  } finally { s.db.close(); }
});
test("initialization rejects resumed and non-pristine state; accessors never execute", async () => {
  const s = setup(); try {
    let invoked = false; const input = initial(); Object.defineProperty(input, "nextUrl", { enumerable: true, get() { invoked = true; return null; } });
    await assert.rejects(s.store.initialize(input), code("invalid")); assert.equal(invoked, false);
    s.db.exec("CREATE TABLE legacy_state (document TEXT)");
    await assert.rejects(s.store.initialize(initial()), code("not-pristine")); assert.equal(await s.store.inspect(), undefined);
  } finally { s.db.close(); }
});
test("fresh source composes with matching synthetic components but rejects mixed/production scope", async () => {
  for (const mismatch of [false, true]) {
    const s = setup(); try {
      const binding = { accountId: "SYNTHETIC_account", sourceId: "SYNTHETIC_canvas", destinationId: "SYNTHETIC_notion" };
      s.db.exec("CREATE TABLE synthetic_compact_journal_v2 (slot INTEGER PRIMARY KEY, document TEXT); CREATE TABLE synthetic_mirror_state_v1 (slot INTEGER PRIMARY KEY, document TEXT)");
      s.db.prepare("INSERT INTO synthetic_compact_journal_v2 VALUES(1,?)").run(JSON.stringify({ binding }));
      s.db.prepare("INSERT INTO synthetic_mirror_state_v1 VALUES(1,?)").run(JSON.stringify({ document: { binding: { ...binding, sourceId: mismatch ? "real-canvas" : binding.sourceId } } }));
      if (mismatch) await assert.rejects(s.store.initialize(initial()), code("not-pristine"));
      else assert.equal((await s.store.initialize(initial())).status, "ready");
    } finally { s.db.close(); }
  }
});
test("SQLite close/reopen of failed read retains non-ready admission with no restart retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-canvas-blocked-")); const path = join(dir, "dummy.sqlite"); let s = setup(path);
  try {
    const start = await s.store.initialize(initial());
    await assert.rejects(s.store.ingestPage(start, transport(async () => { throw Error("dummy read uncertainty"); })));
    s.db.close(); s = setup(path);
    const state = (await s.store.inspect())!; assert.equal(state.status, "reading"); assert.deepEqual(state.page, start.page); assert.deepEqual(state.items, []);
    let called = false;
    await assert.rejects(s.store.ingestPage(state, transport(async () => { called = true; return response([]); })), code("blocked"));
    await assert.rejects(s.store.initialize(initial()), code("exists")); assert.equal(called, false);
  } finally { s.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("admission transaction rollback makes no request and leaves the whole previous ready checkpoint", async () => {
  const s = setup(); try {
    const start = await s.store.initialize(initial()); s.control.failTransaction = s.control.transactions + 1; let calls = 0;
    await assert.rejects(s.store.ingestPage(start, transport(async () => { calls++; return response([]); })), code("uncertain"));
    assert.equal(calls, 0); assert.deepEqual(await s.store.inspect(), start);
  } finally { s.db.close(); }
});
