import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

test("fresh compact workerd pipeline: encrypted refresh, revision receipt/ack, 75 bounded no-ops and restart fail-closed", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-compact-pipeline-dummy-"));
  const bundle = await build({ entryPoints: ["test/fixtures/cloudflare-compact-pipeline-worker.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2023", metafile: true });
  assert.equal(Object.keys(bundle.metafile!.inputs).some(name => /src\/(?:config|store\/db)|node_modules/.test(name)), false);
  let outboundCalls = 0;
  const start = () => new Miniflare({ modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: "2026-07-01", host: "127.0.0.1", port: 0,
    outboundService: () => { outboundCalls++; throw Error("Unexpected outbound in local dummy test"); },
    durableObjects: { COMPACT_PIPELINE: { className: "SyntheticCompactPipelineObject", useSQLite: true } }, durableObjectsPersist: directory });
  let mf = start();
  const restart = async () => { await mf.dispose(); mf = start(); };
  const call = async (name: string, body: unknown) => {
    const response = await mf.dispatchFetch(`http://localhost/SYNTHETIC_${name}`, { method: "POST", body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const run = (name: string, action: string, ready: any, extra = {}) => call(name, { action, reference: ready.reference, triggerId: `SYNTHETIC_generation_${ready.reference.journalGeneration}`, ...extra });
  const inspect = async (name: string) => { const r = await call(name, { action: "inspect" }); assert.equal(r.status, 200); return r.body; };
  const protectedState = (mirror: any) => {
    assert.equal(mirror.document.assignments[1].sub_score, 1);
    assert.equal(mirror.document.protectedPages[1].doNotSync, true);
    for (const p of mirror.document.protectedPages) {
      assert.equal(p.hidden, true); assert.equal(p.inProgress, true);
      assert.deepEqual(p.notes, [{ text: "Dummy note sentinel", opaque: [null, true] }]);
      assert.deepEqual(p.activity, [{ text: "Dummy Activity sentinel", icon: null }]);
    }
    assert.deepEqual(mirror.document.snapshots, []); assert.equal(mirror.document.watermark, null);
  };
  try {
    const imported = await call("success", { action: "import" }); assert.equal(imported.status, 200);
    const refreshed = await run("success", "refresh", imported.body); assert.equal(refreshed.status, 200);
    await restart();
    const refreshedState = await inspect("success"); assert.equal(refreshedState.verified, true); assert.equal(refreshedState.auth.generation, 1); assert.equal(refreshedState.plaintextAbsent, true);
    const projected = await run("success", "project", refreshed.body); assert.equal(projected.status, 200);
    let ready = projected.body;
    const baseline = await inspect("success"); assert.equal(baseline.verified, true); assert.equal(baseline.effect.count, 1);
    assert.deepEqual(baseline.mirror.revisions, [{ assignmentId: 990000020, revision: 1, pending: false }, { assignmentId: 990000021, revision: 0, pending: false }]);
    const sizes: number[] = [];
    for (let i = 0; i < 75; i++) {
      if (i === 30) await restart();
      const result = await run("success", "noop", ready); assert.equal(result.status, 200); ready = result.body;
      const current = await inspect("success");
      assert.equal(current.verified, true); assert.equal(current.gate.phase, "ready"); assert.equal(current.journal.active, null);
      assert.equal(current.journal.generation, i + 3); assert.equal(current.journal.latestTerminal.generation, i + 2);
      assert.deepEqual(current.journal.latestTerminal, ready.terminal); assert.equal(current.effect.count, 1);
      assert.deepEqual(current.mirror, baseline.mirror); assert.equal(current.plaintextAbsent, true);
      assert.equal(current.tables.includes("sync_journal_v1"), false); assert.equal(current.tables.includes("synthetic_coordinator_v1"), false);
      sizes.push(Object.values(current.sizes).reduce((sum: number, n) => sum + Number(n), 0));
      protectedState(current.mirror);
    }
    assert.ok(Math.max(...sizes) - Math.min(...sizes) < 100, `State grew: ${Math.min(...sizes)} -> ${Math.max(...sizes)}`);
    assert.ok(Math.max(...sizes) < 16000);
    await restart();
    assert.equal((await inspect("success")).verified, true);
    assert.equal((await run("success", "project", refreshed.body)).status, 409);
    assert.equal((await run("success", "project", ready)).status, 409); // Old work cannot be relabeled current.
    assert.equal((await run("success", "noop", ready, { triggerId: "SYNTHETIC_generation_1" })).status, 409);
    assert.equal((await inspect("success")).effect.count, 1);

    for (const mode of ["lost", "ack"] as const) {
      const initial = await call(mode, { action: "import" }); assert.equal(initial.status, 200);
      const refreshed = await run(mode, "refresh", initial.body); assert.equal(refreshed.status, 200);
      const failed = await run(mode, "project", refreshed.body, mode === "lost" ? { loseEffect: true } : { failAck: true });
      assert.equal(failed.status, 409);
      const before = await inspect(mode);
      assert.equal(before.gate.phase, "uncertain"); assert.equal(before.verified, false); assert.equal(before.effect.count, 1);
      assert.equal(before.journal.generation, 1); assert.equal(before.journal.latestTerminal.generation, 0);
      assert.equal(before.journal.active.phase, mode === "lost" ? "uncertain" : "admitted");
      assert.equal(before.journal.active.outcomes[0].status, mode === "lost" ? "uncertain" : "succeeded");
      if (mode === "ack") assert.deepEqual(before.journal.active.outcomes[0].receipt, { receiptId: "SYNTHETIC_effect_1" });
      assert.equal(before.mirror.revisions[0].pending, true); assert.equal(before.cursor.generation, 1);
      await restart();
      assert.equal((await run(mode, "project", refreshed.body)).status, 409);
      assert.equal((await call(mode, { action: "import" })).status, 409);
      const after = await inspect(mode);
      assert.deepEqual(after.journal, before.journal); assert.deepEqual(after.gate, before.gate); assert.deepEqual(after.mirror, before.mirror);
      assert.equal(after.effect.count, 1); assert.equal(after.plaintextAbsent, true); protectedState(after.mirror);
    }
    // A matching terminal/root alone is not proof of concrete provider state.
    const tamperImport = await call("tamper", { action: "import" });
    const tamperRefresh = await run("tamper", "refresh", tamperImport.body);
    const tamperProject = await run("tamper", "project", tamperRefresh.body);
    assert.equal(tamperProject.status, 200);
    const honest = await inspect("tamper");
    assert.equal((await call("tamper", { action: "tamper-provider-receipt" })).status, 200);
    const corrupt = await inspect("tamper");
    assert.deepEqual(corrupt.journal, honest.journal); assert.equal(corrupt.verified, false);
    assert.equal((await run("tamper", "noop", tamperProject.body)).status, 409);
    const refused = await inspect("tamper");
    assert.equal(refused.gate.phase, "uncertain"); assert.deepEqual(refused.journal, honest.journal);
    assert.equal(refused.effect.count, 1);
    assert.equal(outboundCalls, 0);
  } finally { await mf.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
});
