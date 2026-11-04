import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@notionhq/client";
import { createNotionTransport, isNotionRead, type NotionRequestEvent } from "../src/notion/transport.js";

const id = "11111111-2222-4333-8444-555555555555";
const query = `https://api.notion.com/v1/data_sources/${id}/query`;

test("query POST and paginated GET are reads; mutations and unknown hosts are not", () => {
  assert(isNotionRead(query, { method: "POST" }));
  assert(isNotionRead(`https://api.notion.com/v1/blocks/${id}/children?page_size=100&start_cursor=dummy`));
  assert(!isNotionRead(query, { method: "PATCH" }));
  assert(!isNotionRead("https://api.notion.com/v1/pages", { method: "POST" }));
  assert(!isNotionRead(query.replace("api.notion.com", "example.com"), { method: "POST" }));
  assert(!isNotionRead(query + "/extra", { method: "POST" }));
  assert(!isNotionRead(query + "?unexpected=true", { method: "POST" }));
});

for (const mode of ["headers", "body", "write"] as const) {
  test(`real SDK and native loopback fetch: stalled ${mode}`, async () => {
    let requests = 0, closed = false;
    let response: http.ServerResponse | undefined;
    let received!: () => void, settled!: () => void;
    const receivedPromise = new Promise<void>(r => { received = r; });
    const settledPromise = new Promise<void>(r => { settled = r; });
    const events: NotionRequestEvent[] = [];
    const server = http.createServer((request, res) => {
      requests++; response = res; request.resume();
      res.on("close", () => { closed = true; });
      if (mode === "body") { res.writeHead(200, { "Content-Type": "application/json" }); res.write("{"); }
      received();
    });
    await new Promise<void>(r => { server.listen(0, "127.0.0.1", r); });
    const port = (server.address() as AddressInfo).port;
    const transport = createNotionTransport({
      readTimeoutMs: 100,
      fetch: (input, init) => {
        const u = new URL(input instanceof Request ? input.url : String(input));
        assert.equal(u.origin, "https://api.notion.com");
        return globalThis.fetch(`http://127.0.0.1:${port}${u.pathname}`, init);
      },
      onEvent: event => { events.push(event); if (event.phase === "settled") settled(); },
    });
    const sdk = new Client({ auth: "DUMMY-ONLY", fetch: transport, retry: false, timeoutMs: mode === "write" ? 250 : 1000, logger: () => {} });
    try {
      const operation = mode === "write" ? sdk.pages.update({ page_id: id, properties: {} }) : sdk.dataSources.query({ data_source_id: id });
      const rejection = assert.rejects(operation);
      await receivedPromise; await rejection;
      assert.equal(requests, 1);
      assert.equal(events[0]?.kind, mode === "write" ? "write" : "read");
      if (mode === "write") {
        assert.equal(closed, false);
        assert.equal(events.length, 1, "SDK timeout must not invent transport settlement or abort a write");
        await assert.rejects(sdk.pages.update({ page_id: id, properties: {} }), /still unsettled/);
        await assert.rejects(sdk.dataSources.query({ data_source_id: id }), /still unsettled/);
        assert.equal(requests, 1, "outer SDK timeout must not allow overlapping requests");
        assert.equal(events.length, 1, "refused requests must not emit dispatch events");
        response!.writeHead(200, { "Content-Type": "application/json" }); response!.end("{}");
      }
      await settledPromise;
      assert.equal(events.length, 2);
      assert.equal(events[1]?.result, mode === "write" ? "fulfilled" : "rejected");
      assert.equal(events[1]?.status, mode === "headers" ? undefined : 200);
      await delay(20); assert.equal(requests, 1, "no SDK retry");
      for (const event of events) {
        assert(Object.keys(event).every(k => ["operation", "sequence", "kind", "phase", "result", "elapsedMs", "status"].includes(k)));
        assert(!JSON.stringify(event).includes("DUMMY"));
        assert(!JSON.stringify(event).includes(id));
      }
    } finally {
      server.closeAllConnections(); await new Promise<void>(r => { server.close(() => r()); });
    }
  });
}

test("caller signal is preserved for writes and composed for reads", async () => {
  const controller = new AbortController();
  let signal: AbortSignal | null | undefined;
  const transport = createNotionTransport({ fetch: async (_input, init) => { signal = init?.signal; return new Response("{}"); } });
  await transport("https://api.notion.com/v1/pages", { method: "POST", signal: controller.signal });
  assert.equal(signal, controller.signal);
  await transport(query, { method: "POST", signal: controller.signal });
  assert.notEqual(signal, controller.signal);
  controller.abort(); assert.equal(signal?.aborted, true);
});

test("telemetry failure before dispatch prevents network; settlement callback is not emitted twice", async () => {
  let calls = 0;
  const delegate: typeof fetch = async () => { calls++; return new Response("{}"); };
  await assert.rejects(createNotionTransport({ fetch: delegate, onEvent: () => { throw Error("sink failed"); } })(query));
  assert.equal(calls, 0);
  const events: NotionRequestEvent[] = [];
  await assert.rejects(createNotionTransport({ fetch: delegate, onEvent: event => { events.push(event); if (event.phase === "settled") throw Error("sink failed"); } })(query));
  assert.equal(events.length, 2); assert.equal(calls, 1);
});

test("invalid deadline rejected before dispatch", () => {
  for (const readTimeoutMs of [0, -1, NaN, 1.5]) assert.throws(() => createNotionTransport({ readTimeoutMs }));
});
