import Database from "better-sqlite3";
import { config } from "../config.js";

/**
 * Canonical local mirror of Canvas state. Notion is a projection of this.
 * Every observed assignment state is snapshotted so we keep full history.
 */

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  courses_seen INTEGER,
  assignments_seen INTEGER,
  changes_pushed INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS courses (
  canvas_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  course_code TEXT,
  term_id INTEGER,
  workflow_state TEXT,
  start_at TEXT,
  end_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS assignments (
  canvas_id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(canvas_id),
  name TEXT NOT NULL,
  due_at TEXT,
  calendar_due_at TEXT,
  unlock_at TEXT,
  lock_at TEXT,
  points_possible REAL,
  description_html TEXT,
  submission_types TEXT,
  group_id INTEGER,
  group_name TEXT,
  group_weight REAL,
  is_quiz INTEGER NOT NULL DEFAULT 0,
  position INTEGER,
  updated_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  -- last observed submission state
  sub_workflow_state TEXT,
  sub_score REAL,
  sub_grade TEXT,
  sub_submitted_at TEXT,
  sub_graded_at TEXT,
  sub_attempts INTEGER,
  sub_late INTEGER,
  sub_excused INTEGER,
  sub_missing INTEGER
);
CREATE INDEX IF NOT EXISTS idx_assignments_course ON assignments(course_id);
CREATE INDEX IF NOT EXISTS idx_assignments_due ON assignments(due_at);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(canvas_id),
  captured_at TEXT NOT NULL,
  changed_fields TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_assignment ON snapshots(assignment_id);
`);

// Existing installations predate calendar_due_at. Backfill the exact Canvas
// timestamp so only deadlines affected by a newer projection rule are diffed.
const assignmentColumns = db.pragma("table_info(assignments)") as { name: string }[];
if (!assignmentColumns.some((column) => column.name === "calendar_due_at")) {
  db.exec("ALTER TABLE assignments ADD COLUMN calendar_due_at TEXT");
  db.exec("UPDATE assignments SET calendar_due_at = due_at");
}

export function getMeta(key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** Fields of the assignments table we diff to decide whether Notion needs a push. */
const DIFF_FIELDS = [
  "name", "due_at", "calendar_due_at", "unlock_at", "lock_at", "points_possible", "description_html",
  "submission_types", "group_id", "group_name", "group_weight", "is_quiz", "position",
  "sub_workflow_state", "sub_score", "sub_grade", "sub_submitted_at", "sub_graded_at",
  "sub_attempts", "sub_late", "sub_excused", "sub_missing",
] as const;

export interface AssignmentRow {
  canvas_id: number;
  course_id: number;
  name: string;
  due_at: string | null;
  calendar_due_at: string | null;
  unlock_at: string | null;
  lock_at: string | null;
  points_possible: number | null;
  description_html: string | null;
  submission_types: string | null;
  group_id: number | null;
  group_name: string | null;
  group_weight: number | null;
  is_quiz: number;
  position: number | null;
  updated_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  sub_workflow_state: string | null;
  sub_score: number | null;
  sub_grade: string | null;
  sub_submitted_at: string | null;
  sub_graded_at: string | null;
  sub_attempts: number | null;
  sub_late: number | null;
  sub_excused: number | null;
  sub_missing: number | null;
  [key: string]: unknown;
}

export interface AssignmentInput {
  canvas_id: number;
  course_id: number;
  name: string;
  due_at: string | null;
  calendar_due_at: string | null;
  unlock_at: string | null;
  lock_at: string | null;
  points_possible: number | null;
  description_html: string | null;
  submission_types: string | null;
  group_id: number | null;
  group_name: string | null;
  group_weight: number | null;
  is_quiz: boolean;
  position: number | null;
  updated_at: string | null;
  sub_workflow_state: string | null;
  sub_score: number | null;
  sub_grade: string | null;
  sub_submitted_at: string | null;
  sub_graded_at: string | null;
  sub_attempts: number | null;
  sub_late: boolean | null;
  sub_excused: boolean | null;
  sub_missing: boolean | null;
}

const now = () => new Date().toISOString();

const upsertCourseStmt = db.prepare(`
  INSERT INTO courses (canvas_id, name, course_code, term_id, workflow_state, start_at, end_at, first_seen_at, last_seen_at, active)
  VALUES (@canvas_id, @name, @course_code, @term_id, @workflow_state, @start_at, @end_at, @ts, @ts, 1)
  ON CONFLICT(canvas_id) DO UPDATE SET
    name = excluded.name, course_code = excluded.course_code, term_id = excluded.term_id,
    workflow_state = excluded.workflow_state, start_at = excluded.start_at, end_at = excluded.end_at,
    last_seen_at = excluded.last_seen_at, active = 1
`);

export function upsertCourse(c: {
  id: number; name?: string; course_code?: string; enrollment_term_id?: number;
  workflow_state?: string; start_at?: string | null; end_at?: string | null;
}): void {
  upsertCourseStmt.run({
    canvas_id: c.id,
    name: c.name ?? `Course ${c.id}`,
    course_code: c.course_code ?? null,
    term_id: c.enrollment_term_id ?? null,
    workflow_state: c.workflow_state ?? null,
    start_at: c.start_at ?? null,
    end_at: c.end_at ?? null,
    ts: now(),
  });
}

const getAssignmentStmt = db.prepare("SELECT * FROM assignments WHERE canvas_id = ?");
const insertAssignmentStmt = db.prepare(`
  INSERT INTO assignments (
    canvas_id, course_id, name, due_at, calendar_due_at, unlock_at, lock_at, points_possible, description_html,
    submission_types, group_id, group_name, group_weight, is_quiz, position, updated_at,
    first_seen_at, last_seen_at,
    sub_workflow_state, sub_score, sub_grade, sub_submitted_at, sub_graded_at,
    sub_attempts, sub_late, sub_excused, sub_missing
  ) VALUES (
    @canvas_id, @course_id, @name, @due_at, @calendar_due_at, @unlock_at, @lock_at, @points_possible, @description_html,
    @submission_types, @group_id, @group_name, @group_weight, @is_quiz, @position, @updated_at,
    @ts, @ts,
    @sub_workflow_state, @sub_score, @sub_grade, @sub_submitted_at, @sub_graded_at,
    @sub_attempts, @sub_late, @sub_excused, @sub_missing
  )
`);
const updateAssignmentStmt = db.prepare(`
  UPDATE assignments SET
    name = @name, due_at = @due_at, calendar_due_at = @calendar_due_at, unlock_at = @unlock_at, lock_at = @lock_at,
    points_possible = @points_possible, description_html = @description_html,
    submission_types = @submission_types, group_id = @group_id, group_name = @group_name,
    group_weight = @group_weight, is_quiz = @is_quiz, position = @position, updated_at = @updated_at,
    last_seen_at = @ts,
    sub_workflow_state = @sub_workflow_state, sub_score = @sub_score, sub_grade = @sub_grade,
    sub_submitted_at = @sub_submitted_at, sub_graded_at = @sub_graded_at,
    sub_attempts = @sub_attempts, sub_late = @sub_late, sub_excused = @sub_excused, sub_missing = @sub_missing
  WHERE canvas_id = @canvas_id
`);
const insertSnapshotStmt = db.prepare(`
  INSERT INTO snapshots (assignment_id, captured_at, changed_fields, data) VALUES (?, ?, ?, ?)
`);

export interface UpsertResult {
  isNew: boolean;
  changedFields: string[];
}

/**
 * Writes an observed assignment state. Snapshots when anything we track changed.
 * Returns whether Notion needs a push (new or changed).
 */
export function upsertAssignment(input: AssignmentInput): UpsertResult {
  const row = getAssignmentStmt.get(input.canvas_id) as AssignmentRow | undefined;
  const bool = (v: boolean | null | undefined): number | null => (v == null ? null : v ? 1 : 0);
  const record = {
    ...input,
    is_quiz: input.is_quiz ? 1 : 0,
    sub_late: bool(input.sub_late),
    sub_excused: bool(input.sub_excused),
    sub_missing: bool(input.sub_missing),
    ts: now(),
  };

  if (!row) {
    insertAssignmentStmt.run(record);
    insertSnapshotStmt.run(input.canvas_id, now(), JSON.stringify(["__new__"]), JSON.stringify(record));
    return { isNew: true, changedFields: ["__new__"] };
  }

  const changed = DIFF_FIELDS.filter((f) => !deepEq(row[f], record[f]));
  if (changed.length === 0) {
    db.prepare("UPDATE assignments SET last_seen_at = ? WHERE canvas_id = ?").run(record.ts, input.canvas_id);
    return { isNew: false, changedFields: [] };
  }

  updateAssignmentStmt.run(record);
  insertSnapshotStmt.run(input.canvas_id, now(), JSON.stringify(changed), JSON.stringify(record));
  return { isNew: false, changedFields: [...changed] };
}

export function getAssignment(id: number): AssignmentRow | undefined {
  return getAssignmentStmt.get(id) as AssignmentRow | undefined;
}

export function listActiveCourses(): { canvas_id: number; name: string; active: number }[] {
  return db.prepare("SELECT canvas_id, name, active FROM courses WHERE active = 1 ORDER BY name").all() as never;
}

export function listAssignmentsForCourses(courseIds: number[]): AssignmentRow[] {
  const rows: AssignmentRow[] = [];
  const stmt = db.prepare("SELECT * FROM assignments WHERE course_id = ?");
  for (const id of courseIds) rows.push(...(stmt.all(id) as AssignmentRow[]));
  return rows;
}

export function snapshotsFor(assignmentId: number) {
  return db
    .prepare("SELECT captured_at, changed_fields, data FROM snapshots WHERE assignment_id = ? ORDER BY id")
    .all(assignmentId) as { captured_at: string; changed_fields: string; data: string }[];
}

export function startSyncRun(): number {
  const r = db.prepare("INSERT INTO sync_runs (started_at) VALUES (?)").run(now());
  return Number(r.lastInsertRowid);
}

export function finishSyncRun(
  id: number,
  status: "ok" | "error",
  counts: { courses_seen?: number; assignments_seen?: number; changes_pushed?: number },
  error?: string,
): void {
  db.prepare(
    `UPDATE sync_runs SET finished_at = ?, status = ?, courses_seen = ?, assignments_seen = ?, changes_pushed = ?, error = ? WHERE id = ?`,
  ).run(now(), status, counts.courses_seen ?? null, counts.assignments_seen ?? null, counts.changes_pushed ?? null, error ?? null, id);
}

export function lastSyncRun() {
  return db
    .prepare("SELECT * FROM sync_runs WHERE status != 'running' ORDER BY id DESC LIMIT 1")
    .get() as
    | { id: number; started_at: string; finished_at: string; status: string; courses_seen: number | null; assignments_seen: number | null; changes_pushed: number | null; error: string | null }
    | undefined;
}

/** Start of the last successful run — used as the `updated_since` watermark. */
export function lastSuccessfulSyncStart(): Date | undefined {
  const row = db.prepare("SELECT started_at FROM sync_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1").get() as
    | { started_at: string }
    | undefined;
  return row ? new Date(row.started_at) : undefined;
}

function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (typeof a === "string" || typeof b === "string") {
    // JSON-encoded columns (submission_types) compare parsed.
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
