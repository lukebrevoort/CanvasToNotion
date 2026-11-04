import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

test("real local workerd SQLite journal persists success and uncertainty across restarts", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cloudflare-dummy-"));
  const bundle = await build({ entryPoints: ["test/fixtures/cloudflare-worker.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2023" });
  const script = bundle.outputFiles[0]!.text;
  let outboundCalls = 0;
  const start = () => new Miniflare({ modules: true, script, compatibilityDate: "2026-07-01", host: "127.0.0.1", port: 0, outboundService: () => { outboundCalls++; throw new Error("Unexpected outbound network in dummy fixture"); }, durableObjects: { JOURNAL: { className: "SyntheticJournalObject", useSQLite: true } }, durableObjectsPersist: directory });
  let mf = start();
  const call = async (name: string, body: unknown) => {
    const response = await mf.dispatchFetch(`http://localhost/SYNTHETIC_${name}`, { method: "POST", body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const properties = (await call("success", { action: "project" })).body;
    assert.equal(properties.AssignmentID.number, 42);
    assert.equal((await call("success", { action: "initialize" })).status, 200);
    assert.equal((await call("success", { action: "run", runId: "SYNTHETIC_first", generation: 0 })).body.generation, 1);
    assert.equal((await call("lost", { action: "initialize" })).status, 200);
    assert.equal((await call("lost", { action: "run", runId: "SYNTHETIC_lost", generation: 0, loseReceipt: true })).status, 409);
    await mf.dispose(); mf = start();
    const success = (await call("success", { action: "inspect" })).body;
    assert.equal(success.journal.generation, 1); assert.equal(success.effects, 1);
    assert.equal((await call("success", { action: "run", runId: "SYNTHETIC_first", generation: 1 })).status, 409);
    const lost = (await call("lost", { action: "inspect" })).body;
    assert.equal(lost.journal.generation, 0); assert.equal(lost.effects, 1);
    assert.equal((await call("lost", { action: "run", runId: "SYNTHETIC_retry", generation: 0 })).status, 409);
    assert.equal((await call("lost", { action: "inspect" })).body.effects, 1);
    await call("race", { action: "initialize" });
    const race = await Promise.all(["one", "two"].map(run => call("race", { action: "run", runId: `SYNTHETIC_${run}`, generation: 0 })));
    assert.equal(race.filter(r => r.status === 200).length, 1);
    assert.equal((await call("race", { action: "inspect" })).body.effects, 1);
    assert.equal(outboundCalls, 0);
  } finally { await mf.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
});
