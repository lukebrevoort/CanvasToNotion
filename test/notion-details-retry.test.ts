import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@notionhq/client";
import { ACTIVITY_HEADING, DETAILS_HEADING, NOTES_HEADING, detailsBlocks, replaceDetailsSection } from "../src/notion/blocks.js";

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
function fixture(seed = original(), failure?: Failure, responseMode?: "truncated" | "empty" | "excess" | "partial" | "wrong-content") {
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
        if (responseMode === "partial") created.pop();
        if (responseMode === "wrong-content" && created[0]) created[0] = block(created[0].id, "Unexpected content");
        state.splice(index, 0, ...created);
        check("append", true); // Simulate a committed write with a lost response.
        if (responseMode === "truncated") return { results: structuredClone(created.slice(0, 1)), has_more: true };
        if (responseMode === "empty" || responseMode === "partial" || responseMode === "wrong-content") return { results: [] };
        if (responseMode === "excess") return { results: structuredClone(state) };
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

for (const mode of ["truncated", "empty", "excess"] as const) {
  test(`verifies persisted Details after ${mode} append response across chunks`, async () => {
    const f = fixture(original(), undefined, mode);
    await replaceDetailsSection(f.client, "page", replacement(100));
    f.assertProtected();
    const start = f.state.findIndex(b => text(b) === DETAILS_HEADING);
    const end = f.state.findIndex(b => b.id === "notes");
    assert.deepEqual(f.state.slice(start + 1, end).map(text),
      Array.from({ length: 100 }, (_, i) => `new detail ${i}`));
    assert.equal(f.state.filter(b => text(b) === DETAILS_HEADING).length, 1);
  });
}
for (const mode of ["partial", "wrong-content"] as const) {
  test(`keeps all old Details when readback reveals ${mode} insertion`, async () => {
    const f = fixture(original(), undefined, mode);
    await assert.rejects(replaceDetailsSection(f.client, "page", replacement()), /Incomplete Details append readback/);
    assert.equal(f.counts.delete, 0);
    f.assertProtected();
    for (const id of ["details", "old-a", "old-b"]) assert.ok(f.state.some(b => b.id === id));
  });
}
test("failed append readback does not delete old Details", async () => {
  const f = fixture(original(), { operation: "list", call: 2 }, "empty");
  await assert.rejects(replaceDetailsSection(f.client, "page", replacement()), /simulated interruption/);
  assert.equal(f.counts.delete, 0);
  f.assertProtected();
});
test("retry removes prior duplicate managed sections, including identical Details", async () => {
  const f = fixture(original(), { operation: "append", call: 1, after: true }, "excess");
  await assert.rejects(replaceDetailsSection(f.client, "page", replacement()), /simulated interruption/);
  await replaceDetailsSection(f.client, "page", replacement());
  f.assertProtected();
  assert.equal(f.state.filter(b => text(b) === DETAILS_HEADING).length, 1);
  assert.equal(f.state.filter(b => text(b) === "new detail 0").length, 1);
});

test("readback accepts rendered details with rich text, links and API metadata", async () => {
  const f = fixture(original(), undefined, "empty");
  const details = detailsBlocks({
    canvas_id: 1, course_id: 2, points_possible: 5,
    description_html: '<p>Read <strong>carefully</strong> and <a href="https://example.com/">follow this link</a>.</p>',
  } as any, { status: "Not started", canvasDomain: "example.instructure.com" });
  const list = f.client.blocks.children.list;
  f.client.blocks.children.list = (async (args: any) => {
    const response = await list(args);
    return { ...response, results: response.results.map(b => ({ ...b, created_time: "now", archived: false })) };
  }) as any;
  await replaceDetailsSection(f.client, "page", details);
  f.assertProtected();
  assert.equal(f.state.filter(b => text(b) === DETAILS_HEADING).length, 1);
});

const originalUrl = "https://example.com/a%2Fb?key=a:b&other=two+words#section";
for (const [label, url, accepted] of [
  ["query percent encoding", "https://example.com/a%2Fb?key=a%3Ab&other=two%20words#section", true],
  ["different host", "https://other.example/a%2Fb?key=a%3Ab&other=two%20words#section", false],
  ["different protocol", "http://example.com/a%2Fb?key=a%3Ab&other=two%20words#section", false],
  ["decoded path separator", "https://example.com/a/b?key=a%3Ab&other=two%20words#section", false],
  ["different fragment", "https://example.com/a%2Fb?key=a%3Ab&other=two%20words#different", false],
  ["reordered parameters", "https://example.com/a%2Fb?other=two%20words&key=a%3Ab#section", false],
  ["extra duplicate parameter", "https://example.com/a%2Fb?key=a%3Ab&other=two%20words&key=a%3Ab#section", false],
  ["different value", "https://example.com/a%2Fb?key=different&other=two%20words#section", false],
  ["encoded literal plus", "https://example.com/a%2Fb?key=a%3Ab&other=two%2Bwords#section", false],
  ["malformed query escape", "https://example.com/a%2Fb?key=a%ZZb&other=two%20words#section", false],
] as const) {
  test(`readback ${accepted ? "accepts" : "rejects"} URL ${label}`, async () => {
    const f = fixture(original(), undefined, "empty");
    const details = replacement(0);
    details.push({ type: "paragraph", paragraph: { rich_text: [
      { type: "text", text: { content: "Linked text", link: { url: originalUrl } } },
    ] } } as any);
    const list = f.client.blocks.children.list;
    f.client.blocks.children.list = (async (args: any) => {
      const response = await list(args);
      for (const b of response.results as any[]) {
        for (const rich of b[b.type]?.rich_text ?? []) {
          if (rich.text?.link?.url === originalUrl) rich.text.link.url = url;
        }
      }
      return response;
    }) as any;
    if (accepted) await replaceDetailsSection(f.client, "page", details);
    else {
      await assert.rejects(replaceDetailsSection(f.client, "page", details), /Incomplete Details append readback/);
      assert.equal(f.counts.delete, 0);
    }
    f.assertProtected();
  });
}
