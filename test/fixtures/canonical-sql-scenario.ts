/** Deterministic dummy-only scenario, shared by native SQLite and actual workerd. */
import { createStore, type AssignmentInput, type StoreSqlPort } from '../../src/store/core.js';
export function canonicalScenario(db: StoreSqlPort) {
  db.pragma('foreign_keys = ON');
  let tick = 0, revision = 0;
  const store = createStore(db, { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(), randomUUID: () => `SYNTHETIC_revision_${++revision}` });
  store.upsertCourse({ id: 990000001, name: 'Dummy course' });
  const input: AssignmentInput = {
    canvas_id: 990000002, course_id: 990000001, name: 'Dummy assignment', due_at: null, calendar_due_at: null,
    unlock_at: null, lock_at: null, points_possible: 10, description_html: '<p>Dummy</p>', submission_types: '["online_text_entry"]',
    group_id: null, group_name: null, group_weight: null, is_quiz: false, position: 1, updated_at: null,
    sub_workflow_state: 'unsubmitted', sub_score: null, sub_grade: null, sub_submitted_at: null, sub_graded_at: null,
    sub_attempts: null, sub_late: false, sub_excused: null, sub_missing: false,
  };
  const created = store.upsertAssignment(input);
  const originalPending = store.pendingProjectionsForCourse(input.course_id)[0]!;
  const unchanged = store.upsertAssignment(input);
  const forced = store.upsertAssignment(input, { forceProjection: true });
  const forcedPending = store.pendingProjectionsForCourse(input.course_id);
  const changed = store.upsertAssignment({ ...input, name: 'Dummy revised', sub_score: 4 });
  store.completeProjection(originalPending);
  const staleAckPending = store.pendingProjectionsForCourse(input.course_id);
  store.completeProjection(staleAckPending[0]!);
  store.setMeta('SYNTHETIC_key', 'Dummy value');
  const successfulRun = store.startSyncRun();
  store.finishSyncRun(successfulRun, 'ok', { courses_seen: 1, assignments_seen: 1, changes_pushed: 1 });
  const failedRun = store.startSyncRun();
  store.finishSyncRun(failedRun, 'error', {}, 'Dummy failure');
  const runningRun = store.startSyncRun();
  let foreignKeyRejected = false;
  try { store.upsertAssignment({ ...input, canvas_id: 990000003, course_id: 999999999 }); } catch { foreignKeyRejected = true; }
  db.exec('CREATE TABLE nested_test (id INTEGER PRIMARY KEY, value TEXT); CREATE INDEX nested_value ON nested_test(value)');
  const insert = db.prepare('INSERT INTO nested_test VALUES (?, ?)');
  const metadata = insert.run(1, 'Dummy metadata');
  const lexer = db.prepare("SELECT @value AS repeated_a, @value AS repeated_b, '@literal; ?' AS literal /* @ignored; */ -- @line\n, @other AS other")
    .get({ value: 'Dummy binding', other: null });
  const updateMetadata = db.prepare('UPDATE nested_test SET value = ? WHERE id = ?').run('Dummy metadata', 1);
  const absentMetadata = db.prepare('DELETE FROM nested_test WHERE id = ?').run(99999);
  try { db.transaction(() => { store.upsertAssignment({ ...input, canvas_id: 990000004 }); throw Error('Dummy canonical outer rollback'); })(); } catch {}
  const canonicalRollback = { assignment: store.getAssignment(990000004) ?? null, snapshots: store.snapshotsFor(990000004), pending: store.pendingProjectionsForCourse(input.course_id) };
  try { db.transaction(() => { insert.run(30, 'thenable rollback'); return Promise.resolve(1); })(); } catch {}
  const outer = db.transaction((id: number) => {
    insert.run(id, 'outer');
    try { db.transaction(() => { insert.run(id + 1, 'inner rollback'); throw Error('Dummy inner'); })(); } catch {}
    insert.run(id + 2, 'outer continued');
  });
  outer(10);
  try { db.transaction(() => { insert.run(20, 'outer rollback'); db.transaction(() => { insert.run(21, 'inner success'); })(); throw Error('Dummy outer'); })(); } catch {}
  return { created, unchanged, forced, forcedPending, changed, staleAckPending, foreignKeyRejected, metadata,
    successfulRun, failedRun, runningRun, lexer, updateMetadata, absentMetadata, canonicalRollback, nestedRows: db.prepare('SELECT * FROM nested_test ORDER BY id').all(),
    ...inspectCanonical(db, store),
  };
}
export function inspectCanonical(db: StoreSqlPort, store = createStore(db, { now: () => '2026-01-01T00:00:00.000Z', randomUUID: () => 'SYNTHETIC_unused' })) {
  return { assignment: store.getAssignment(990000002), courses: store.listActiveCourses(), assignments: store.listAssignmentsForCourses([990000001]),
    snapshots: store.snapshotsFor(990000002), pending: store.pendingProjectionsForCourse(990000001), meta: store.getMeta('SYNTHETIC_key'),
    lastRun: store.lastSyncRun(), watermark: store.lastSuccessfulSyncStart()?.toISOString(),
    orphan: store.getAssignment(990000003) ?? null, orphanSnapshots: store.snapshotsFor(990000003),
    nested: db.prepare('SELECT * FROM nested_test ORDER BY id').all(),
    runRows: db.prepare('SELECT * FROM sync_runs ORDER BY id').all(),
  };
}
