import type { Client } from "@notionhq/client";
import type { AssignmentRow } from "../store/db.js";

/**
 * Page body layout (settled design):
 *
 *   ## 📋 Assignment Details     ← sync-owned; replaced on every change
 *      <facts list + description rendered as blocks>
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
type RichText = Record<string, any>[];

interface Format {
  href?: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

const ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#?\w+);/g, (_, e: string) => ENTITIES[e] ?? `&${e};`);
}

/** Parses inline HTML into Notion rich_text, preserving links, bold, italic, and code. */
export function inlineRichText(html: string): RichText {
  const segments: { text: string; format: Format }[] = [];
  const stack: Format[] = [{}];
  const top = (): Format => stack[stack.length - 1] ?? {};
  const pushText = (text: string, fmt: Format) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last && JSON.stringify(last.format) === JSON.stringify(fmt)) last.text += text;
    else segments.push({ text, format: { ...fmt } });
  };

  const re = /<br\s*\/?>|<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|([^<]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[2] != null) {
      pushText(decodeEntities(m[2]), top());
      continue;
    }
    if (/^<br/i.test(m[0])) {
      pushText("\n", top());
      continue;
    }
    const tag = m[1]!.toLowerCase();
    if (m[0].startsWith("</")) {
      if (["a", "strong", "b", "em", "i", "code"].includes(tag) && stack.length > 1) stack.pop();
      continue;
    }
    const fmt = { ...top() };
    if (tag === "a") {
      const href = m[0].match(/href=["']([^"']+)["']/i)?.[1];
      if (href) fmt.href = href;
    }
    if (tag === "strong" || tag === "b") fmt.bold = true;
    if (tag === "em" || tag === "i") fmt.italic = true;
    if (tag === "code") fmt.code = true;
    stack.push(fmt);
  }

  return segments
    .map((s) => {
      const f = s.format;
      return {
        type: "text",
        text: { content: s.text, ...(f.href ? { link: { url: f.href } } : {}) },
        annotations: {
          bold: Boolean(f.bold), italic: Boolean(f.italic), code: Boolean(f.code),
          strikethrough: false, underline: false, color: "default",
        },
      };
    })
    .filter((r) => r.text.content.length > 0);
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 1900);
}

/** Minimal HTML block splitter — avoids a DOM dependency. */
class DOMParserLike {
  constructor(private html: string) {}
  blocks(): { kind: string; inner: string }[] {
    const out: { kind: string; inner: string }[] = [];
    const re = /<(h1|h2|h3|li|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.html))) {
      out.push({ kind: m[1]!.toLowerCase(), inner: m[2] ?? "" });
    }
    // Fallback: if no block tags matched, treat whole thing as one paragraph.
    if (out.length === 0 && collapse(stripTags(this.html))) {
      out.push({ kind: "p", inner: this.html });
    }
    return out;
  }
}

function stripTags(html: string): string {
  return collapse(decodeEntities(html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")));
}

/** Renders HTML as Notion blocks: headings, list items, and paragraphs with inline formatting. */
export function htmlToBlocks(html: string): Block[] {
  if (!html) return [];
  const blocks: Block[] = [];

  for (const node of new DOMParserLike(html).blocks()) {
    const rt = inlineRichText(node.inner);
    if (rt.length === 0) continue;
    switch (node.kind) {
      case "h1":
        blocks.push({ object: "block", type: "heading_1", heading_1: { rich_text: rt } });
        break;
      case "h2":
        blocks.push({ object: "block", type: "heading_2", heading_2: { rich_text: rt } });
        break;
      case "h3":
        blocks.push({ object: "block", type: "heading_3", heading_3: { rich_text: rt } });
        break;
      case "li":
        blocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rt } });
        break;
      default:
        blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: rt } });
    }
  }
  return blocks.slice(0, 90); // Notion allows ≤100 children per append
}

function richText(text: string, href?: string) {
  return [{ type: "text", text: { content: text, ...(href ? { link: { url: href } } : {}) } }];
}

function heading(level: 1 | 2 | 3, text: string): Block {
  const type = `heading_${level}`;
  return { object: "block", type, [type]: { rich_text: richText(text) } };
}

function fmtDate(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function fact(label: string, value: string | null | undefined): Block | null {
  if (!value) return null;
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: richText(`${label}: ${value}`) },
  };
}

/**
 * Details section: a skimmable facts list first (agents and humans read this
 * without opening the description), then the full Canvas description.
 */
export function detailsBlocks(
  assignment: AssignmentRow,
  opts: { status?: string; canvasDomain?: string } = {},
): Block[] {
  const blocks: Block[] = [heading(2, DETAILS_HEADING)];

  const due = assignment.calendar_due_at ?? assignment.due_at;
  const facts: (Block | null)[] = [
    fact("Due", due ? fmtDate(due) : null),
    fact("Unlock", assignment.unlock_at ? fmtDate(assignment.unlock_at) : null),
    fact("Lock", assignment.lock_at ? fmtDate(assignment.lock_at) : null),
    fact("Points", assignment.points_possible != null ? String(assignment.points_possible) : null),
    fact("Status", opts.status),
    fact("Submitted", assignment.sub_submitted_at ? fmtDate(assignment.sub_submitted_at) : null),
    fact(
      "Score",
      assignment.sub_score != null
        ? `${assignment.sub_score}${assignment.points_possible ? ` / ${assignment.points_possible}` : ""}${assignment.sub_grade ? ` (${assignment.sub_grade})` : ""}`
        : null,
    ),
    fact("Attempts", assignment.sub_attempts != null ? String(assignment.sub_attempts) : null),
    fact("Late", assignment.sub_late ? "yes" : null),
    fact("Missing", assignment.sub_missing ? "yes" : null),
    fact(
      "Submission types",
      assignment.submission_types && assignment.submission_types !== "[]"
        ? JSON.parse(assignment.submission_types).join(", ")
        : null,
    ),
  ];
  blocks.push(...(facts.filter((b): b is Block => b !== null)));

  if (opts.canvasDomain) {
    blocks.push({
      object: "block",
      type: "bulleted_list_item",
      bulleted_list_item: {
        rich_text: richText(
          "Open in Canvas",
          `https://${opts.canvasDomain}/courses/${assignment.course_id}/assignments/${assignment.canvas_id}`,
        ),
      },
    });
  }

  const description = htmlToBlocks(assignment.description_html ?? "");
  if (description.length > 0) {
    blocks.push(heading(3, "Description"));
    blocks.push(...description);
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

  // Delete everything, then rebuild in canonical order. Retrieved blocks carry
  // read-only fields (id, archived, null icon, …) that append rejects — keep
  // only the type payload.
  const slim = (b: Block): Block => {
    const t = b.type;
    const payload = { ...b[t] };
    if (payload.icon === null) delete payload.icon;
    return { object: "block", type: t, [t]: payload };
  };
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
    await append(notesBlocks.map(slim));
  }
  if (activityBlocks.length > 0) await append(activityBlocks.map(slim));
}

function blockText(block: { type?: string; [k: string]: unknown }): string {
  const t = block.type;
  if (!t) return "";
  const data = block[t] as { rich_text?: { plain_text?: string }[] } | undefined;
  return (data?.rich_text ?? []).map((r) => r.plain_text ?? "").join("");
}
