import type { Client } from "@notionhq/client";
import type { AssignmentRow } from "../store/db.js";

/**
 * Page body layout (settled design):
 *
 *   ## 📋 Assignment Details     ← sync-owned; replaced on every change
 *      <description rendered as blocks>
 *   ## 🗒️ Notes                  ← humans & agents; sync NEVER touches
 *   ## 🕘 Activity               ← sync appends change-log entries
 *
 * Section headings are the delimiters: everything between DETAILS and NOTES
 * is sync-owned; everything after NOTES stays untouched except that Activity
 * entries are appended at the bottom.
 */

export const DETAILS_HEADING = "📋 Assignment Details";
export const NOTES_HEADING = "🗒️ Notes";
export const ACTIVITY_HEADING = "🕘 Activity";

type Block = Record<string, any>;

/** Minimal HTML → Notion blocks. Preserves paragraphs, headings, lists, and link text. */
export function htmlToBlocks(html: string): Block[] {
  if (!html) return [];
  const doc = new DOMParserLike(html);
  const blocks: Block[] = [];

  for (const node of doc.blocks()) {
    switch (node.kind) {
      case "h1":
        blocks.push(heading(1, node.text));
        break;
      case "h2":
        blocks.push(heading(2, node.text));
        break;
      case "h3":
        blocks.push(heading(3, node.text));
        break;
      case "li":
        blocks.push({
          object: "block",
          type: "bulleted_list_item",
          bulleted_list_item: { rich_text: richText(node.text, node.href) },
        });
        break;
      default:
        if (node.text.trim()) {
          blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: richText(node.text, node.href) } });
        }
    }
  }
  return blocks.slice(0, 90); // Notion allows ≤100 children per append
}

/** Tiny regex-based HTML block splitter — avoids a DOM dependency. */
class DOMParserLike {
  constructor(private html: string) {}
  blocks(): { kind: string; text: string; href?: string }[] {
    const out: { kind: string; text: string; href?: string }[] = [];
    const re = /<(h1|h2|h3|li|p)\b[^>]*>([\s\S]*?)<\/\1>|<li\b[^>]*>([\s\S]*?)<\/li>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.html))) {
      const tag = (m[1] ?? "li").toLowerCase();
      const inner = m[2] ?? m[3] ?? "";
      const linkMatch = inner.match(/<a\b[^>]*href=["']([^"']+)["']/i);
      out.push({ kind: tag, text: stripTags(inner), href: linkMatch?.[1] });
    }
    // Fallback: if no block tags matched, treat whole thing as one paragraph.
    if (out.length === 0 && stripTags(this.html).trim()) {
      out.push({ kind: "p", text: stripTags(this.html) });
    }
    return out;
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1900);
}

function richText(text: string, href?: string) {
  return [{ type: "text", text: { content: text, ...(href ? { link: { url: href } } : {}) } }];
}

function heading(level: 1 | 2 | 3, text: string): Block {
  const type = `heading_${level}`;
  return { object: "block", type, [type]: { rich_text: richText(text) } };
}

export function detailsBlocks(assignment: AssignmentRow): Block[] {
  const blocks: Block[] = [heading(2, DETAILS_HEADING)];
  blocks.push(...htmlToBlocks(assignment.description_html ?? ""));
  if (assignment.submission_types && assignment.submission_types !== "[]") {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: richText(`Submission types: ${JSON.parse(assignment.submission_types).join(", ")}`) },
    });
  }
  return blocks;
}

export function activityBlock(entry: string): Block {
  return { object: "block", type: "paragraph", paragraph: { rich_text: richText(entry) } };
}

/**
 * Refreshes the sync-owned details section while preserving the user-owned
 * Notes section and the Activity log verbatim. Strategy: read the whole body,
 * capture Notes + Activity blocks, delete everything, re-append
 * [details, notes, activity] in stable order.
 */
export async function replaceDetailsSection(
  client: Client,
  pageId: string,
  newDetails: Block[],
): Promise<void> {
  const existing = await client.blocks.children.list({ block_id: pageId, page_size: 100 });
  const results = existing.results as { id: string; type: string }[];

  let zone: "details" | "notes" | "activity" = "details";
  const notesBlocks: Block[] = [];
  const activityBlocks: Block[] = [];

  for (const b of results) {
    const text = blockText(b);
    if (text === NOTES_HEADING) {
      zone = "notes";
      notesBlocks.push(b as Block);
      continue;
    }
    if (text === ACTIVITY_HEADING) {
      zone = "activity";
      activityBlocks.push(b as Block);
      continue;
    }
    if (zone === "notes") notesBlocks.push(b as Block);
    else if (zone === "activity") activityBlocks.push(b as Block);
    // old details-zone blocks are dropped — fresh ones get appended below
  }

  // Delete everything, then rebuild in canonical order.
  for (const b of results) await client.blocks.delete({ block_id: b.id });

  const append = async (blocks: Block[]) => {
    for (let i = 0; i < blocks.length; i += 90) {
      await client.blocks.children.append({ block_id: pageId, children: blocks.slice(i, i + 90) as any });
    }
  };

  await append(newDetails);
  if (notesBlocks.length === 0) {
    await append([heading(2, NOTES_HEADING), {
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: richText("(write your notes here — sync never touches this section)") },
    }]);
  } else {
    await append(notesBlocks);
  }
  if (activityBlocks.length > 0) await append(activityBlocks);
}

function blockText(block: { type?: string; [k: string]: unknown }): string {
  const t = block.type;
  if (!t) return "";
  const data = block[t] as { rich_text?: { plain_text?: string }[] } | undefined;
  return (data?.rich_text ?? []).map((r) => r.plain_text ?? "").join("");
}
