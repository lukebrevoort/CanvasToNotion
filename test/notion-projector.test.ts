import assert from "node:assert/strict";
import test from "node:test";
import { assignmentProperties } from "../src/notion/projector.js";
import type { AssignmentRow } from "../src/store/db.js";

test("projects the stored calendar deadline into Notion", () => {
  const row = {
    canvas_id: 694697,
    course_id: 189207,
    name: "Syllabus Quiz",
    due_at: "2026-09-09T03:59:59Z",
    calendar_due_at: "2026-09-08",
    unlock_at: null,
    lock_at: null,
    points_possible: 100,
    description_html: null,
    submission_types: "[\"external_tool\"]",
    group_id: null,
    group_name: null,
    group_weight: null,
    is_quiz: 1,
    position: 1,
    updated_at: null,
    first_seen_at: "2026-08-27T04:57:36Z",
    last_seen_at: "2026-09-01T12:53:48Z",
    sub_workflow_state: "unsubmitted",
    sub_score: null,
    sub_grade: null,
    sub_submitted_at: null,
    sub_graded_at: null,
    sub_attempts: null,
    sub_late: 0,
    sub_excused: null,
    sub_missing: 0,
  } as AssignmentRow;

  const properties = assignmentProperties(row, "example.instructure.com");
  assert.deepEqual(properties["Due Date"], { date: { start: "2026-09-08" } });
});
