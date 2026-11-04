import test from "node:test";
import assert from "node:assert/strict";
import { createMirrorState, observeAssignment, acknowledgeRevision, listPending, validateMirrorState, type RevisionToken } from "../src/cloudflare/mirror-state.js";
import type { SyntheticMirrorDocument } from "../src/cloudflare/mirror-import.js";
const row = { canvas_id: 990000020, course_id: 990000001, name: "Dummy assignment", sub_score: 1 };
function fixture(): SyntheticMirrorDocument {
  return { schemaVersion: 1, scope: "synthetic-only", importId: "dummy-import-1", binding: { accountId: "SYNTHETIC_account", sourceId: "SYNTHETIC_canvas", destinationId: "SYNTHETIC_notion" }, courses: [{ canvas_id: 990000001, name: "Dummy course" }], assignments: [{ ...row }], snapshots: [{ assignmentId: row.canvas_id, capturedAt: "2026-01-01T00:00:00Z", data: { ...row } }], watermark: "2026-01-01T00:00:00Z", notionState: { assignmentsDbId: "dummy-db", assignmentsDsId: "SYNTHETIC_notion", coursesDbId: "dummy-courses-db", coursesDsId: "dummy-courses-ds" }, protectedPages: [{ assignmentId: row.canvas_id, pageId: "dummy-page", hidden: true, inProgress: true, doNotSync: false, notes: [{ arbitrary: [null, "opaque note"] }], activity: [{ icon: null, old: "Opaque history" }] }], pendingProjections: [], unresolvedRuns: [] };
}
const token = (p: RevisionToken): RevisionToken => ({ importId: p.importId, assignmentId: p.assignmentId, revision: p.revision });
test("identical observations are no-ops; changed observations retain stable pending identity", () => {
  const state = createMirrorState(fixture()); const before = structuredClone(state);
  assert.equal(observeAssignment(state, { sub_score: 1, name: row.name, course_id: row.course_id, canvas_id: row.canvas_id }).status, "unchanged");
  const first = observeAssignment(state, { ...row, sub_score: 2 });
  assert.equal(first.status, "queued"); assert.equal(first.pending!.revision, 1);
  const repeat = observeAssignment(first.state, { ...row, sub_score: 2 });
  assert.equal(repeat.status, "unchanged"); assert.deepEqual(repeat.pending, first.pending);
  assert.deepEqual(state, before); assert.deepEqual(listPending(repeat.state), [first.pending]);
  first.pending!.assignment.name = "caller mutation";
  assert.equal(first.state.document.assignments[0]!.name, row.name);
});
test("old, cross-import, future and repeated acknowledgments cannot clear newer work", () => {
  const first = observeAssignment(createMirrorState(fixture()), { ...row, sub_score: 2 });
  const next = observeAssignment(first.state, { ...row, sub_score: 3 });
  for (const t of [token(first.pending!), { ...token(next.pending!), importId: "dummy-other" }, { ...token(next.pending!), revision: 3 }]) {
    const result = acknowledgeRevision(next.state, t); assert.equal(result.status, "stale"); assert.deepEqual(result.state, next.state);
  }
  const ack = acknowledgeRevision(next.state, token(next.pending!)); assert.equal(ack.status, "acknowledged"); assert.deepEqual(listPending(ack.state), []);
  assert.equal(acknowledgeRevision(ack.state, token(next.pending!)).status, "stale");
  assert.equal(observeAssignment(ack.state, { ...row, sub_score: 3 }).status, "unchanged");
  const reverted = observeAssignment(ack.state, row); assert.equal(reverted.pending!.revision, 3); assert.notEqual(reverted.pending!.identity, first.pending!.identity);
});
test("new assignment creates revision1; preserves snapshots/watermark and all protected content", () => {
  const doc = fixture(); const state = createMirrorState(doc);
  const next = observeAssignment(state, { ...row, canvas_id: 990000021 });
  assert.equal(next.pending!.revision, 1); assert.equal(next.state.document.assignments.length, 2);
  for (const key of ["protectedPages", "snapshots", "watermark", "courses", "notionState", "binding"] as const) assert.deepEqual(next.state.document[key], doc[key]);
  const restored = validateMirrorState(JSON.parse(JSON.stringify(next.state)));
  assert.deepEqual(listPending(restored), listPending(next.state));
});
test("DoNotSync freezes canonical row, pending admission and acknowledgment without losing prior pending", () => {
  const doc = fixture(); doc.protectedPages[0]!.doNotSync = true;
  const state = createMirrorState(doc); const result = observeAssignment(state, { ...row, sub_score: 10 });
  assert.equal(result.status, "frozen"); assert.deepEqual(result.state, state); assert.deepEqual(listPending(result.state), []);
  const prior = observeAssignment(createMirrorState(fixture()), { ...row, sub_score: 2 });
  prior.state.document.protectedPages[0]!.doNotSync = true;
  const ack = acknowledgeRevision(prior.state, token(prior.pending!));
  assert.equal(ack.status, "frozen"); assert.deepEqual(ack.state, prior.state); assert.equal(ack.state.revisions[0]!.pending, true); assert.deepEqual(listPending(ack.state), []);
});
test("malformed state, unknown fields, non-synthetic observations and unresolved import fail closed", () => {
  for (const edit of [(s: any) => s.stateVersion = 2, (s: any) => s.revisions.push({ ...s.revisions[0] }), (s: any) => s.revisions[0].revision = -1, (s: any) => s.revisions[0].pending = true, (s: any) => s.secret = "dummy", (s: any) => s.document.pendingProjections.push({})]) {
    const s = createMirrorState(fixture()); edit(s); assert.throws(() => validateMirrorState(s));
  }
  const state = createMirrorState(fixture());
  for (const bad of [{ ...row, canvas_id: 1 }, { ...row, course_id: 990000099 }, { ...row, notes: [] }, { ...row, sub_score: NaN }]) assert.throws(() => observeAssignment(state, bad));
  const exhausted = createMirrorState(fixture()); exhausted.revisions[0]!.revision = Number.MAX_SAFE_INTEGER;
  assert.throws(() => observeAssignment(exhausted, { ...row, sub_score: 2 }));
  const getter = createMirrorState(fixture()); Object.defineProperty(getter.revisions, "0", { get() { throw Error("accessor invoked"); }, enumerable: true });
  assert.throws(() => validateMirrorState(getter), /Invalid synthetic mirror/);
});
