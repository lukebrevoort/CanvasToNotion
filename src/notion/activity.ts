import type { Client } from "@notionhq/client";
import { ACTIVITY_HEADING, NOTES_HEADING, activityBlock } from "./blocks.js";

type Block = { id: string; type?: string; has_children?: boolean; [key: string]: unknown };
export type RevisionActivity = Readonly<{ marker: string; text: string }>;
/** Compatible with previously persisted recovery receipts. */
export function projectionActivity(spec: { assignmentId: number; revision: string; changedFields: string[]; isNew: boolean }): RevisionActivity | null {
  if (!Number.isSafeInteger(spec.assignmentId) || spec.assignmentId <= 0 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(spec.revision) ||
      !Array.isArray(spec.changedFields) || spec.changedFields.some(f => typeof f !== "string" || !/^[a-z_]+$/.test(f))) {
    throw new Error("Valid projection identity and revision required");
  }
  const notable = [...new Set(spec.changedFields.filter(f => !["description_html", "__new__"].includes(f)))].sort();
  if (spec.isNew || notable.length === 0) return null;
  const marker = `[assignment=${spec.assignmentId};revision=${spec.revision}]`;
  const text = `Canvas recovery ${marker} changed: ${notable.join(", ")}`;
  if (text.length > 1900) throw new Error("Activity payload exceeds supported length");
  return Object.freeze({ marker, text });
}
function blockText(block: Block): string {
  const data = block.type ? block[block.type] as { rich_text?: {plain_text?: string;text?: {content?: string}}[] } | undefined : undefined;
  return (data?.rich_text ?? []).map(r => r.plain_text ?? r.text?.content ?? "").join("");
}
async function roots(client: Client, pageId: string): Promise<Block[]> {
  const all: Block[] = [], cursors = new Set<string>(), ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.blocks.children.list({block_id: pageId, page_size: 100, start_cursor: cursor});
    for (const b of page.results as Block[]) {
      if (!b.id || ids.has(b.id)) throw new Error("Repeated or missing Activity block identity");
      ids.add(b.id);all.push(b);
    }
    if (page.has_more && (!page.next_cursor || cursors.has(page.next_cursor))) throw new Error("Incomplete Activity pagination");
    cursor = page.has_more ? page.next_cursor! : undefined;
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return all;
}
function inspect(blocks: Block[], activity: RevisionActivity): { found: boolean; needsHeading: boolean } {
  const heading = (b: Block, text: string) => b.type === "heading_2" && blockText(b) === text;
  const notes = blocks.flatMap((b,i) => heading(b, NOTES_HEADING) ? [i] : []);
  const boundaries = blocks.flatMap((b,i) => heading(b, ACTIVITY_HEADING) ? [i] : []);
  if (notes.length !== 1 || boundaries.length > 1 || (boundaries.length === 1 && boundaries[0]! <= notes[0]!)) throw new Error("Unambiguous Notes and Activity boundaries required");
  const matches = blocks.flatMap((b,i) => blockText(b).includes(activity.marker) ? [{b,i}] : []);
  if (matches.length > 1) throw new Error("Duplicate revision Activity requires reconciliation");
  if (!matches.length) return { found: false, needsHeading: boundaries.length === 0 };
  const {b,i} = matches[0]!;
  if (boundaries.length !== 1 || i <= boundaries[0]! || b.type !== "paragraph" || b.has_children || blockText(b) !== activity.text) throw new Error("Conflicting revision Activity requires reconciliation");
  return { found: true, needsHeading: false };
}
async function frozen(client: Client, pageId: string): Promise<boolean> {
  const page = await client.pages.retrieve({page_id: pageId});
  if (!("properties" in page) || page.archived || page.in_trash) throw new Error("Live page properties required before Activity");
  const flag = page.properties["Do Not Sync"];
  if (!flag || flag.type !== "checkbox") throw new Error("Do Not Sync checkbox required before Activity");
  return flag.checkbox;
}
/** Sequential, exclusive-writer idempotency, NOT an atomic cross-writer fence.
 * Never edits/deletes historical blocks, retries an append, or infers legacy
 * timestamp entries belong to this revision. Transport must not retry mutations
 * automatically; a later projection checks the persisted receipt instead. */
export async function ensureRevisionActivity(client: Client, pageId: string, activity: RevisionActivity): Promise<"reused"|"appended"|"frozen"> {
  if (await frozen(client,pageId)) return "frozen";
  const observed = inspect(await roots(client,pageId),activity);
  if (observed.found) return "reused";
  if (await frozen(client,pageId)) return "frozen";
  // Older/new pages may have Notes but no Activity heading. Append the new
  // boundary and receipt together at the end; never reclassify existing Notes.
  const children = observed.needsHeading
    ? [{ object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: ACTIVITY_HEADING } }] } }, activityBlock(activity.text)]
    : [activityBlock(activity.text)];
  await client.blocks.children.append({block_id:pageId,children:children as any});
  if (!inspect(await roots(client,pageId),activity).found) throw new Error("Revision Activity append not verified");
  return "appended";
}
