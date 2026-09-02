import type { Client } from "@notionhq/client";
import { savedDbIds } from "./schema.js";
import { detailsBlocks, replaceDetailsSection, activityBlock } from "./blocks.js";
import type { AssignmentRow } from "../store/db.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Projects SQLite state into Notion. Ownership model:
 *  - Sync owns every mirrored property + the Details body section + Activity log.
 *  - Humans own: "In Progress", "Hidden", "Do Not Sync" checkboxes, and the Notes
 *    body section.
 *  - "Do Not Sync" freezes the whole page.
 */

const canvasUrl = (domain: string, courseId: number, assignmentId: number) =>
  `https://${domain}/courses/${courseId}/assignments/${assignmentId}`;

function priority(groupWeight: number | null): string {
  if (groupWeight == null) return "Low";
  if (groupWeight <= 0.1) return "Low";
  if (groupWeight <= 0.2) return "Medium";
  return "High";
}

function syncStatus(row: AssignmentRow): string {
  if (row.sub_excused) return "Graded";
  if (row.sub_score != null || row.sub_grade != null) return "Graded";
  if (row.sub_submitted_at != null || ["submitted", "graded", "complete"].includes(row.sub_workflow_state ?? "")) {
    return "Submitted";
  }
  if (row.sub_missing) return "Missing";
  return "Not started";
}

function date(dateStr: string | null): { date: { start: string } } | undefined {
  return dateStr ? { date: { start: dateStr } } : undefined;
}

export function assignmentProperties(
  row: AssignmentRow,
  domain: string,
  courseLabel?: string,
): Record<string, any> {
  const pp = row.points_possible ?? 0;
  const title = courseLabel?.trim() ? `[${courseLabel.trim()}] ${row.name}` : row.name;
  const props: Record<string, any> = {
    // Notion Calendar uses the title property as the event label. Prefixing it
    // keeps the class identifiable even when the rest of the card is collapsed.
    Name: { title: [{ text: { content: title } }] },
    AssignmentID: { number: row.canvas_id },
    Status: { select: { name: syncStatus(row) } },
    Late: { checkbox: Boolean(row.sub_late) },
    Quiz: { checkbox: Boolean(row.is_quiz) },
    "Canvas URL": { url: canvasUrl(domain, row.course_id, row.canvas_id) },
    Priority: { select: { name: priority(row.group_weight) } },
  };
  const due = date(row.calendar_due_at ?? row.due_at);
  if (due) props["Due Date"] = due;
  const unlock = date(row.unlock_at);
  if (unlock) props["Unlock Date"] = unlock;
  const lock = date(row.lock_at);
  if (lock) props["Lock Date"] = lock;
  if (row.points_possible != null) props["Points Possible"] = { number: row.points_possible };
  if (row.sub_score != null) props["Score"] = { number: row.sub_score };
  if (row.sub_score != null && pp > 0) props["Score %"] = { number: row.sub_score / pp };
  if (row.group_name) props["Assignment Group"] = { select: { name: row.group_name } };
  if (row.group_weight != null) props["Group Weight"] = { number: row.group_weight };
  if (row.sub_attempts != null) props["Attempts"] = { number: row.sub_attempts };
  if (row.submission_types && row.submission_types !== "[]") {
    props["Submission Types"] = {
      multi_select: JSON.parse(row.submission_types).map((t: string) => ({ name: t })),
    };
  }
  return props;
}

async function findPage(client: Client, dsId: string, prop: string, value: number): Promise<string | null> {
  const res = await client.dataSources.query({
    data_source_id: dsId,
    filter: { property: prop, number: { equals: value } },
    page_size: 1,
  });
  return res.results[0]?.id ?? null;
}

export async function upsertCoursePage(
  client: Client,
  course: { canvas_id: number; name: string; course_code: string | null; term_id: number | null; start_at: string | null; end_at: string | null },
  domain: string,
): Promise<string> {
  const { coursesDsId } = savedDbIds();
  const existing = await findPage(client, coursesDsId, "CourseID", course.canvas_id);
  const props: Record<string, any> = {
    Name: { title: [{ text: { content: course.name } }] },
    CourseID: { number: course.canvas_id },
    Status: { select: { name: "Active" } },
    "Canvas URL": { url: `https://${domain}/courses/${course.canvas_id}` },
  };
  if (course.course_code) props["Code"] = { rich_text: [{ text: { content: course.course_code } }] };
  if (course.term_id != null) props["Term"] = { number: course.term_id };
  if (course.start_at) props["Start"] = { date: { start: course.start_at } };
  if (course.end_at) props["End"] = { date: { start: course.end_at } };

  if (existing) {
    await client.pages.update({ page_id: existing, properties: props });
    return existing;
  }
  const page = await client.pages.create({ parent: { database_id: savedDbIds().coursesDbId }, properties: props });
  return page.id;
}

export async function upsertAssignmentPage(
  client: Client,
  row: AssignmentRow,
  domain: string,
  opts: {
    isNew: boolean;
    changedFields: string[];
    coursePageId: string | null;
    courseLabel: string;
  },
): Promise<{ pageId: string; pushed: boolean }> {
  const { assignmentsDbId, assignmentsDsId } = savedDbIds();
  const existingPageId = await findPage(client, assignmentsDsId, "AssignmentID", row.canvas_id);

  // User-override flags live in Notion; fetch them when the page exists.
  let hidden = false;
  let doNotSync = false;
  let inProgress = false;
  if (existingPageId) {
    const page = (await client.pages.retrieve({ page_id: existingPageId })) as {
      properties: Record<string, { checkbox?: boolean }>;
    };
    hidden = Boolean(page.properties["Hidden"]?.checkbox);
    doNotSync = Boolean(page.properties["Do Not Sync"]?.checkbox);
    inProgress = Boolean(page.properties["In Progress"]?.checkbox);
  }

  if (doNotSync) return { pageId: existingPageId ?? "", pushed: false };

  const props: Record<string, any> = assignmentProperties(row, domain, opts.courseLabel);
  if (existingPageId) {
    // Humans own these — preserve what's on the page, never overwrite.
    props["Hidden"] = { checkbox: hidden };
    props["In Progress"] = { checkbox: inProgress };
  }
  if (opts.coursePageId) props["Course"] = { relation: [{ id: opts.coursePageId }] };

  let pageId: string;
  if (existingPageId) {
    await client.pages.update({ page_id: existingPageId, properties: props });
    pageId = existingPageId;
  } else {
    const page = await client.pages.create({ parent: { database_id: assignmentsDbId }, properties: props });
    pageId = page.id;
  }

  // Body: full render on create or when the description changed.
  const descriptionChanged = opts.isNew || opts.changedFields.includes("description_html");
  if (descriptionChanged) {
    await replaceDetailsSection(client, pageId, detailsBlocks(row));
  }

  // Activity log for notable property changes.
  const notable = opts.changedFields.filter((f) => f !== "description_html" && f !== "__new__");
  if (notable.length > 0 && !opts.isNew) {
    const entry = `${new Date().toISOString().slice(0, 16).replace("T", " ")} — changed: ${notable.join(", ")}`;
    await client.blocks.children.append({ block_id: pageId, children: [activityBlock(entry)] as any });
  }

  return { pageId, pushed: true };
}
