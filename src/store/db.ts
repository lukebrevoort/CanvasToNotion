import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { createStore } from "./core.js";
export type { AssignmentRow, AssignmentInput, UpsertResult, PendingProjection } from "./core.js";

/** Node compatibility wrapper. The canonical logic is shared with injected SQL ports. */
export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export const {
  getMeta,
  setMeta,
  upsertCourse,
  upsertAssignment,
  pendingProjectionsForCourse,
  completeProjection,
  getAssignment,
  listActiveCourses,
  listAssignmentsForCourses,
  snapshotsFor,
  startSyncRun,
  finishSyncRun,
  lastSyncRun,
  lastSuccessfulSyncStart
} = createStore(db, { now: () => new Date().toISOString(), randomUUID });
