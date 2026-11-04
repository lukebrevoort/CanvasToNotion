import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@notionhq/client";
import { config } from "../src/config.js";
import { upsertAssignmentPage, upsertCoursePage } from "../src/notion/projector.js";
import type { AssignmentRow } from "../src/store/db.js";

config.statePath = "/nonexistent-synthetic-identity-state";
config.assignmentsDbId = "assignments-db";
config.coursesDbId = "courses-db";
const row = { canvas_id: 42, course_id: 1, name: "Synthetic", submission_types: "[]" } as AssignmentRow;
const course = { canvas_id: 1, name: "Synthetic course", course_code: null, term_id: null, start_at: null, end_at: null };
const opts = { isNew: false, revision: "11111111-2222-4333-8444-555555555555", changedFields: [], coursePageId: null, courseLabel: "TEST" };
type Page = { results: { id: string }[]; has_more: boolean; next_cursor: string | null };
const page = (ids: string[], cursor: string | null = null): Page => ({ results: ids.map(id => ({ id })), has_more: cursor !== null, next_cursor: cursor });

function fixture(responses: (Page | Error)[]) {
  const requests: any[] = [];
  const mutations: any[] = [];
  const flags = { Hidden: { checkbox: true }, "In Progress": { checkbox: true }, "Do Not Sync": { type: "checkbox", checkbox: false } };
  const client = {
    dataSources: { query: async (request: any) => {
      requests.push(request);
      const response = responses[requests.length - 1];
      if (response instanceof Error) throw response;
      assert.ok(response, "unexpected query beyond supplied pages");
      return response;
    } },
    pages: {
      retrieve: async () => {
        const sampled = structuredClone(flags);
        // A human edit after the read must survive the subsequent property PATCH.
        flags.Hidden.checkbox = false;
        flags["In Progress"].checkbox = false;
        return { properties: sampled };
      },
      update: async (request: any) => {
        mutations.push(request);
        Object.assign(flags, request.properties);
        return { id: request.page_id };
      },
      create: async (request: any) => { mutations.push(request); return { id: "created-page" }; },
    },
  } as unknown as Client;
  return { client, requests, mutations, flags };
}
const projectors = {
  assignment: (client: Client) => upsertAssignmentPage(client, row, "canvas.invalid", opts),
  course: (client: Client) => upsertCoursePage(client, course, "canvas.invalid"),
};

for (const [kind, project] of Object.entries(projectors)) {
  test(`${kind} query exhausts all identity pages before updating`, async () => {
    const f = fixture([page(["existing"], "second"), page([], "third"), page([])]);
    await project(f.client);
    assert.equal(f.requests.length, 3);
    assert.deepEqual(f.requests.map(r => r.start_cursor), [undefined, "second", "third"]);
    assert.ok(f.requests.every(r => r.page_size === 100));
    assert.equal(f.mutations.length, 1);
    assert.equal(f.mutations[0].page_id, "existing");
  });

  for (const [label, responses, message] of [
    ["duplicates in one page", [page(["first", "second"])], /Ambiguous/],
    ["duplicates on later page", [page(["first"], "next"), page(["second"])], /Ambiguous/],
    ["repeated page identity", [page(["first"], "next"), page(["first"])], /identity/],
    ["missing page identity", [page([""])], /identity/],
    ["missing pagination cursor", [{ ...page([]), has_more: true }], /pagination/],
    ["repeated pagination cursor", [page([], "next"), page([], "next")], /pagination/],
    ["later query failure", [page(["first"], "next"), new Error("synthetic query failure")], /query failure/],
  ] as [string, (Page | Error)[], RegExp][]) {
    test(`${kind} refuses ${label} before mutation`, async () => {
      const f = fixture(responses);
      await assert.rejects(project(f.client), message);
      assert.equal(f.mutations.length, 0);
    });
  }
}

test("assignment update omits all human-owned flags, preserving edits after its read", async () => {
  const f = fixture([page(["existing"])]);
  await projectors.assignment(f.client);
  const properties = f.mutations[0].properties;
  for (const key of ["Hidden", "In Progress", "Do Not Sync"]) assert.equal(key in properties, false);
  assert.equal(f.flags.Hidden.checkbox, false);
  assert.equal(f.flags["In Progress"].checkbox, false);
});
