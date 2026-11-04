import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SyntheticJsonTransport, SyntheticTransportError } from "../src/cloudflare/transport.js";
const url = "https://notion.invalid/v1/pages/dummy-page";
const code = (expected: string, kind?: string) => (error: unknown) => error instanceof SyntheticTransportError && error.code === expected && (kind === undefined || error.operationKind === kind) && !error.message.includes("private");
const fake = (fetch: typeof globalThis.fetch, timeoutMs = 25) => new SyntheticJsonTransport({ syntheticOnly: true, origin: "https://notion.invalid", fetch, requestBudget: 3, timeoutMs, maxResponseBytes: 128 });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

test("dummy JSON fetched once without credentials or redirects; actual invocation budget enforced", async () => {
  let calls = 0;
  const t = new SyntheticJsonTransport({ syntheticOnly: true, origin: "https://notion.invalid", requestBudget: 1, fetch: async (input, init) => {
    calls++; assert.equal(input, url); assert.equal(init?.credentials, "omit"); assert.equal(init.redirect, "manual"); assert.equal(init.headers, undefined);
    return new Response('{"dummy":true}');
  } });
  assert.deepEqual(await t.request({ url }), { dummy: true });
  await assert.rejects(t.request({ url }), code("budget")); assert.equal(calls, 1);
  assert.deepEqual(t.state(), { used: 1, active: 0, uncertain: false, lastOperationKind: "read" });
});

test("real origins, URL credentials and invalid methods fail before invoking fetch", async () => {
  let calls = 0; const t = fake(async () => { calls++; return new Response('{}'); });
  for (const other of ['https://api.notion.com/v1/pages/x', 'http://notion.invalid/', 'https://dummy:dummy@notion.invalid/', url + '#fragment']) await assert.rejects(t.request({ url: other }), code("invalid"));
  await assert.rejects(t.request({ url, method: "TRACE" as "GET" }), code("invalid"));
  await assert.rejects(t.request({ url, json: {} }), code("invalid"));
  assert.equal(calls, 0); assert.equal(t.state().used, 0);
});

test("pre-start cancellation consumes zero budget and leaves transport usable", async () => {
  let calls = 0; const t = fake(async () => { calls++; return new Response('{}'); });
  const first = new AbortController(); first.abort(Error("private-caller-reason"));
  await assert.rejects(t.request({ url, signal: first.signal }), code("aborted", "read"));
  const second = new AbortController(); const pending = t.request({ url, signal: second.signal }); second.abort();
  await assert.rejects(pending, code("aborted", "read")); await t.settleStartedRequests();
  assert.equal(calls, 0); assert.equal(t.state().uncertain, false);
  await t.request({ url }); assert.equal(calls, 1);
});

test("stalled headers abort and settle with sticky read uncertainty, no retry", async () => {
  let calls = 0, observedAbort = false;
  const t = fake(async (_input, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => { observedAbort = true; reject(Error('private-fetch-error')); }, { once: true }));
  });
  await assert.rejects(t.request({ url }), code("timeout", "read")); await t.settleStartedRequests();
  assert(observedAbort); assert.equal(t.state().active, 0); assert(t.state().uncertain);
  await assert.rejects(t.request({ url }), code("uncertain")); assert.equal(calls, 1);
});

test("deadline covers stalled body and cancels reader", async () => {
  let canceled = false;
  const t = fake(async () => new Response(new ReadableStream<Uint8Array>({ cancel() { canceled = true; } })));
  await assert.rejects(t.request({ url }), code("timeout", "read")); await t.settleStartedRequests();
  assert(canceled); assert.equal(t.state().active, 0); assert(t.state().uncertain);
});

test("ignored abort retains active request until actual late settlement and never dispatches again", async () => {
  const response = deferred<Response>(); let calls = 0;
  const t = fake(async () => { calls++; return response.promise; });
  await assert.rejects(t.request({ url, method: "PATCH", json: { dummy: true } }), code("timeout", "write"));
  assert.deepEqual(t.state(), { used: 1, active: 1, uncertain: true, lastOperationKind: "write" });
  await assert.rejects(t.request({ url }), code("uncertain"));
  let settled = false; const settle = t.settleStartedRequests().then(() => { settled = true; });
  await delay(5); assert.equal(settled, false);
  response.resolve(new Response('{}')); await settle;
  assert.equal(t.state().active, 0); assert(t.state().uncertain); assert.equal(calls, 1);
});

test("serial gate rejects overlapping calls without spending another request", async () => {
  const response = deferred<Response>(); const t = fake(async () => response.promise, 1000);
  const first = t.request({ url }); await assert.rejects(t.request({ url }), code("busy"));
  response.resolve(new Response('{}')); await first;
  assert.equal(t.state().used, 1); assert.equal(t.state().uncertain, false);
});

test("redirect refuses without following Location or issuing second fetch", async () => {
  let calls = 0;
  const t = fake(async () => { calls++; return new Response('private-redirect-body', { status: 302, headers: { Location: 'https://api.notion.com/' } }); });
  await assert.rejects(t.request({ url }), error => code("redirect", "read")(error) && (error as SyntheticTransportError).status === 302);
  await t.settleStartedRequests(); assert.equal(calls, 1); assert(t.state().uncertain);
});

test("stream byte limit is enforced without Content-Length; reader canceled", async () => {
  let canceled = false;
  const t = fake(async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(129)); }, cancel() { canceled = true; } })));
  await assert.rejects(t.request({ url }), code("body_limit")); await t.settleStartedRequests(); assert(canceled);
});

test("caller abort after dispatch sanitizes reason, latches and cleans up", async () => {
  const started = deferred<void>(); let canceled = false;
  const t = fake(async () => { started.resolve(); return new Response(new ReadableStream<Uint8Array>({ cancel() { canceled = true; } })); }, 1000);
  const c = new AbortController(); const pending = t.request({ url, method: "POST", json: { dummy: true }, signal: c.signal });
  await started.promise; await delay(0); c.abort(Error('private-token-reason'));
  await assert.rejects(pending, code("aborted", "write")); await t.settleStartedRequests();
  assert(canceled); assert.equal(t.state().used, 1); assert.equal(t.state().active, 0); assert(t.state().uncertain);
});

test("HTTP failure and malformed JSON expose only sanitized code/status", async () => {
  const t = fake(async () => new Response('private-error-body', { status: 401 }));
  await assert.rejects(t.request({ url }), error => code("response")(error) && (error as SyntheticTransportError).status === 401);
  const u = fake(async () => new Response('private-invalid-json'));
  await assert.rejects(u.request({ url }), code("response"));
  const v = fake(async () => { throw Error('private-transport-error'); });
  await assert.rejects(v.request({ url }), code("transport"));
});

test("POST is conservatively a write, parsed JSON returned without response wrapper", async () => {
  const t = fake(async (_input, init) => { assert.equal(init?.method, "POST"); assert.equal(init?.body, '{"dummy":true}'); return new Response('[1,null]'); });
  assert.deepEqual(await t.request({ url, method: "POST", json: { dummy: true } }), [1, null]);
  assert.equal(t.state().lastOperationKind, "write");
});

test("requestDetailed exposes only bounded Link metadata plus parsed JSON", async () => {
  const t = fake(async () => new Response('{}', { headers: { Link: '<https://notion.invalid/dummy?page=2>; rel="next"', 'X-Dummy-Secret': 'dummy-private-header' } }));
  assert.deepEqual(await t.requestDetailed({ url }), { json: {}, link: '<https://notion.invalid/dummy?page=2>; rel="next"' });
  assert.equal(t.state().used, 1);
});

test("oversized Link header refuses and cancels body without exposing it", async () => {
  let canceled = false;
  const t = fake(async () => new Response(new ReadableStream<Uint8Array>({ cancel() { canceled = true; } }), { headers: { Link: 'x'.repeat(8193) } }));
  await assert.rejects(t.requestDetailed({ url }), code('response')); await t.settleStartedRequests(); assert(canceled);
});

 test("Notion version header is fixed and limited to the dummy Notion origin", async()=>{
  let headers: Headers | undefined;
  const t=new SyntheticJsonTransport({syntheticOnly:true,origin:"https://notion.invalid",requestBudget:1,fetch:async(_url,init)=>{headers=new Headers(init?.headers);return Response.json({dummy:true});}});
  await t.request({url:"https://notion.invalid/v1/dummy",notionVersion:"2025-09-03"});
  assert.equal(headers?.get("Notion-Version"),"2025-09-03");assert.equal(headers?.get("Authorization"),null);
  let calls=0;const c=new SyntheticJsonTransport({syntheticOnly:true,origin:"https://canvas.invalid",requestBudget:1,fetch:async()=>{calls++;return Response.json({});}});
  await assert.rejects(c.request({url:"https://canvas.invalid/dummy",notionVersion:"2025-09-03"}));assert.equal(calls,0);
 });
