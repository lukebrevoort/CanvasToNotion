import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { build } from "esbuild";
import { createStore, type AssignmentInput } from "../src/store/core.js";
import { CanonicalPlanError, planCanonicalPendingBatch, revalidateCanonicalPendingBatch, revalidateCanonicalPendingOperation, type CanonicalPlanRequest } from "../src/cloudflare/canonical-plan.js";
const course = 990_000_001;
const assignment = (id = 990_000_042, courseId = course): AssignmentInput => ({ canvas_id: id, course_id: courseId, name: "dummy-assignment", due_at: null, calendar_due_at: null, unlock_at: null, lock_at: null, points_possible: 10, description_html: null, submission_types: "[]", group_id: null, group_name: null, group_weight: null, is_quiz: false, position: null, updated_at: null, sub_workflow_state: null, sub_score: null, sub_grade: null, sub_submitted_at: null, sub_graded_at: null, sub_attempts: null, sub_late: null, sub_excused: false, sub_missing: true });
const request = (): CanonicalPlanRequest => ({ mode: "dummy", binding: { accountId: "SYNTHETIC_account", sourceId: "SYNTHETIC_canvas", destinationId: "SYNTHETIC_notion" }, destinations: { assignmentsDbId: "SYNTHETIC_assignments_db", assignmentsDsId: "SYNTHETIC_notion", coursesDbId: "SYNTHETIC_courses_db", coursesDsId: "SYNTHETIC_courses_ds" }, observedCourses: [{ courseId: course, coursePageId: "SYNTHETIC_course_page", courseLabel: "dummy-course", domain: "dummy.invalid" }], maxOperations: 20 });
function fixture() {
  const db = new Database(":memory:"); db.pragma("foreign_keys = ON");
  let revision = 0, now = "2026-01-01T00:00:00.000Z";
  const store = createStore(db, { now: () => now, randomUUID: () => `dummy-revision-${++revision}` });
  store.upsertCourse({ id: course, name: "dummy-course" });
  return { db, store, setTime: () => { now = "2026-02-01T00:00:00.000Z"; } };
}
const code = (name: CanonicalPlanError["code"]) => (e: unknown) => e instanceof CanonicalPlanError && e.code === name;

test("canonical planner derives deterministic bounded ordered rows and never mutates pending or snapshots", async () => {
  const f = fixture();
  try {
    for (let i = 24; i >= 0; i--) f.store.upsertAssignment(assignment(990_000_100 + i));
    const before = f.db.serialize();
    const a = await planCanonicalPendingBatch(f.store, request());
    const b = await planCanonicalPendingBatch(f.store, request());
    assert.deepEqual(a, b); assert.match(a.planDigest, /^[a-f0-9]{64}$/);
    assert.equal(a.operations.length, 20); assert.equal(a.hasMore, true);
    assert.deepEqual(a.operations.map(o => o.assignmentId), Array.from({ length: 20 }, (_, i) => 990_000_100 + i));
    for (const o of a.operations) {
      assert.equal(o.revision, o.pending.revision); assert.equal(o.row.canvas_id, o.assignmentId);
      assert.match(o.requestDigest, /^[a-f0-9]{64}$/);
      assert.ok(Object.isFrozen(o.row) && Object.isFrozen(o.pending) && Object.isFrozen(o.context));
    }
    revalidateCanonicalPendingBatch(f.store, a);
    assert.deepEqual(f.db.serialize(), before);
    assert.throws(() => { (a.operations[0]!.row as { name: string }).name = "tamper"; }, TypeError);
    assert.throws(() => revalidateCanonicalPendingBatch(f.store, structuredClone(a)), code("unissued"));
  } finally { f.db.close(); }
});

test("canonical planner scopes to observed courses and hashes immutable full projection context", async () => {
  const f = fixture();
  try {
    f.store.upsertCourse({ id: course + 1, name: "dummy-previous-course" });
    f.store.upsertAssignment(assignment()); f.store.upsertAssignment(assignment(990_000_043, course + 1));
    const original = await planCanonicalPendingBatch(f.store, request());
    assert.equal(original.operations.length, 1);
    for (const mutate of [
      (r: CanonicalPlanRequest) => { r.observedCourses[0]!.courseLabel = "dummy-other"; },
      (r: CanonicalPlanRequest) => { r.observedCourses[0]!.coursePageId = "SYNTHETIC_other_page"; },
      (r: CanonicalPlanRequest) => { r.destinations.assignmentsDsId = "SYNTHETIC_other_ds"; },
      (r: CanonicalPlanRequest) => { r.binding.accountId = "SYNTHETIC_other_account"; },
    ]) {
      const r = request(); mutate(r); const changed = await planCanonicalPendingBatch(f.store, r);
      assert.notEqual(changed.planDigest, original.planDigest);
      assert.notEqual(changed.operations[0]!.requestDigest, original.operations[0]!.requestDigest);
      assert.equal(changed.operations[0]!.revision, original.operations[0]!.revision);
    }
    const r = request(); const pending = planCanonicalPendingBatch(f.store, r);
    r.observedCourses[0]!.courseLabel = "dummy-mutated-after-call";
    assert.deepEqual(await pending, original);
    assert.equal(f.store.pendingProjectionsForCourse(course + 1).length, 1);
    const empty = await planCanonicalPendingBatch(f.store, { ...request(), observedCourses: [] });
    assert.deepEqual(empty.operations, []); assert.equal(empty.hasMore, false);
  } finally { f.db.close(); }
});

test("canonical planner detects stale hash-await observations and never relabels old payload", async () => {
  const f = fixture();
  try {
    f.store.upsertAssignment(assignment());
    const old = await planCanonicalPendingBatch(f.store, request());
    const inFlight = planCanonicalPendingBatch(f.store, request());
    f.store.upsertAssignment({ ...assignment(), name: "dummy-new-observation" });
    await assert.rejects(inFlight, code("stale"));
    assert.throws(() => revalidateCanonicalPendingBatch(f.store, old), code("stale"));
    const next = await planCanonicalPendingBatch(f.store, request());
    assert.notEqual(next.operations[0]!.revision, old.operations[0]!.revision);
    assert.equal(next.operations[0]!.row.name, "dummy-new-observation");
    assert.notEqual(next.operations[0]!.requestDigest, old.operations[0]!.requestDigest);
    f.store.completeProjection(next.operations[0]!.pending);
    assert.throws(() => revalidateCanonicalPendingBatch(f.store, next), code("stale"));
  } finally { f.db.close(); }
});

test("unchanged observations invalidate exact row digest but retain Activity revision and pending work", async () => {
  const f = fixture();
  try {
    f.store.upsertAssignment(assignment());
    const old = await planCanonicalPendingBatch(f.store, request());
    f.setTime(); f.store.upsertAssignment(assignment());
    assert.throws(() => revalidateCanonicalPendingBatch(f.store, old), code("stale"));
    const next = await planCanonicalPendingBatch(f.store, request());
    assert.equal(next.operations[0]!.revision, old.operations[0]!.revision);
    assert.notEqual(next.operations[0]!.requestDigest, old.operations[0]!.requestDigest);
    assert.equal(f.store.pendingProjectionsForCourse(course).length, 1);
    // A provider's Do Not Sync answer is not a canonical acknowledgment.
    revalidateCanonicalPendingBatch(f.store, next);
    assert.equal(f.store.pendingProjectionsForCourse(course).length, 1);
    f.store.upsertAssignment(assignment(), { forceProjection: true });
    assert.throws(() => revalidateCanonicalPendingBatch(f.store, next), code("stale"));
  } finally { f.db.close(); }
});

test("canonical planner rejects invalid budgets, scope, caller payloads, and inconsistent canonical rows", async () => {
  const f = fixture();
  try {
    for (const maxOperations of [0, 21, -1, 1.5, NaN, Infinity]) await assert.rejects(planCanonicalPendingBatch(f.store, { ...request(), maxOperations }), code("invalid"));
    await assert.rejects(planCanonicalPendingBatch(f.store, { ...request(), mode: "live" as "dummy" }), code("scope"));
    await assert.rejects(planCanonicalPendingBatch(f.store, { ...request(), operations: [] } as CanonicalPlanRequest), code("invalid"));
    const r = request(); r.observedCourses[0]!.domain = "canvas.example.com";
    await assert.rejects(planCanonicalPendingBatch(f.store, r), code("scope"));
    r.observedCourses[0]!.domain = "dummy.invalid"; r.observedCourses[0]!.courseId = 1;
    await assert.rejects(planCanonicalPendingBatch(f.store, r), code("scope"));
    await assert.rejects(planCanonicalPendingBatch(f.store, { ...request(), observedCourses: [...request().observedCourses, ...request().observedCourses] }), code("invalid"));
    f.store.upsertAssignment(assignment());
    await assert.rejects(planCanonicalPendingBatch({ pendingProjectionsForCourse: f.store.pendingProjectionsForCourse, getAssignment: () => undefined }, request()), code("stale"));
    const old = await planCanonicalPendingBatch(f.store, { ...request(), maxOperations: 1 });
    f.store.upsertAssignment(assignment(990_000_003));
    assert.throws(() => revalidateCanonicalPendingBatch(f.store, old), code("stale"));
  } finally { f.db.close(); }
});

test("canonical planner digest is independent of SQL row property insertion order", async () => {
  const f = fixture();
  try {
    f.store.upsertAssignment(assignment());
    const normal = await planCanonicalPendingBatch(f.store, request());
    const reordered = await planCanonicalPendingBatch({ pendingProjectionsForCourse: f.store.pendingProjectionsForCourse,
      getAssignment: id => Object.fromEntries(Object.entries(f.store.getAssignment(id)!).reverse()) as ReturnType<typeof f.store.getAssignment> }, request());
    assert.deepEqual(reordered, normal);
  } finally { f.db.close(); }
});

test("canonical planner browser bundle has no Node/native/config runtime dependencies", async () => {
  const result = await build({ entryPoints: ["src/cloudflare/canonical-plan.ts"], bundle: true, write: false, platform: "browser", format: "esm", metafile: true });
  assert.deepEqual(Object.keys(result.metafile!.inputs), ["src/cloudflare/canonical-plan.ts"]);
});

test("cycle-owned deferred IDs prevent frozen-prefix starvation without clearing pending", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 22; i++) f.store.upsertAssignment(assignment(990_000_100 + i));
    const first = await planCanonicalPendingBatch(f.store, request());
    const attemptedAssignmentIds = first.operations.map(o => o.assignmentId);
    const later = await planCanonicalPendingBatch(f.store, { ...request(), attemptedAssignmentIds });
    assert.deepEqual(later.operations.map(o => o.assignmentId), [990_000_120, 990_000_121]);
    assert.equal(later.hasMore, false);
    assert.equal(f.store.pendingProjectionsForCourse(course).length, 22);
    await assert.rejects(planCanonicalPendingBatch(f.store, { ...request(), attemptedAssignmentIds: [990_000_999] }), code("scope"));
    await assert.rejects(planCanonicalPendingBatch(f.store, { ...request(), attemptedAssignmentIds: [990_000_100, 990_000_100] }), code("invalid"));
    f.store.upsertCourse({ id: course + 1, name: "dummy-excluded" });
    f.store.upsertAssignment(assignment(990_000_777, course + 1));
    await assert.rejects(planCanonicalPendingBatch(f.store, { ...request(), attemptedAssignmentIds: [990_000_777] }), code("scope"));
  } finally { f.db.close(); }
});

test("per-operation validation survives earlier ack but refuses same-revision changed flags", async () => {
  const f = fixture();
  try {
    f.store.upsertAssignment(assignment(990_000_100)); f.store.upsertAssignment(assignment(990_000_101));
    const p = await planCanonicalPendingBatch(f.store, request());
    const [a, b] = p.operations;
    revalidateCanonicalPendingOperation(f.store, p, a!);
    f.store.completeProjection(a!.pending);
    assert.throws(() => revalidateCanonicalPendingBatch(f.store, p), code("stale"));
    revalidateCanonicalPendingOperation(f.store, p, b!);
    assert.throws(() => revalidateCanonicalPendingOperation(f.store, p, { ...b! }), code("unissued"));
    f.store.upsertAssignment(assignment(990_000_101), { forceProjection: true });
    assert.equal(f.store.pendingProjectionsForCourse(course)[0]!.revision, b!.revision);
    assert.throws(() => revalidateCanonicalPendingOperation(f.store, p, b!), code("stale"));
    assert.equal(f.store.pendingProjectionsForCourse(course).length, 1);
  } finally { f.db.close(); }
});
