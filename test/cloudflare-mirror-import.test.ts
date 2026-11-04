import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SyntheticMirrorImporter, validateSyntheticMirrorImport, MirrorImportError, type SyntheticMirrorDocument } from "../src/cloudflare/mirror-import.js";
import { DurableSqlJournalStorage, type DurableSqlStorage } from "../src/cloudflare/sqlite-storage.js";
import { SingleWriterJournal } from "../src/cloudflare/journal.js";
const binding = { accountId: "SYNTHETIC_account", sourceId: "SYNTHETIC_canvas", destinationId: "SYNTHETIC_notion" };
function fixture(): SyntheticMirrorDocument {
  const assignment = { canvas_id: 990000020, course_id: 990000001, name: "Dummy assignment", sub_score: 4.5, submission_types: '["online_text_entry"]' };
  return { schemaVersion: 1, scope: "synthetic-only", importId: "dummy-import-1", binding: { ...binding }, courses: [{ canvas_id: 990000001, name: "Dummy course" }], assignments: [assignment], snapshots: [{ assignmentId: 990000020, capturedAt: "2026-01-01T00:00:00Z", data: { ...assignment } }], watermark: "2026-01-01T00:00:00Z", notionState: { assignmentsDbId: "dummy-assignment-db", assignmentsDsId: "SYNTHETIC_notion", coursesDbId: "dummy-course-db", coursesDsId: "dummy-course-ds" }, protectedPages: [{ assignmentId: 990000020, pageId: "dummy-page", hidden: true, inProgress: true, doNotSync: true, notes: [{ id: "dummy-note", rich_text: [{ text: { content: "Opaque note" }, annotations: { bold: true } }], icon: null }], activity: [{ id: "dummy-old-activity", text: "Historical opaque Activity" }] }], pendingProjections: [], unresolvedRuns: [] };
}
function setup(sync: () => Promise<void> = async () => {}, failInsert = false) {
  const db = new Database(":memory:");
  let transactions = 0;
  const storage: DurableSqlStorage = {
    sql: { exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string, ...bindings: (string | number | null)[]) {
      const statement = db.prepare(query); const rows = statement.reader ? statement.all(...bindings) : (statement.run(...bindings), []);
      if (failInsert && query.startsWith("INSERT INTO synthetic_mirror")) throw Error("SYNTHETIC failure after insert");
      return { toArray: () => rows as T[] };
    } },
    transactionSync: callback => { transactions++; return db.transaction(callback)(); }, sync,
  };
  return { db, storage, importer: new SyntheticMirrorImporter(storage), transactions: () => transactions };
}
const code = (expected: string) => (error: unknown) => error instanceof MirrorImportError && error.code === expected;
const tick = () => new Promise(resolve => setImmediate(resolve));

test("atomic dummy import preserves full mirror, snapshots, watermark, IDs, flags and opaque protected content", async () => {
  const { db, importer, storage } = setup();
  try { const input = fixture(); const before = structuredClone(input); assert.equal((await importer.importDocument(input)).status, "imported-synthetic"); assert.deepEqual(await importer.inspect(), before); assert.deepEqual(input, before);
    const view = await importer.inspect(); view!.protectedPages[0]!.notes.length = 0; assert.deepEqual(await new SyntheticMirrorImporter(storage).inspect(), before);
    await assert.rejects(new SyntheticMirrorImporter(storage).importDocument(input), code("exists"));
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='sync_journal_v1'").get() && (db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='sync_journal_v1'").get() as any).n, 0);
  } finally { db.close(); }
});

test("validation rejects non-synthetic scope, unresolved work, duplicate identities and dangling references before SQL", async () => {
  const { db, importer, transactions } = setup();
  try { for (const edit of [
    (x: any) => x.scope = "production", (x: any) => x.binding.sourceId = "real.instructure.com", (x: any) => x.assignments[0].canvas_id = 42,
    (x: any) => x.pendingProjections.push({ assignment_id: 990000020, revision: "unresolved" }), (x: any) => x.unresolvedRuns.push({ status: "running" }),
    (x: any) => x.courses.push({ ...x.courses[0] }), (x: any) => x.assignments[0].course_id = 990000099,
    (x: any) => x.protectedPages.push({ ...x.protectedPages[0] }), (x: any) => x.snapshots[0].data.canvas_id = 990000099,
    (x: any) => x.notionState.assignmentsDsId = "dummy-wrong", (x: any) => x.watermark = "invalid", (x: any) => x.assignments[0].sub_score = "not numeric",
    (x: any) => x.credentials = { accessToken: "DUMMY" }, (x: any) => x.assignments[0].submission_types = "{}",
  ]) { const input = fixture(); edit(input); await assert.rejects(importer.importDocument(input), e => e instanceof MirrorImportError); }
    assert.equal(transactions(), 0);
  } finally { db.close(); }
});

test("opaque JSON must remain lossless: getters, sparse arrays, cycles, hidden values and oversized data refused", () => {
  const variants: unknown[] = [];
  const getter = fixture(); Object.defineProperty(getter.protectedPages[0]!, "notes", { enumerable: true, get() { throw Error("must not invoke"); } }); variants.push(getter);
  const sparse = fixture(); sparse.protectedPages[0]!.notes = Array(2); variants.push(sparse);
  const cyclic = fixture(); cyclic.protectedPages[0]!.notes.push(cyclic as any); variants.push(cyclic);
  const hidden = fixture(); Object.defineProperty(hidden, "hidden", { enumerable: false, value: "lost" }); variants.push(hidden);
  const huge = fixture(); huge.protectedPages[0]!.notes = ["x".repeat(1_048_576)]; variants.push(huge);
  for (const v of variants) assert.throws(() => validateSyntheticMirrorImport(v), code("invalid"));
});

test("transaction failure rolls back complete mirror creation and blocks this importer", async () => {
  const { db, importer } = setup(async () => {}, true);
  try { await assert.rejects(importer.importDocument(fixture()), code("uncertain")); assert.equal(await importer.inspect(), undefined); await assert.rejects(importer.importDocument(fixture()), code("uncertain")); }
  finally { db.close(); }
});

test("durability response loss never reports success, blocks queued imports, but read-only observation remains available", async () => {
  let reject!: () => void; const sync = new Promise<void>((_resolve, fail) => { reject = () => fail(Error("SYNTHETIC lost commit acknowledgment")); });
  const { db, importer, storage } = setup(() => sync);
  try { const a = importer.importDocument(fixture()), b = importer.importDocument({ ...fixture(), importId: "dummy-import-2" }); const outcomes = Promise.allSettled([a, b]); await tick(); reject(); assert.deepEqual((await outcomes).map(x => x.status), ["rejected", "rejected"]); assert.equal((await importer.inspect())!.importId, "dummy-import-1"); await assert.rejects(new SyntheticMirrorImporter(storage).importDocument(fixture()), code("exists")); }
  finally { db.close(); }
});

test("queued imports cannot overtake durable confirmation or mutate captured input", async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); const { db, importer, transactions } = setup(() => gate);
  try { const input = fixture(); const a = importer.importDocument(input); input.assignments[0]!.name = "changed after call"; const b = importer.importDocument({ ...fixture(), importId: "dummy-import-2" }); const rejected = assert.rejects(b, code("exists")); await tick(); assert.equal(transactions(), 1); release(); await a; await rejected; assert.equal((await importer.inspect())!.assignments[0]!.name, "Dummy assignment"); }
  finally { db.close(); }
});

test("only pristine bound generation-zero journal permits import; journal is never initialized or changed", async () => {
  for (const variant of ["pristine", "active", "completed", "other-binding"] as const) {
    const { db, importer, storage } = setup();
    try { const journal = new SingleWriterJournal(new DurableSqlJournalStorage(storage)); await journal.initialize(variant === "other-binding" ? { ...binding, accountId: "SYNTHETIC_other" } : binding);
      if (variant === "active" || variant === "completed") { const handle = await journal.admit({ ...binding, runId: "dummy-run", expectedGeneration: 0 }); if (variant === "completed") await journal.finish(handle); }
      const before = await journal.inspect(); if (variant === "pristine") await importer.importDocument(fixture()); else await assert.rejects(importer.importDocument(fixture()), code(variant === "other-binding" ? "scope" : "unresolved")); assert.deepEqual(await journal.inspect(), before);
    } finally { db.close(); }
  }
});
