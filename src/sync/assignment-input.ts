import type { CanvasAssignment, CanvasSubmission } from "../canvas/types.js";
import { notionCalendarDate } from "../notion/calendar-date.js";
import { isQuizAssignment } from "./quiz-classifier.js";

/** Pure projection of source data; no filesystem, auth, storage or network. */
export function toAssignmentInput(
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
