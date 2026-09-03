import assert from "node:assert/strict";
import test from "node:test";
import { detailsBlocks, htmlToBlocks, inlineRichText } from "../src/notion/blocks.js";
import type { AssignmentRow } from "../src/store/db.js";

const row = {
  canvas_id: 694697,
  course_id: 189207,
  name: "Syllabus Quiz",
  due_at: "2026-09-09T03:59:59Z",
  calendar_due_at: "2026-09-08",
  unlock_at: null,
  lock_at: null,
  points_possible: 100,
  description_html: "<p>Read <a href=\"https://example.com/a\">the guide</a> and <a href=\"https://example.com/b\">the FAQ</a>.</p><p><strong>Important:</strong> <em>be on time</em>.</p>",
  submission_types: "[\"online_text_entry\"]",
  group_id: null,
  group_name: null,
  group_weight: null,
  is_quiz: 0,
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
  sub_late: null,
  sub_excused: null,
  sub_missing: null,
} as AssignmentRow;

test("inlineRichText preserves every link, not just the first", () => {
  const rt = inlineRichText("<p>See <a href=\"https://x.com/a\">A</a> and <a href=\"https://x.com/b\">B</a>.</p>");
  const links = rt.filter((r) => r.text.link).map((r) => r.text.link.url);
  assert.deepEqual(links, ["https://x.com/a", "https://x.com/b"]);
});

test("inlineRichText preserves bold and italic annotations", () => {
  const rt = inlineRichText("<strong>Important:</strong> <em>be on time</em>");
  assert.equal(rt[0]!.annotations.bold, true);
  assert.equal(rt[2]!.text.content.trim(), "be on time");
  assert.equal(rt[2]!.annotations.italic, true);
});

test("htmlToBlocks maps headings, list items, and paragraphs", () => {
  const blocks = htmlToBlocks("<h2>Steps</h2><ul><li>One</li><li>Two</li></ul><p>Done.</p>");
  assert.deepEqual(blocks.map((b) => b.type), ["heading_2", "bulleted_list_item", "bulleted_list_item", "paragraph"]);
});

test("detailsBlocks leads with a facts list", () => {
  const blocks = detailsBlocks(row, { status: "Not started", canvasDomain: "sit.instructure.com" });
  const text = (i: number) => blocks[i]!.bulleted_list_item.rich_text[0]!.text.content;
  assert.equal(blocks[0]!.type, "heading_2");
  assert.match(text(1), /^Due: 2026-09-08$/);
  assert.match(text(2), /^Points: 100$/);
  assert.match(text(3), /^Status: Not started$/);
  const canvasLink = blocks.find((b) => b.type === "bulleted_list_item"
    && b.bulleted_list_item.rich_text[0].text.content === "Open in Canvas")!;
  assert.equal(canvasLink.bulleted_list_item.rich_text[0]!.text.link.url,
    "https://sit.instructure.com/courses/189207/assignments/694697");
});

test("detailsBlocks renders the description with links intact", () => {
  const blocks = detailsBlocks(row, { status: "Not started" });
  const descStart = blocks.findIndex((b) => b.type === "heading_3" && b.heading_3.rich_text[0].text.content === "Description");
  const para = blocks[descStart + 1]!;
  assert.equal(para.type, "paragraph");
  const linked = para.paragraph.rich_text.filter((r: { text: { link?: { url: string } } }) => r.text.link);
  assert.equal(linked.length, 2);
});

test("detailsBlocks shows score and submission facts when present", () => {
  const graded = { ...row, sub_score: 92, sub_grade: "A-", sub_submitted_at: "2026-09-01T14:00:00Z" };
  const text = detailsBlocks(graded).map((b) => b.bulleted_list_item?.rich_text?.[0]?.text?.content ?? "").join("\n");
  assert.match(text, /Score: 92 \/ 100 \(A-\)/);
  assert.match(text, /Submitted:/);
});
