import assert from "node:assert/strict";
import test from "node:test";
import { createCanvasPageState, readCanvasPage, CanvasPageError, type CanvasPageState, type CanvasPageTransport } from "../src/cloudflare/canvas-pages.js";
import { SyntheticJsonTransport } from "../src/cloudflare/transport.js";
const make = () => createCanvasPageState({ syntheticOnly: true, endpoint: { kind: "assignments", courseId: 7 }, maxPages: 3, maxItems: 300 });
const item = (id = 1) => ({ id, course_id: 7, name: `dummy-${id}` });
const next = (state: CanvasPageState, page: string) => { const u = new URL(state.initialUrl); u.searchParams.set("page", page); return u.href; };
const header = (url: string) => `<${url}>; rel="next"`;
const response = (json: unknown, link: string | null = null): CanvasPageTransport => ({ requestDetailed: async () => ({ json, link }) });
const code = (expected: string) => (e: unknown) => e instanceof CanvasPageError && e.code === expected;

test("initial endpoint parameters preserve existing CanvasClient semantics", () => {
  const course = createCanvasPageState({ syntheticOnly: true, endpoint: { kind: "courses" }, maxPages: 1, maxItems: 100 });
  assert.deepEqual(Object.fromEntries(new URL(course.initialUrl).searchParams), { enrollment_state: "active", include: "term" });
  const assignments = createCanvasPageState({ syntheticOnly: true, endpoint: { kind: "assignments", courseId: 7, updatedSince: "2026-11-04T01:00:00Z" }, maxPages: 1, maxItems: 100 });
  assert.deepEqual(Object.fromEntries(new URL(assignments.initialUrl).searchParams), { order_by: "due_at", per_page: "100", include: "submission", all_dates: "true", updated_since: "2026-11-04T01:00:00.000Z" });
  const group = createCanvasPageState({ syntheticOnly: true, endpoint: { kind: "assignmentGroups", courseId: 7 }, maxPages: 1, maxItems: 100 });
  assert.equal(new URL(group.initialUrl).pathname, "/api/v1/courses/7/assignment_groups");
  assert.deepEqual(Object.fromEntries(new URL(group.initialUrl).searchParams), { per_page: "100" });
});

test("one step performs one read; serializable checkpoint resumes and completion performs no read", async () => {
  const initial = make(), before = structuredClone(initial); let calls = 0;
  const one = await readCanvasPage(initial, { requestDetailed: async req => { calls++; assert.equal(req.method, "GET"); return { json: [item()], link: header(next(initial, "2")) }; } });
  assert.equal(calls, 1); assert.equal(one.done, false); assert.deepEqual(initial, before);
  const restored = JSON.parse(JSON.stringify(one.state)) as CanvasPageState;
  const two = await readCanvasPage(restored, response([item(2)]));
  assert.equal(two.done, true); assert.equal(two.state.pagesRead, 2); assert.equal(two.state.itemsRead, 2);
  const done = await readCanvasPage(two.state, { requestDetailed: async () => { throw Error("must not call"); } });
  assert.deepEqual(done.items, []); assert.equal(done.done, true);
});

test("cursor cycles survive query ordering and escaping normalization", async () => {
  const initial = make();
  await assert.rejects(readCanvasPage(initial, response([item()], header(initial.initialUrl))), code("cycle"));
  const one = await readCanvasPage(initial, response([item()], header(next(initial, "2"))));
  const cycled = new URL(one.state.nextUrl!); cycled.searchParams.sort();
  await assert.rejects(readCanvasPage(one.state, response([item(2)], header(cycled.href.replace('due_at', 'due%5Fat')))), code("cycle"));
});

test("cross-origin, credentials, wrong course, changed filters and unknown cursor parameters refused", async () => {
  const initial = make();
  const safe = next(initial, "2");
  for (const url of [safe.replace('canvas.invalid', 'evil.invalid'), safe.replace('https:', 'http:'), safe.replace('https://', 'https://dummy:dummy@'), safe.replace('/courses/7/', '/courses/8/'), safe.replace('include=submission', 'include=other'), safe + '&access_token=dummy-token', safe + '&page=3', safe + '#x']) {
    await assert.rejects(readCanvasPage(initial, response([item()], header(url))), code("scope"));
    assert.equal(initial.pagesRead, 0);
  }
});

test("quoted Link commas and rel-looking titles are not mistaken for next relation", async () => {
  const initial = make();
  const link = `<${initial.initialUrl}>; title="dummy, title; rel=next"; rel="current", <${next(initial, '2')}>; rel="next"; title="dummy, next"`;
  const result = await readCanvasPage(initial, response([item()], link));
  assert.equal(new URL(result.state.nextUrl!).searchParams.get('page'), '2');
});

test("ambiguous or malformed next headers refuse without cursor advancement", async () => {
  const initial = make();
  for (const link of [header(next(initial, '2')) + ', ' + header(next(initial, '3')), `<${next(initial, '2')}>; rel="next"; rel="prev"`, '<broken', header(next(initial, '2')) + '\n', 'x'.repeat(8193)]) {
    await assert.rejects(readCanvasPage(initial, response([item()], link)), code("response"));
    assert.equal(initial.itemsRead, 0);
  }
});

test("malformed, oversized and cross-course rows never partially advance", async () => {
  const initial = make(), before = structuredClone(initial);
  for (const json of [{ items: [item()] }, Array.from({ length: 101 }, (_, i) => item(i + 1)), [item(), { ...item(2), course_id: 8 }], [item(), { ...item(2), name: 7 }], [item(), item()], [{ ...item(), submission: { assignment_id: 2 } }]]) {
    await assert.rejects(readCanvasPage(initial, response(json)));
    assert.deepEqual(initial, before);
  }
});

test("duplicate item IDs across pages fail closed", async () => {
  const initial = make(); const one = await readCanvasPage(initial, response([item()], header(next(initial, '2'))));
  await assert.rejects(readCanvasPage(one.state, response([item()])), code("response")); assert.equal(one.state.pagesRead, 1);
});

test("page budget preserves incomplete checkpoint and refuses next invocation without fetch", async () => {
  const initial = createCanvasPageState({ syntheticOnly: true, endpoint: { kind: 'assignments', courseId: 7 }, maxPages: 1, maxItems: 100 });
  const one = await readCanvasPage(initial, response([item()], header(next(initial, '2')))); assert.equal(one.done, false);
  let calls = 0;
  await assert.rejects(readCanvasPage(one.state, { requestDetailed: async () => { calls++; return { json: [], link: null }; } }), code("budget"));
  assert.equal(calls, 0);
});

test("item budget and tampered restored state refuse", async () => {
  const initial = createCanvasPageState({ syntheticOnly: true, endpoint: { kind: 'assignments', courseId: 7 }, maxPages: 2, maxItems: 1 });
  await assert.rejects(readCanvasPage(initial, response([item(), item(2)])), code('response'));
  await assert.rejects(readCanvasPage({ ...initial, initialUrl: initial.initialUrl.replace('/7/', '/8/') }, response([])), code('state'));
  await assert.rejects(readCanvasPage({ ...initial, nextUrl: next(initial, '3') }, response([])), code('state'));
});

test("embedded submission and normalized known fields preserved; unknown payload dropped", async () => {
  const original = { ...item(), description: null, points_possible: 10, submission_types: ['online_upload'], submission: { assignment_id: 1, workflow_state: 'graded', score: 8, grade: '8', late: false, ignored: 'dummy' }, ignored: 'dummy' };
  const result = await readCanvasPage(make(), response([original]));
  assert.deepEqual(result.items, [{ id: 1, course_id: 7, name: 'dummy-1', description: null, points_possible: 10, submission_types: ['online_upload'], submission: { assignment_id: 1, workflow_state: 'graded', score: 8, grade: '8', late: false } }]);
});

test("transport rejection is sanitized and never automatically retried", async () => {
  let calls = 0; const initial = make();
  await assert.rejects(readCanvasPage(initial, { requestDetailed: async () => { calls++; throw Error('dummy-private-response'); } }), code('transport'));
  assert.equal(calls, 1); assert.equal(initial.pagesRead, 0);
});

test("actual bounded dummy transport integrates Link metadata without exposing other headers", async () => {
  const state = make(); let calls = 0;
  const transport = new SyntheticJsonTransport({ syntheticOnly: true, origin: 'https://canvas.invalid', requestBudget: 2, fetch: async () => {
    calls++; return new Response(JSON.stringify([item(calls)]), { headers: { Link: calls === 1 ? header(next(state, '2')) : '', 'X-Dummy-Secret': 'dummy-private-header' } });
  } });
  const one = await readCanvasPage(state, transport); const two = await readCanvasPage(one.state, transport);
  assert.equal(two.done, true); assert.equal(calls, 2); assert.equal(transport.state().used, 2);
});
