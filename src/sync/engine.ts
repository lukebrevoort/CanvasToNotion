import { config } from "../config.js";
import { resolveAuth } from "../canvas/auth.js";
import { CanvasClient } from "../canvas/client.js";
import type { CanvasAssignment, CanvasSubmission } from "../canvas/types.js";
import {
  db, upsertCourse, upsertAssignment, startSyncRun, finishSyncRun,
  lastSuccessfulSyncStart, getAssignment, pendingProjectionsForCourse, completeProjection,
} from "../store/db.js";
import { notion } from "../notion/schema.js";
import { upsertCoursePage, upsertAssignmentPage } from "../notion/projector.js";
import { notionCalendarDate } from "../notion/calendar-date.js";
import { isQuizAssignment } from "./quiz-classifier.js";

/**
 * Sync pipeline per run:
 *   Canvas → SQLite (canonical mirror + snapshots) → Notion (projection)
 * Pending projections survive failed attempts and unchanged Canvas observations.
 */

export interface SyncResult {
  runId: number;
  coursesSeen: number;
  assignmentsSeen: number;
  changesPushed: number;
  errors: string[];
}

export async function runSync(opts: { full?: boolean } = {}): Promise<SyncResult> {
  const runId = startSyncRun();
  const errors: string[] = [];
  let coursesSeen = 0;
  let assignmentsSeen = 0;
  let changesPushed = 0;

  const canvas = new CanvasClient(config.canvasDomain, resolveAuth());
  const notionClient = notion();

  // Watermark: only fetch assignments updated since last good run (unless full).
  const since = opts.full ? undefined : lastSuccessfulSyncStart();

  try {
    const user = await canvas.me();
    const coursePageIds = new Map<number, string>();
    const courseTimeZones = new Map<number, string | null>();

    for await (const course of canvas.courses("active")) {
      coursesSeen++;
      upsertCourse(course);
      coursePageIds.set(course.id, null as unknown as string);
      courseTimeZones.set(course.id, course.time_zone ?? null);
    }

    for (const [courseId] of coursePageIds) {
      try {
        // Ensure course page exists in Notion.
        const courseRow = db.prepare("SELECT * FROM courses WHERE canvas_id = ?").get(courseId) as
          | { canvas_id: number; name: string; course_code: string | null; term_id: number | null; start_at: string | null; end_at: string | null }
          | undefined;
        if (!courseRow) continue;
        const coursePageId = await upsertCoursePage(notionClient, courseRow, config.canvasDomain);
        coursePageIds.set(courseId, coursePageId);

        // Assignment groups → weights.
        const groups = new Map<number, { name: string | null; weight: number | null }>();
        for await (const g of canvas.assignmentGroups(courseId)) {
          groups.set(g.id, { name: g.name ?? null, weight: g.group_weight != null ? g.group_weight / 100 : null });
        }

        for await (const a of canvas.assignments(courseId, since)) {
          assignmentsSeen++;
          try {
            const submission = await fetchSubmission(canvas, a, user.id);
            upsertAssignment(toInput(a, submission, groups, courseTimeZones.get(courseId) ?? null), {
              forceProjection: opts.full,
            });
          } catch (e) {
            errors.push(`assignment ${a.id} (${a.name}): ${errText(e)}`);
          }
        }

        // Drain durable work independently of the incremental Canvas response.
        // A failed push or Do Not Sync skip keeps its pending state for later.
        for (const pending of pendingProjectionsForCourse(courseId)) {
          try {
            const row = getAssignment(pending.assignment_id);
            if (!row) continue;
            const push = await upsertAssignmentPage(notionClient, row, config.canvasDomain, {
              isNew: Boolean(pending.is_new),
              changedFields: JSON.parse(pending.changed_fields) as string[],
              coursePageId: coursePageIds.get(courseId) ?? null,
              courseLabel: courseRow.course_code?.trim() || courseRow.name,
              forceDetails: Boolean(pending.force_details),
            });
            if (push.pushed) {
              completeProjection(pending);
              changesPushed++;
            }
          } catch (e) {
            errors.push(`assignment ${pending.assignment_id}: ${errText(e)}`);
          }
        }
      } catch (e) {
        errors.push(`course ${courseId}: ${errText(e)}`);
      }
    }

    finishSyncRun(runId, errors.length > 0 ? "error" : "ok", { courses_seen: coursesSeen, assignments_seen: assignmentsSeen, changes_pushed: changesPushed }, errors.slice(0, 5).join(" | "));
  } catch (e) {
    finishSyncRun(runId, "error", { courses_seen: coursesSeen, assignments_seen: assignmentsSeen, changes_pushed: changesPushed }, errText(e));
    throw e;
  }

  return { runId, coursesSeen, assignmentsSeen, changesPushed, errors };
}

/**
 * Submissions ride along in the assignments call (include[]=submission), so this
 * is normally free. It only makes a separate API call when Canvas omitted it.
 */
async function fetchSubmission(
  canvas: CanvasClient,
  assignment: CanvasAssignment,
  userId: number,
): Promise<CanvasSubmission | null> {
  const embedded = (assignment as unknown as { submission?: CanvasSubmission }).submission;
  if (embedded && embedded.assignment_id != null) return embedded;
  try {
    return await canvas.submission(assignment.course_id, assignment.id, userId);
  } catch {
    return null;
  }
}

function toInput(
  a: CanvasAssignment,
  sub: CanvasSubmission | null,
  groups: Map<number, { name: string | null; weight: number | null }>,
  courseTimeZone: string | null,
) {
  const group = groups.get(a.assignment_group_id ?? -1);
  return {
    canvas_id: a.id,
    course_id: a.course_id,
    name: a.name ?? `Assignment ${a.id}`,
    due_at: a.due_at ?? null,
    calendar_due_at: notionCalendarDate(a.due_at ?? null, courseTimeZone),
    unlock_at: a.unlock_at ?? null,
    lock_at: a.lock_at ?? null,
    points_possible: a.points_possible ?? null,
    description_html: a.description ?? null,
    submission_types: JSON.stringify(a.submission_types ?? []),
    group_id: a.assignment_group_id ?? null,
    group_name: group?.name ?? null,
    group_weight: group?.weight ?? null,
    is_quiz: isQuizAssignment(a),
    position: a.position ?? null,
    updated_at: a.updated_at ?? null,
    sub_workflow_state: sub?.workflow_state ?? null,
    sub_score: sub?.score ?? null,
    sub_grade: sub?.grade ?? null,
    sub_submitted_at: sub?.submitted_at ?? null,
    sub_graded_at: sub?.graded_at ?? null,
    sub_attempts: sub?.attempt ?? null,
    sub_late: sub?.late ?? null,
    sub_excused: sub?.excused ?? null,
    sub_missing: sub?.missing ?? null,
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
