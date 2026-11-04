import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

test("actual workerd composed encrypted-auth/mirror pipeline survives restart and fences lost effects", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-pipeline-dummy-"));
  const bundle = await build({ entryPoints: ["test/fixtures/cloudflare-pipeline-worker.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2023", metafile: true });
  assert.equal(Object.keys(bundle.metafile!.inputs).some(name => /src\/(?:config|store\/db)|node_modules/.test(name)), false);
  let outboundCalls = 0;
  const start = () => new Miniflare({ modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: "2026-07-01", host: "127.0.0.1", port: 0,
    outboundService: () => { outboundCalls++; throw Error("Unexpected outbound call in dummy test"); },
    durableObjects: { PIPELINE: { className: "SyntheticPipelineObject", useSQLite: true } }, durableObjectsPersist: directory });
  let mf = start();
  const call = async (name: string, body: unknown) => {
    const response = await mf.dispatchFetch(`http://localhost/SYNTHETIC_${name}`, { method: "POST", body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const checkProtected = (mirror: any) => {
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
    const refreshed = await call("success", { action: "refresh", reference: imported.body.reference }); assert.equal(refreshed.status, 200);
    await mf.dispose(); mf = start();
    const before = (await call("success", { action: "inspect" })).body;
    assert.equal(before.auth.generation, 1); assert.equal(before.auth.status, "ready"); assert.equal(before.plaintextAbsent, true); assert.equal(before.journal.generation, 1); checkProtected(before.mirror);
    const projected = await call("success", { action: "project", reference: refreshed.body.reference }); assert.equal(projected.status, 200);
    await mf.dispose(); mf = start();
    const success = (await call("success", { action: "inspect" })).body;
    assert.equal(success.gate.phase, "ready"); assert.equal(success.gate.reference.journalGeneration, 2);
    assert.equal(success.effects, 1); assert.equal(success.journal.activeRunId, null); assert.equal(success.journal.generation, 2);
    assert.equal(success.mirror.document.assignments[0].sub_score, 2); assert.deepEqual(success.mirror.revisions, [{ assignmentId: 990000020, revision: 1, pending: false }, { assignmentId: 990000021, revision: 0, pending: false }]);
    assert.equal(success.auth.generation, 1); assert.equal(success.plaintextAbsent, true); checkProtected(success.mirror);
    assert.equal((await call("success", { action: "project", reference: refreshed.body.reference })).status, 409);
    assert.equal((await call("success", { action: "inspect" })).body.effects, 1);

    const lostImport = await call("lost", { action: "import" }); assert.equal(lostImport.status, 200);
    const lostRefresh = await call("lost", { action: "refresh", reference: lostImport.body.reference }); assert.equal(lostRefresh.status, 200);
    assert.equal((await call("lost", { action: "project", reference: lostRefresh.body.reference, loseEffect: true })).status, 409);
    const immediate = (await call("lost", { action: "inspect" })).body;
    assert.equal(immediate.effects, 1); assert.equal(immediate.gate.phase, "uncertain"); assert.equal(immediate.mirror.revisions[0].pending, true);
    assert.equal(immediate.journal.runs[1].status, "uncertain"); assert.equal(immediate.journal.runs[1].operations[0].acknowledged, false);
    await mf.dispose(); mf = start();
    assert.equal((await call("lost", { action: "project", reference: lostRefresh.body.reference })).status, 409);
    assert.equal((await call("lost", { action: "import" })).status, 409);
    const lost = (await call("lost", { action: "inspect" })).body;
    assert.equal(lost.effects, 1); assert.equal(lost.gate.phase, "uncertain"); assert.equal(lost.journal.activeRunId, "SYNTHETIC_project_run");
    assert.equal(lost.journal.generation, 1); assert.equal(lost.mirror.revisions[0].pending, true); assert.equal(lost.mirror.revisions[0].revision, 1); checkProtected(lost.mirror);
    assert.equal(lost.plaintextAbsent, true); assert.equal(outboundCalls, 0);
  } finally { await mf.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
});
