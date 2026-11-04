import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { plain, options } from "./fixtures/synthetic-notion-http.js";

test("actual workerd pure Notion projection/replay preserves human content and fences lost responses with no outbound network", async () => {
  const bundle = await build({ entryPoints: ["test/fixtures/cloudflare-notion-runtime-worker.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2023", metafile: true });
  assert.equal(Object.keys(bundle.metafile!.inputs).some(name => /src\/(?:config|store\/db)|node_modules/.test(name)), false);
  assert.equal(/(?:from\s*["']node:|require\(["']node:)/.test(bundle.outputFiles[0]!.text), false);
  let outboundCalls = 0;
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: "2026-07-01", host: "127.0.0.1", port: 0,
    outboundService: () => { outboundCalls++; throw Error("Refused unexpected outbound network in dummy Notion test"); } });
  const call = async (route: string) => {
    const response = await mf.dispatchFetch(`http://localhost/${route}`);
    assert.equal(response.status, 200); return await response.json() as any;
  };
  const receiptCount = (blocks: any[]) => blocks.filter(b => plain(b).includes(`[assignment=42;revision=${options.revision}]`)).length;
  try {
    const projected = await call("projection");
    assert.deepEqual(projected.results, [{ pageId: "dummy-page", pushed: true }, { pageId: "dummy-page", pushed: true }, { pageId: "dummy-page", pushed: false }]);
    assert.equal(receiptCount(projected.blocks), 1);
    for (const id of ["dummy-preface", "dummy-notes", "dummy-note", "dummy-activity", "dummy-history"]) assert.deepEqual(projected.blocks.find((b: any) => b.id === id), projected.original.find((b: any) => b.id === id));
    assert.equal(projected.properties.Hidden.checkbox, true); assert.equal(projected.properties["In Progress"].checkbox, true); assert.equal(projected.properties["Do Not Sync"].checkbox, true);
    for (const c of projected.calls.filter((c: any) => c.path.startsWith("/v1/pages/") && c.method === "PATCH")) for (const key of ["Hidden", "In Progress", "Do Not Sync"]) assert(!Object.hasOwn(c.body.properties, key));
    assert.deepEqual(projected.frozenCalls.map((c: any) => c.method), ["POST", "GET"]);
    assert.deepEqual(projected.blocks, projected.afterReplay);
    const lost = await call("lost-response");
    assert.match(lost.lost, /unresolved/); assert.match(lost.poisoned, /uncertain/);
    assert.equal(lost.after, lost.before); assert.equal(lost.reconciled, "reused");
    assert.equal(lost.calls.filter((c: any) => c.path.endsWith("/children") && c.method === "PATCH").length, 1);
    assert.equal(receiptCount(lost.blocks), 1);
    assert.equal(outboundCalls, 0);
  } finally { await mf.dispose(); }
});
