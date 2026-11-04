import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@notionhq/client";
import { createSyntheticNotionClient } from "../src/cloudflare/notion-client.js";
import { SyntheticJsonTransport } from "../src/cloudflare/transport.js";
import { upsertAssignmentPage, upsertCoursePage } from "../src/notion/projector-core.js";
import { ensureRevisionActivity, projectionActivity } from "../src/notion/activity.js";
import { NOTES_HEADING, ACTIVITY_HEADING } from "../src/notion/blocks.js";

import { fixture, plain, destinations, row, options } from "./fixtures/synthetic-notion-http.js";

test("fake HTTP pure projection preserves human content and overrides across replay, with one Activity receipt", async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) assert.deepEqual(await upsertAssignmentPage(f.fresh(), row, "canvas.invalid", options, destinations), { pageId: "dummy-page", pushed: true });
  assert.equal(f.blocks().filter(b => plain(b).includes(`[assignment=42;revision=${options.revision}]`)).length, 1);
  for (const id of ["dummy-preface", "dummy-notes", "dummy-note", "dummy-activity", "dummy-history"]) assert.deepEqual(f.blocks().find(b => b.id === id), f.original.find(b => b.id === id));
  assert.equal(f.properties.Hidden.checkbox, true); assert.equal(f.properties["In Progress"].checkbox, true);
  for (const c of f.calls.filter(c => c.path.startsWith("/v1/pages/") && c.method === "PATCH")) for (const key of ["Hidden", "In Progress", "Do Not Sync"]) assert(!Object.hasOwn(c.body.properties, key));
  f.properties["Do Not Sync"].checkbox = true;
  const before = f.calls.length;
  assert.equal((await upsertAssignmentPage(f.fresh(), row, "canvas.invalid", options, destinations)).pushed, false);
  assert.deepEqual(f.calls.slice(before).map(c => c.method), ["POST", "GET"]);
});

test("fake HTTP course and assignment creation retain explicit destinations and initialize Notes", async () => {
  const f = fixture(); f.empty();
  await upsertCoursePage(f.fresh(), { canvas_id: 1, name: "Dummy course", course_code: null, term_id: null, start_at: null, end_at: null }, "canvas.invalid", destinations);
  assert.deepEqual(f.calls.find(c => c.path === "/v1/pages")!.body.parent, { database_id: destinations.coursesDbId });
  f.empty();
  await upsertAssignmentPage(f.fresh(), row, "canvas.invalid", { ...options, isNew: true, changedFields: ["__new__"] }, destinations);
  const notes = structuredClone(f.blocks().filter(b => plain(b) === NOTES_HEADING || plain(b).includes("write your notes")));
  assert(notes.length > 0);
  await upsertAssignmentPage(f.fresh(), row, "canvas.invalid", options, destinations);
  for (const note of notes) assert.deepEqual(f.blocks().find(b => b.id === note.id), note);
  assert.equal(f.blocks().filter(b => plain(b) === ACTIVITY_HEADING).length, 1);
});

test("lost fake Activity append response is never retried; fresh client reconciles committed receipt", async () => {
  const f = fixture(), client = f.fresh();
  const activity = projectionActivity({ assignmentId: 42, revision: options.revision, changedFields: ["sub_score"], isNew: false })!;
  f.loseAppend();
  await assert.rejects(ensureRevisionActivity(client, "dummy-page", activity), /unresolved/);
  const before = f.calls.length;
  await assert.rejects(ensureRevisionActivity(client, "dummy-page", activity), /uncertain/);
  assert.equal(f.calls.length, before);
  assert.equal(await ensureRevisionActivity(f.fresh(), "dummy-page", activity), "reused");
  assert.equal(f.calls.filter(c => c.path.endsWith("/children") && c.method === "PATCH").length, 1);
});

test("opaque cursors round-trip verbatim in JSON and encoded query parameters", async () => {
  const opaque = "eyJvIjoxfQ== /?&+%#雪";
  const calls: { url: URL; init?: RequestInit }[] = [];
  const client = createSyntheticNotionClient(new SyntheticJsonTransport({ syntheticOnly: true, origin: "https://notion.invalid", requestBudget: 3, fetch: async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    return Response.json({ results: [], has_more: true, next_cursor: opaque });
  } }));
  assert.equal((await client.dataSources.query({ data_source_id: "dummy-source", start_cursor: opaque, page_size: 100 })).next_cursor, opaque);
  await client.blocks.children.list({ block_id: "dummy-page", start_cursor: opaque, page_size: 2 });
  assert.equal(JSON.parse(String(calls[0]!.init!.body)).start_cursor, opaque);
  assert.equal(calls[1]!.url.searchParams.get("start_cursor"), opaque);
  assert.equal(calls[1]!.url.searchParams.get("page_size"), "2");
});

test("invalid IDs, cursor bounds, page sizes and unsupported args never dispatch", async () => {
  let calls = 0;
  const client = createSyntheticNotionClient(new SyntheticJsonTransport({ syntheticOnly: true, origin: "https://notion.invalid", requestBudget: 1, fetch: async () => { calls++; return Response.json({ id: "dummy-page" }); } }));
  for (const page_id of ["real-page", "dummy-../page", "dummy-page?x", "https://api.notion.com", "a".repeat(32)]) await assert.rejects(client.pages.retrieve({ page_id }), /Invalid/);
  for (const start_cursor of ["", "雪".repeat(1366), 1]) await assert.rejects(client.blocks.children.list({ block_id: "dummy-page", start_cursor }), /Invalid/);
  for (const page_size of [0, 101, 1.5]) await assert.rejects(client.dataSources.query({ data_source_id: "dummy-source", page_size }), /Invalid/);
  await assert.rejects(client.pages.retrieve({ page_id: "dummy-page", token: "dummy" }), /Invalid/);
  await assert.rejects(client.pages.create({ parent: { database_id: "real-id" }, properties: {} }), /Invalid/);
  await assert.rejects(client.blocks.children.append({ block_id: "dummy-page", children: [], position: { type: "start" } }), /Invalid/);
  await assert.rejects(client.blocks.children.append({ block_id: "dummy-page", children: [{}], position: { type: "after_block", after_block: { id: "real-id" } } }), /Invalid/);
  await assert.rejects(client.pages.update({ page_id: "dummy-page", properties: { Course: { relation: [{ id: "real-page" }] } } }), /Invalid/);
  await assert.rejects(client.blocks.children.append({ block_id: "dummy-page", children: [{ type: "paragraph", paragraph: { rich_text: [{ type: "mention", mention: { page: { id: "real-page" } } }] } }] }), /Invalid/);
  assert.equal(calls, 0);
});

test("malformed or non-synthetic response identities poison client without retry", async () => {
  for (const payload of [{ id: "real-page" }, { results: [], has_more: true, next_cursor: null }, { results: [{ id: "real-block" }], has_more: false }]) {
    let calls = 0;
    const client = createSyntheticNotionClient(new SyntheticJsonTransport({ syntheticOnly: true, origin: "https://notion.invalid", requestBudget: 3, fetch: async () => { calls++; return Response.json(payload); } }));
    await assert.rejects("id" in payload ? client.pages.retrieve({ page_id: "dummy-page" }) : client.blocks.children.list({ block_id: "dummy-page" }), /unresolved/);
    await assert.rejects(client.pages.retrieve({ page_id: "dummy-page" }), /uncertain/);
    assert.equal(calls, 1);
  }
});

test("redirect and provider errors remain unresolved, redacted and never retried", async () => {
  for (const status of [302, 429, 500]) {
    let calls = 0;
    const client = createSyntheticNotionClient(new SyntheticJsonTransport({ syntheticOnly: true, origin: "https://notion.invalid", requestBudget: 3, fetch: async () => {
      calls++; return new Response("private provider payload", { status, headers: { Location: "https://api.notion.com", "Retry-After": "0" } });
    } }));
    await assert.rejects(client.pages.update({ page_id: "dummy-page", properties: {} }), error => error instanceof Error && error.message === "Synthetic Notion operation unresolved");
    await assert.rejects(client.pages.retrieve({ page_id: "dummy-page" }), /uncertain/);
    assert.equal(calls, 1);
  }
});

test("pure projector rejects repeated opaque identity cursors before mutating", async () => {
  let calls = 0;
  const opaque = "opaque+/==";
  const client = createSyntheticNotionClient(new SyntheticJsonTransport({ syntheticOnly: true, origin: "https://notion.invalid", requestBudget: 3, fetch: async (input, init) => {
    calls++; assert(String(input).endsWith("/query"));
    const body = JSON.parse(String(init!.body));
    if (calls > 1) assert.equal(body.start_cursor, opaque);
    return Response.json({ results: [], has_more: true, next_cursor: opaque });
  } })) as unknown as Client;
  await assert.rejects(upsertAssignmentPage(client, row, "canvas.invalid", options, destinations), /Invalid identity pagination/);
  assert.equal(calls, 2);
});
