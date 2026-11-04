import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('actual workerd canonical projector: exact acknowledgments, protected content, deferred cursor, ambiguous writes and rollback', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canonical-project-dummy-'));
  const bundle = await build({ entryPoints: ['test/fixtures/cloudflare-canonical-project-worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2023', metafile: true });
  assert.equal(Object.keys(bundle.metafile!.inputs).some(name => /src\/(?:config|store\/db)|node_modules/.test(name)), false);
  let outbound = 0;
  const start = () => new Miniflare({ modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-07-01', host: '127.0.0.1', port: 0,
    outboundService: () => { outbound++; throw Error('No real outbound permitted'); }, durableObjects: { PROJECT: { className: 'SyntheticCanonicalProjectObject', useSQLite: true } }, durableObjectsPersist: directory });
  let mf = start();
  const restart = async () => { await mf.dispose(); mf = start(); };
  const call = async (name: string, action: string, extra = {}) => {
    const response = await mf.dispatchFetch(`http://localhost/${name}`, { method: 'POST', body: JSON.stringify({ action, ...extra }) });
    return { status: response.status, body: await response.json() as any };
  };
  const inspect = async (name: string) => { const r = await call(name, 'inspect'); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  const protectedState = (state: any) => {
    assert.equal(state.runs.length, 1); assert.equal(state.runs[0].status, 'running'); assert.equal(state.runs[0].finished_at, null); assert.equal(state.watermark, null);
    for (const page of Object.values(state.provider.pages) as any[]) {
      assert.equal(page.properties.Hidden.checkbox, true); assert.equal(page.properties['In Progress'].checkbox, true);
      const contents = page.blocks.map((b: any) => (b[b.type]?.rich_text ?? []).map((r: any) => r.text?.content ?? '').join(''));
      assert.ok(contents.includes('USER NOTE')); assert.ok(contents.includes('HISTORICAL ACTIVITY')); assert.ok(contents.includes('USER PREFACE'));
    }
    for (const call of state.provider.calls.filter((c: any) => c.method === 'PATCH' && c.path.startsWith('/v1/pages/'))) {
      for (const key of ['Do Not Sync', 'Hidden', 'In Progress']) assert.equal(Object.hasOwn(call.body.properties, key), false);
    }
  };
  try {
    const seeded = await call('success', 'initialize'); assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
    const original = await inspect('success');
    const result = await call('success', 'project'); assert.equal(result.status, 200, JSON.stringify(result.body));
    let state = await inspect('success'); protectedState(state);
    assert.equal(state.pending.length, 0); assert.equal(state.projection.outcomes.length, 2); assert.equal(state.journal.generation, 1); assert.equal(state.journal.active, null);
    assert.deepEqual(state.projection.outcomes.map((o: any) => o.revision), seeded.body.pending.map((p: any) => p.revision));
    assert.ok(state.projection.outcomes.every((o: any) => o.acknowledged && o.pushed && o.requestsUsed > 2));
    for (const [pageId, page] of Object.entries(state.provider.pages) as [string, any][]) {
      const protectedIds = original.provider.pages[pageId].blocks.filter((b: any) => /dummy-(?:preface|notes|note|activity|history)-/.test(b.id));
      assert.deepEqual(page.blocks.filter((b: any) => protectedIds.some((p: any) => p.id === b.id)), protectedIds);
      const operation = state.projection.outcomes.find((o: any) => o.pageId === pageId);
      assert.equal(page.blocks.filter((b: any) => JSON.stringify(b).includes(`revision=${operation.revision}`)).length, 1);
      assert.equal(page.blocks.some((b: any) => JSON.stringify(b).includes('OLD FACTS')), false);
    }
    const baseline = state;
    await restart(); state = await inspect('success'); assert.deepEqual(state, baseline);

    for (const mode of ['frozen', 'late-frozen']) {
      assert.equal((await call(mode, 'initialize', { mode })).status, 200);
      const first = await call(mode, 'project', { mode, limit: 1 }); assert.equal(first.status, 200, JSON.stringify(first.body));
      const deferred = await inspect(mode); protectedState(deferred);
      assert.equal(deferred.pending.length, 2); assert.equal(deferred.projection.outcomes[0].pushed, false); assert.equal(deferred.projection.outcomes[0].acknowledged, false);
      assert.deepEqual(deferred.projection.attemptedAssignmentIds, [990000020]);
      const writes = deferred.provider.calls.filter((c: any) => c.method !== 'GET' && !c.path.includes('/data_sources/'));
      assert.equal(writes.length > 0, mode === 'late-frozen');
      await restart();
      const next = await call(mode, 'project', { limit: 1 }); assert.equal(next.status, 200, JSON.stringify(next.body));
      const advanced = await inspect(mode); protectedState(advanced);
      assert.deepEqual(advanced.pending.map((p: any) => p.assignment_id), [990000020]);
      assert.deepEqual(advanced.projection.attemptedAssignmentIds, [990000020, 990000021]);
      assert.equal(advanced.journal.generation, 2);
    }
    for (const mode of ['lost', 'unsettled', 'rollback', 'same-revision']) {
      const init = await call(mode, 'initialize'); assert.equal(init.status, 200);
      const result = await call(mode, 'project', { mode }); assert.equal(result.status, 409, JSON.stringify(result.body));
      const before = await inspect(mode); protectedState(before);
      assert.equal(before.pending.length, 2); assert.equal(before.journal.generation, 0); assert.equal(before.journal.latestTerminal, null);
      assert.equal(before.journal.active.phase, 'uncertain'); assert.equal(before.projection.phase, 'running'); assert.equal(before.projection.outcomes.length, 0);
      assert.ok(before.provider.calls.some((c: any) => c.method === 'PATCH'));
      if (mode === 'same-revision') { assert.equal(before.pending[0].revision, init.body.pending[0].revision); assert.equal(before.pending[0].force_details, 1); }
      await restart();
      assert.equal((await call(mode, 'project')).status, 409);
      const after = await inspect(mode); protectedState(after); assert.deepEqual(after, before);
    }
    for (const mode of ['budget', 'deadline', 'validity', 'sync-failure', 'terminal-mutation']) {
      assert.equal((await call(mode, 'initialize')).status, 200);
      const failed = await call(mode, 'project', { mode }); assert.equal(failed.status, 409, `${mode}: ${JSON.stringify(failed.body)}`);
      const before = await inspect(mode); protectedState(before);
      assert.notEqual(before.projection?.phase, 'terminal');
      if (mode === 'budget') { assert.ok(before.provider.calls.length <= 15); assert.equal(before.pending.length, 1); assert.equal(before.projection.outcomes.length, 1); }
      if (mode === 'validity') assert.equal(before.provider.calls.length, 0);
      if (mode === 'deadline') assert.equal(before.pending.length, 2);
      if (mode === 'sync-failure') { assert.equal(before.pending.length, 1); assert.equal(before.projection.outcomes[0].acknowledged, true); assert.equal(before.journal.active.phase, 'uncertain'); }
      if (mode === 'terminal-mutation') { assert.equal(before.pending.length, 1); assert.equal(before.journal.generation, 1); assert.equal(before.projection.phase, 'running'); }
      await restart(); assert.equal((await call(mode, 'project')).status, 409);
      const after = await inspect(mode); protectedState(after); assert.deepEqual(after.provider, before.provider); assert.deepEqual(after.pending, before.pending); assert.deepEqual(after.projection, before.projection);
    }
    assert.equal(outbound, 0);
  } finally { await mf.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
});
