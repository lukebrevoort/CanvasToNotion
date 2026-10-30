import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@notionhq/client";
import { ACTIVITY_HEADING, DETAILS_HEADING, NOTES_HEADING, replaceDetailsSection } from "../src/notion/blocks.js";

type Block = { id: string; type: string; [key: string]: any };
const block = (id: string, text: string, type = "paragraph"): Block => ({
  id, type, [type]: { rich_text: [{ type: "text", plain_text: text, text: { content: text } }] },
});
const text = (b: Block) => b[b.type].rich_text.map((r: any) => r.plain_text ?? r.text.content).join("");
const replacement = (count = 2) => [
  block("ignored-heading", DETAILS_HEADING, "heading_2"),
  ...Array.from({ length: count }, (_, i) => block(`ignored-${i}`, `new detail ${i}`)),
].map(({ id, ...body }) => body);
const original = () => [
  block("preface", "User preface"),
  block("details", DETAILS_HEADING, "heading_2"),
  block("old-a", "old detail A"), block("old-b", "old detail B"),
  block("notes", NOTES_HEADING, "heading_2"),
  { ...block("nested-note", "My nested notes", "toggle"), has_children: true,
    children: [block("child-note", "An irreplaceable child note")], custom_metadata: "preserve" },
  block("activity", ACTIVITY_HEADING, "heading_2"), block("history", "Earlier activity"),
];

type Failure = { operation: "append" | "delete" | "list"; call: number; after?: boolean };
function fixture(seed = original(), failure?: Failure) {
  const state = structuredClone(seed);
  const protectedBlocks = structuredClone(seed.filter(b => !["details", "old-a", "old-b"].includes(b.id)));
  const counts = { append: 0, delete: 0, list: 0 };
  let sequence = 0;
  let armed = failure;
  const check = (operation: Failure["operation"], after = false) => {
    if (armed?.operation === operation && armed.call === counts[operation] && Boolean(armed.after) === after) {
      armed = undefined;
      throw new Error("simulated interruption");
    }
  };
  const client = { blocks: {
    children: {
      list: async ({ start_cursor, page_size }: { start_cursor?: string; page_size: number }) => {
        counts.list++;
        check("list");
        const start = Number(start_cursor ?? 0);
        const results = structuredClone(state.slice(start, start + page_size));
        const has_more = start + page_size < state.length;
        return { results, has_more, next_cursor: has_more ? String(start + page_size) : null };
      },
      append: async ({ children, position }: { children: Omit<Block, "id">[]; position?: { type: string; after_block?: { id: string } } }) => {
        counts.append++;
        check("append");
        let index = state.length;
        if (position?.type === "start") index = 0;
        if (position?.type === "after_block") {
          index = state.findIndex(b => b.id === position.after_block?.id);
          assert.notEqual(index, -1, "append anchor must exist");
          index++;
        }
        const created = children.map(b => ({ ...structuredClone(b), id: `created-${++sequence}` }) as Block);
        state.splice(index, 0, ...created);
        check("append", true); // Simulate a committed write with a lost response.
        return { results: structuredClone(created) };
      },
    },
    delete: async ({ block_id }: { block_id: string }) => {
      counts.delete++;
      check("delete");
      assert.ok(!protectedBlocks.some(b => b.id === block_id), "never delete a user block");
      const index = state.findIndex(b => b.id === block_id);
      assert.notEqual(index, -1);
      state.splice(index, 1);
      check("delete", true);
      return {};
    },
  } } as unknown as Client;
  return {
    client, state, counts,
    assertProtected: () => {
      assert.deepEqual(state.filter(b => protectedBlocks.some(p => p.id === b.id)), protectedBlocks);
    },
  };
}

for (const failure of [
  { operation: "append", call: 1 },
  { operation: "append", call: 1, after: true },
  { operation: "append", call: 2 },
  { operation: "append", call: 2, after: true },
  { operation: "delete", call: 1 },
  { operation: "delete", call: 2, after: true },
  { operation: "delete", call: 3, after: true },
] satisfies Failure[]) {
  test(`preserves Notes across ${failure.operation} ${failure.call} ${failure.after ? "lost response" : "failure"} and retry`, async () => {
    const f = fixture(original(), failure);
    const details = replacement(100); // Crosses both append and list pagination boundaries.
    await assert.rejects(replaceDetailsSection(f.client, "page", details), /simulated interruption/);
    f.assertProtected();
    if (failure.operation === "append") {
      for (const id of ["details", "old-a", "old-b"]) assert.ok(f.state.some(b => b.id === id));
    }
    await replaceDetailsSection(f.client, "page", details);
    f.assertProtected();
    assert.equal(f.state.filter(b => text(b) === DETAILS_HEADING).length, 1);
    const detailsStart = f.state.findIndex(b => text(b) === DETAILS_HEADING);
    const notesStart = f.state.findIndex(b => b.id === "notes");
    assert.deepEqual(f.state.slice(detailsStart + 1, notesStart).map(text),
      Array.from({ length: 100 }, (_, i) => `new detail ${i}`));
    assert.ok(!f.state.some(b => b.id.startsWith("old-")));
  });
}

test("reads all pages before writing and preserves Notes beyond the first 100 blocks", async () => {
  const seed = original();
  seed.splice(5, 0, ...Array.from({ length: 110 }, (_, i) => block(`note-${i}`, `My note ${i}`)));
  const f = fixture(seed);
  await replaceDetailsSection(f.client, "page", replacement());
  assert.equal(f.counts.list, 2);
  f.assertProtected();
});

test("a later list-page failure makes no writes", async () => {
  const seed = original();
  seed.push(...Array.from({ length: 100 }, (_, i) => block(`note-${i}`, `Note ${i}`)));
  const f = fixture(seed, { operation: "list", call: 2 });
  await assert.rejects(replaceDetailsSection(f.client, "page", replacement()), /simulated interruption/);
  assert.deepEqual(f.state, seed);
  assert.equal(f.counts.append, 0);
  assert.equal(f.counts.delete, 0);
});

test("missing Notes boundary fails closed without modifying an existing page", async () => {
  const seed = original().filter(b => b.id !== "notes");
  const f = fixture(seed);
  await assert.rejects(replaceDetailsSection(f.client, "page", replacement()), /Notes heading missing/);
  assert.deepEqual(f.state, seed);
  assert.equal(f.counts.append, 0);
  assert.equal(f.counts.delete, 0);
});

test("a page without Details preserves its preface across repeated refreshes", async () => {
  const seed = original().filter(b => !["details", "old-a", "old-b"].includes(b.id));
  const f = fixture(seed);
  await replaceDetailsSection(f.client, "page", replacement());
  await replaceDetailsSection(f.client, "page", replacement());
  f.assertProtected();
  assert.equal(f.state[0]?.id, "preface");
});

test("initialization survives a lost response and preserves notes written before retry", async () => {
  const f = fixture([], { operation: "append", call: 1, after: true });
  await assert.rejects(replaceDetailsSection(f.client, "page", replacement()), /simulated interruption/);
  const notesHeadingId = f.state[0]!.id;
  const note = block("human-note", "Written while sync was interrupted");
  f.state.push(note);
  await replaceDetailsSection(f.client, "page", replacement());
  assert.equal(f.state.filter(b => text(b) === NOTES_HEADING).length, 1);
  assert.equal(f.state.find(b => text(b) === NOTES_HEADING)?.id, notesHeadingId);
  assert.deepEqual(f.state.find(b => b.id === note.id), note);
});
