import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { build } from "esbuild";
import { createStore, type AssignmentInput } from "../src/store/core.js";

const input = (): AssignmentInput => ({ canvas_id: 42, course_id: 1, name: "Dummy assignment", due_at: null, calendar_due_at: null, unlock_at: null, lock_at: null, points_possible: 10, description_html: null, submission_types: "[]", group_id: null, group_name: null, group_weight: null, is_quiz: false, position: null, updated_at: null, sub_workflow_state: null, sub_score: null, sub_grade: null, sub_submitted_at: null, sub_graded_at: null, sub_attempts: null, sub_late: null, sub_excused: false, sub_missing: true });
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dummy-store-core-"));
  const db = new Database(path.join(directory, "dummy.sqlite")); db.pragma("foreign_keys = ON");
  let time = "2026-01-01T00:00:00.000Z", revision = 0;
  const dependencies = { now: () => time, randomUUID: () => `dummy-revision-${++revision}` };
  return { db, dependencies, store: createStore(db, dependencies), setTime: (value: string) => { time = value; }, close: () => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test("canonical factory preserves snapshots, pending merges, forced receipt and stale acknowledgment", () => {
  const f = fixture();
  try {
    const s = f.store, a = input(); s.upsertCourse({ id: 1, name: "Dummy course" });
    assert.deepEqual(s.upsertAssignment(a), { isNew: true, changedFields: ["__new__"] });
    const first = s.pendingProjectionsForCourse(1)[0]!;
    assert.deepEqual(first, { assignment_id: 42, revision: "dummy-revision-1", is_new: 1, changed_fields: '["__new__"]', force_details: 0 });
    assert.deepEqual(s.snapshotsFor(42), [{ captured_at: f.dependencies.now(), changed_fields: '["__new__"]', data: JSON.stringify({ ...a, is_quiz: 0, sub_late: null, sub_excused: 0, sub_missing: 1, ts: f.dependencies.now() }) }]);
    f.setTime("2026-01-02T00:00:00.000Z");
    assert.deepEqual(s.upsertAssignment(a), { isNew: false, changedFields: [] });
    assert.equal(s.snapshotsFor(42).length, 1); assert.equal(s.getAssignment(42)!.last_seen_at, f.dependencies.now());
    assert.deepEqual(s.pendingProjectionsForCourse(1)[0], first);
    s.upsertAssignment(a, { forceProjection: true });
    assert.deepEqual(s.pendingProjectionsForCourse(1)[0], { ...first, force_details: 1 });
    a.sub_score = 8; s.upsertAssignment(a);
    const changed = s.pendingProjectionsForCourse(1)[0]!;
    assert.deepEqual(changed, { ...first, revision: "dummy-revision-2", changed_fields: '["__new__","sub_score"]', force_details: 1 });
    assert.equal(s.snapshotsFor(42).length, 2);
    s.completeProjection(first); assert.deepEqual(s.pendingProjectionsForCourse(1)[0], changed);
    s.completeProjection(changed); assert.deepEqual(s.pendingProjectionsForCourse(1), []);
    s.upsertAssignment(a, { forceProjection: true });
    assert.deepEqual(s.pendingProjectionsForCourse(1)[0], { assignment_id: 42, revision: "dummy-revision-3", is_new: 0, changed_fields: "[]", force_details: 1 });
    assert.equal(s.getAssignment(42)!.first_seen_at, "2026-01-01T00:00:00.000Z");
  } finally { f.close(); }
});

test("canonical factory retains metadata, sync-run watermark and all rows through repeat initialization", () => {
  const f = fixture();
  try {
    const s = f.store; s.setMeta("dummy", "opaque dummy value");
    assert.equal(s.getMeta("absent"), null); assert.equal(s.lastSuccessfulSyncStart(), undefined);
    const successful = s.startSyncRun(); assert.equal(successful, 1); assert.equal(s.lastSyncRun(), undefined);
    s.finishSyncRun(successful, "ok", { courses_seen: 1, assignments_seen: 2, changes_pushed: 3 });
    f.setTime("2026-01-02T00:00:00.000Z"); const failed = s.startSyncRun();
    s.finishSyncRun(failed, "error", {}, "dummy failure");
    f.setTime("2026-01-03T00:00:00.000Z"); assert.equal(s.startSyncRun(), 3);
    const again = createStore(f.db, f.dependencies);
    assert.equal(again.getMeta("dummy"), "opaque dummy value");
    assert.equal(again.lastSuccessfulSyncStart()!.toISOString(), "2026-01-01T00:00:00.000Z");
    assert.deepEqual(again.lastSyncRun(), { id: 2, started_at: "2026-01-02T00:00:00.000Z", finished_at: "2026-01-02T00:00:00.000Z", status: "error", courses_seen: null, assignments_seen: null, changes_pushed: null, error: "dummy failure" });
    assert.equal(again.startSyncRun(), 4);
  } finally { f.close(); }
});

test("canonical factory rolls back assignment and snapshot when queue insertion fails", () => {
  const f = fixture();
  try {
    f.store.upsertCourse({ id: 1 });
    f.db.exec("CREATE TEMP TRIGGER reject_pending BEFORE INSERT ON pending_assignment_projections BEGIN SELECT RAISE(ABORT, 'dummy queue failure'); END");
    assert.throws(() => f.store.upsertAssignment(input()), /dummy queue failure/);
    assert.equal(f.store.getAssignment(42), undefined); assert.deepEqual(f.store.snapshotsFor(42), []); assert.deepEqual(f.store.pendingProjectionsForCourse(1), []);
    f.db.exec("DROP TRIGGER reject_pending");
    assert.throws(() => f.store.upsertAssignment({ ...input(), course_id: 999 }), /FOREIGN KEY/);
  } finally { f.close(); }
});

test("canonical factory retains exact calendar timestamp backfill and repeat initialization", () => {
  const f = fixture();
  try {
    f.store.upsertCourse({ id: 1 });
    f.store.upsertAssignment({ ...input(), due_at: "2026-01-31T23:59:59Z", calendar_due_at: "different" });
    f.store.upsertAssignment({ ...input(), canvas_id: 43, due_at: null });
    f.store.upsertAssignment({ ...input(), canvas_id: 44, due_at: "2026-02-01T18:00:00.123-05:00" });
    const before = f.store.snapshotsFor(42), pending = f.store.pendingProjectionsForCourse(1);
    f.db.exec("ALTER TABLE assignments DROP COLUMN calendar_due_at");
    const migrated = createStore(f.db, f.dependencies);
    assert.equal(migrated.getAssignment(42)!.calendar_due_at, "2026-01-31T23:59:59Z");
    assert.equal(migrated.getAssignment(43)!.calendar_due_at, null);
    assert.equal(migrated.getAssignment(44)!.calendar_due_at, "2026-02-01T18:00:00.123-05:00");
    assert.deepEqual(migrated.snapshotsFor(42), before); assert.deepEqual(migrated.pendingProjectionsForCourse(1), pending);
    assert.equal(createStore(f.db, f.dependencies).getAssignment(42)!.calendar_due_at, "2026-01-31T23:59:59Z");
  } finally { f.close(); }
});

test("canonical factory rolls back existing observations and receipts on queue update failure", () => {
  const f = fixture();
  try {
    const s = f.store;
    s.upsertCourse({ id: 1 });
    s.upsertAssignment(input());
    const before = { row: s.getAssignment(42), snapshots: s.snapshotsFor(42), pending: s.pendingProjectionsForCourse(1) };
    f.setTime("2026-02-01T00:00:00.000Z");
    f.db.exec("CREATE TEMP TRIGGER reject_pending_update BEFORE UPDATE ON pending_assignment_projections BEGIN SELECT RAISE(ABORT, 'dummy queue update failure'); END");
    for (const changed of [false, true]) {
      assert.throws(() => s.upsertAssignment({ ...input(), name: changed ? "Changed" : input().name }, { forceProjection: true }), /dummy queue update failure/);
      assert.deepEqual({ row: s.getAssignment(42), snapshots: s.snapshotsFor(42), pending: s.pendingProjectionsForCourse(1) }, before);
    }
    f.db.exec("DROP TRIGGER reject_pending_update");
    s.upsertAssignment({ ...input(), name: "Changed" });
    assert.equal(s.getAssignment(42)!.name, "Changed");
    assert.equal(s.snapshotsFor(42).length, 2);
  } finally { f.close(); }
});

test("canonical factory preserves non-diff fields, course filtering and native row ordering", () => {
  const f = fixture();
  try {
    const s = f.store;
    s.upsertCourse({ id: 2, name: "Zulu" }); s.upsertCourse({ id: 1, name: "Alpha" });
    s.upsertAssignment(input());
    s.upsertAssignment({ ...input(), canvas_id: 7, course_id: 2 });
    s.upsertAssignment({ ...input(), canvas_id: 3 });
    assert.deepEqual(s.listActiveCourses().map(c => c.canvas_id), [1, 2]);
    assert.deepEqual(s.pendingProjectionsForCourse(1).map(p => p.assignment_id), [3, 42]);
    assert.deepEqual(s.pendingProjectionsForCourse(2).map(p => p.assignment_id), [7]);
    assert.deepEqual(s.listAssignmentsForCourses([]), []);
    assert.deepEqual(s.listAssignmentsForCourses([2, 1]).map(a => a.canvas_id), [7, 3, 42]);
    const before = s.getAssignment(42)!;
    f.setTime("2026-02-01T00:00:00.000Z");
    // Canonical behavior deliberately ignores an updated_at-only observation.
    assert.deepEqual(s.upsertAssignment({ ...input(), updated_at: "new metadata" }), { isNew: false, changedFields: [] });
    assert.deepEqual(s.getAssignment(42), { ...before, last_seen_at: f.dependencies.now() });
    f.db.prepare("UPDATE courses SET active = 0 WHERE canvas_id = ?").run(1);
    assert.deepEqual(s.listActiveCourses().map(c => c.canvas_id), [2]);
    s.upsertCourse({ id: 1 });
    assert.equal(s.listActiveCourses()[0]!.name, "Course 1");
    assert.equal((f.db.prepare("SELECT first_seen_at FROM courses WHERE canvas_id = 1").get() as { first_seen_at: string }).first_seen_at, before.first_seen_at);
  } finally { f.close(); }
});

test("canonical factory bundle has no Node, native SQLite, or configuration imports", async () => {
  const result = await build({ entryPoints: ["src/store/core.ts"], bundle: true, write: false, format: "esm", platform: "browser", metafile: true });
  assert.deepEqual(Object.keys(result.metafile!.inputs), ["src/store/core.ts"]);
});
