/** Pure in-memory dummy HTTP service shared by Node and actual workerd tests.
 * No global fetch, real provider, credentials, persistence or deployment. */
import type { Client } from "@notionhq/client";
import type { AssignmentRow } from "../../src/store/db.js";
import { createSyntheticNotionClient, SYNTHETIC_NOTION_VERSION } from "../../src/cloudflare/notion-client.js";
import { SyntheticJsonTransport } from "../../src/cloudflare/transport.js";
import { DETAILS_HEADING, NOTES_HEADING, ACTIVITY_HEADING } from "../../src/notion/blocks.js";
const check = (condition: boolean) => { if (!condition) throw Error("Invalid synthetic HTTP dispatch"); };
export type Block = Record<string, any>;
const text = (id: string, value: string, type = "paragraph"): Block => ({ id, object: "block", type, [type]: { rich_text: [{ type: "text", text: { content: value } }] } });
export const plain = (b: Block) => (b[b.type]?.rich_text ?? []).map((r: any) => r.text?.content ?? r.plain_text ?? "").join("");
export const destinations = { assignmentsDbId: "dummy-assignment-db", assignmentsDsId: "dummy-assignment-ds", coursesDbId: "dummy-course-db", coursesDsId: "dummy-course-ds" };
export const row = { canvas_id: 42, course_id: 1, name: "Dummy assignment", points_possible: 10, sub_score: 8, sub_grade: "8", sub_attempts: 1, sub_workflow_state: "graded", submission_types: "[]" } as AssignmentRow;
export const options = { isNew: false, revision: "11111111-2222-4333-8444-555555555555", changedFields: ["sub_score"], coursePageId: "dummy-course-page", courseLabel: "DUMMY" };
export function fixture() {
  const original = [text("dummy-preface", "USER PREFACE"), text("dummy-details", DETAILS_HEADING, "heading_2"), text("dummy-facts", "OLD FACTS"), text("dummy-notes", NOTES_HEADING, "heading_2"), text("dummy-note", "USER NOTE"), text("dummy-activity", ACTIVITY_HEADING, "heading_2"), text("dummy-history", "HISTORICAL ACTIVITY")];
  let blocks = structuredClone(original), seq = 0, exists = true, loseAppendResponse = false;
  const properties: Record<string, any> = { "Do Not Sync": { type: "checkbox", checkbox: false }, Hidden: { type: "checkbox", checkbox: true }, "In Progress": { type: "checkbox", checkbox: true } };
  const calls: { path: string; method: string; body: any }[] = [];
  const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
  const fetchPort: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    check(url.origin === "https://notion.invalid");
    check(init?.redirect === "manual"); check(init?.credentials === "omit");
    const headers = new Headers(init?.headers);
    check(headers.get("Notion-Version") === SYNTHETIC_NOTION_VERSION);
    check(headers.get("Authorization") === null); check(headers.get("Cookie") === null);
    const method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname, method, body });
    let result: unknown;
    if (url.pathname.includes("/data_sources/")) result = list(exists ? [{ id: "dummy-page" }] : []);
    else if (url.pathname === "/v1/pages" && method === "POST") { exists = true; Object.assign(properties, body.properties); result = { id: "dummy-page" }; }
    else if (url.pathname === "/v1/pages/dummy-page") {
      if (method === "PATCH") Object.assign(properties, body.properties);
      result = { id: "dummy-page", archived: false, in_trash: false, properties };
    } else if (url.pathname === "/v1/blocks/dummy-page/children") {
      if (method === "GET") result = list(blocks);
      else {
        const created = body.children.map((b: Block) => ({ ...b, id: `dummy-new-${++seq}` }));
        const at = body.position?.type === "start" ? 0 : body.position?.type === "after_block" ? blocks.findIndex(b => b.id === body.position.after_block.id) + 1 : blocks.length;
        blocks.splice(at, 0, ...created); result = list(created);
        if (loseAppendResponse) { loseAppendResponse = false; throw Error("dummy lost response"); }
      }
    } else if (url.pathname.startsWith("/v1/blocks/") && method === "DELETE") {
      const id = url.pathname.split("/").at(-1)!; blocks = blocks.filter(b => b.id !== id); result = { id };
    } else throw Error("Unexpected fake HTTP request");
    return Response.json(result);
  };
  const fresh = () => createSyntheticNotionClient(new SyntheticJsonTransport({ syntheticOnly: true, origin: "https://notion.invalid", requestBudget: 50, fetch: fetchPort })) as unknown as Client;
  return { fresh, calls, original, properties, blocks: () => blocks, empty: () => { blocks = []; exists = false; }, loseAppend: () => { loseAppendResponse = true; } };
}
