import { Client } from "@notionhq/client";
import { config, requireEnv } from "../config.js";
import fs from "node:fs";

/**
 * Creates "🎓 Canvas HQ" with the Assignments + Courses databases under the
 * configured parent page. Notion SDK v5: databases have data sources; queries
 * and property-schema updates go through client.dataSources.
 */

export const ASSIGNMENT_STATUS_OPTIONS = [
  { name: "Not started", color: "gray" },
  { name: "Submitted", color: "blue" },
  { name: "Graded", color: "green" },
  { name: "Missing", color: "red" },
] as const;

export function notion(): Client {
  return new Client({ auth: requireEnv("NOTION_TOKEN", config.notionToken) });
}

export interface DbIds {
  assignmentsDbId: string;
  assignmentsDsId: string;
  coursesDbId: string;
  coursesDsId: string;
}

export function savedDbIds(): DbIds {
  try {
    const s = JSON.parse(fs.readFileSync(config.statePath, "utf8")) as Partial<DbIds>;
    return {
      assignmentsDbId: s.assignmentsDbId ?? config.assignmentsDbId,
      assignmentsDsId: s.assignmentsDsId ?? config.assignmentsDbId,
      coursesDbId: s.coursesDbId ?? config.coursesDbId,
      coursesDsId: s.coursesDsId ?? config.coursesDbId,
    };
  } catch {
    return {
      assignmentsDbId: config.assignmentsDbId,
      assignmentsDsId: config.assignmentsDbId,
      coursesDbId: config.coursesDbId,
      coursesDsId: config.coursesDbId,
    };
  }
}

export function saveDbIds(ids: DbIds): void {
  fs.writeFileSync(config.statePath, JSON.stringify(ids, null, 2));
}

function dataSourceId(db: { id: string; data_sources?: { id: string }[] }): string {
  return db.data_sources?.[0]?.id ?? db.id;
}

export async function createCanvasHq(): Promise<DbIds> {
  const client = notion();
  const parentId = requireEnv("NOTION_HQ_PAGE_ID", config.hqPageId);
  const parent = { type: "page_id" as const, page_id: parentId };

  const assignmentsDb = await client.databases.create({
    parent,
    title: [{ type: "text", text: { content: "Assignments" } }],
    initial_data_source: {
      properties: {
        Name: { title: {} },
        AssignmentID: { number: {} },
        Status: { select: { options: [...ASSIGNMENT_STATUS_OPTIONS] } },
        "Due Date": { date: {} },
        "Unlock Date": { date: {} },
        "Lock Date": { date: {} },
        "In Progress": { checkbox: {} },
        Hidden: { checkbox: {} },
        "Do Not Sync": { checkbox: {} },
        Late: { checkbox: {} },
        Score: { number: {} },
        "Points Possible": { number: {} },
        "Score %": { number: { format: "percent" } },
        "Assignment Group": { select: {} },
        "Group Weight": { number: {} },
        Priority: {
          select: {
            options: [
              { name: "Low", color: "blue" },
              { name: "Medium", color: "yellow" },
              { name: "High", color: "red" },
            ],
          },
        },
        "Submission Types": { multi_select: {} },
        Quiz: { checkbox: {} },
        Attempts: { number: {} },
        "Canvas URL": { url: {} },
      },
    },
  });

  const coursesDb = await client.databases.create({
    parent,
    title: [{ type: "text", text: { content: "Courses" } }],
    initial_data_source: {
      properties: {
        Name: { title: {} },
        CourseID: { number: {} },
        Code: { rich_text: {} },
        Term: { number: {} },
        Status: {
          select: {
            options: [
              { name: "Active", color: "green" },
              { name: "Archived", color: "gray" },
            ],
          },
        },
        Start: { date: {} },
        End: { date: {} },
        "Canvas URL": { url: {} },
      },
    },
  });

  // Wire the Assignments → Courses relation now that both data sources exist.
  await client.dataSources.update({
    data_source_id: dataSourceId(assignmentsDb),
    properties: {
      Course: {
        relation: {
          data_source_id: dataSourceId(coursesDb),
          type: "single_property",
          single_property: {},
        },
      },
    },
  });

  const ids: DbIds = {
    assignmentsDbId: assignmentsDb.id,
    assignmentsDsId: dataSourceId(assignmentsDb),
    coursesDbId: coursesDb.id,
    coursesDsId: dataSourceId(coursesDb),
  };
  saveDbIds(ids);
  return ids;
}
