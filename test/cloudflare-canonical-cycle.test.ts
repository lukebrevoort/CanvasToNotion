import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import type { CanonicalCycleState } from '../src/cloudflare/canonical-cycle.js';

test('actual workerd resumes bounded multipage canonical source cycle, without advancing successful watermark', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canonical-cycle-dummy-'));
  const bundle = await build({ entryPoints: ['test/fixtures/cloudflare-canonical-cycle-worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2023', metafile: true });
  assert.equal(Object.keys(bundle.metafile!.inputs).some(p => /node_modules|src\/(?:config|store\/db)/.test(p)), false);
  let outbound = 0;
  const start = () => new Miniflare({ modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-07-01', host: '127.0.0.1', port: 0,
    outboundService: () => { outbound++; throw Error('No real outbound allowed'); },
    durableObjects: { CYCLE: { className: 'SyntheticCanonicalCycleObject', useSQLite: true } }, durableObjectsPersist: directory });
  let mf = start();
  const restart = async () => { await mf.dispose(); mf = start(); };
  const call = async (name: string, action: string, extra: object = {}) => {
    const response = await mf.dispatchFetch(`http://localhost/${name}`, { method: 'POST', body: JSON.stringify({ action, ...extra }) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    let state = (await call('normal', 'initialize')).body as CanonicalCycleState;
    const startedAt = state.startedAt, since = state.since;
    assert.equal(since, '2026-11-03T01:00:00.000Z');
    const requests: string[] = [];
    const phases = new Set<string>();
    let steps = 0;
    while (state.status !== 'source_complete') {
      phases.add(state.phase); assert.ok(++steps < 30);
      const before = structuredClone(state);
      const response = await call('normal', 'step', { expected: state });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.ok(response.body.reads <= 1);
      requests.push(...response.body.urls);
      state = response.body.state;
      assert.equal(state.startedAt, startedAt); assert.equal(state.since, since);
      const stale = await call('normal', 'step', { expected: before }); assert.equal(stale.status, 409);
      await restart();
      assert.deepEqual((await call('normal', 'inspect')).body.state, state);
    }
    assert.ok(phases.has('submission')); assert.ok(phases.has('observations'));
    assert.equal(state.coursesSeen, 2); assert.equal(state.assignmentsSeen, 2);
    assert.equal(state.courses[0]!.timeZone, 'America/New_York');
    for (const url of requests.filter(url => new URL(url).pathname.endsWith('/assignments'))) assert.equal(new URL(url).searchParams.get('updated_since'), since);
    const final = (await call('normal', 'inspect')).body;
    assert.equal(final.snapshots.length, 2); assert.equal(final.pending.length, 2);
    assert.equal(final.assignments[0].group_weight, 0.3); assert.equal(final.assignments[1].sub_score, 8);
    assert.equal(final.assignments[0].calendar_due_at, '2026-11-09');
    assert.deepEqual(final.runs.map((r: any) => r.status), ['ok', 'running']);
    assert.equal((await call('normal', 'step', { expected: state })).status, 409);

    for (const failure of ['network', 'badId']) {
      let s = (await call(failure, 'initialize')).body;
      const failed = await call(failure, 'step', { expected: s, ...(failure === 'badId' ? { badId: true } : { failure }) });
      assert.equal(failed.status, 409); s = failed.body.state; assert.equal(s.status, 'reading');
      assert.equal((await call(failure, 'step', { expected: s })).status, 409);
      await restart();
      const recovered = await call(failure, 'retry', { expected: s });
      assert.equal(recovered.status, 200); assert.equal(recovered.body.state.phase, 'courses');
      assert.equal(recovered.body.state.runId, s.runId); assert.equal(recovered.body.state.since, s.since);
    }
    for (const mode of ['known-fallback', 'bad-submission', 'unknown-fallback', 'full']) {
      let s = (await call(mode, 'initialize', { full: mode === 'full' })).body;
      let count = 0;
      while (s.phase !== 'submission') {
        assert.ok(++count < 30);
        const r = await call(mode, 'step', { expected: s }); assert.equal(r.status, 200, JSON.stringify(r.body)); s = r.body.state;
      }
      const r = await call(mode, 'step', { expected: s, ...(mode === 'known-fallback' ? { failure: 'http' } : mode === 'bad-submission' ? { badSubmission: true } : mode === 'unknown-fallback' ? { failure: 'network' } : {}) });
      if (mode === 'known-fallback' || mode === 'full') {
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const view = (await call(mode, 'inspect')).body;
        assert.equal(view.assignments.length, 2);
        assert.equal(view.assignments[1].sub_score, mode === 'known-fallback' ? null : 8);
        assert.equal(view.state.fallbackUnavailable, mode === 'known-fallback' ? 1 : 0);
        if (mode === 'full') { assert.equal(view.state.since, null); assert.ok(view.pending.every((p: any) => p.force_details === 1)); }
      } else {
        assert.equal(r.status, 409); assert.equal(r.body.state.status, 'reading');
        assert.equal((await call(mode, 'inspect')).body.assignments.length, 1);
      }
    }
    let faultState = (await call('checkpoint-fault', 'initialize')).body;
    while (faultState.phase !== 'observations') {
      const next = await call('checkpoint-fault', 'step', { expected: faultState });
      assert.equal(next.status, 200); faultState = next.body.state;
    }
    assert.equal((await call('checkpoint-fault', 'arm-checkpoint-fault')).status, 200);
    const faulted = await call('checkpoint-fault', 'step', { expected: faultState });
    assert.equal(faulted.status, 409); assert.match(faulted.body.error, /uncertain/);
    const rolledBack = (await call('checkpoint-fault', 'inspect')).body;
    assert.deepEqual(rolledBack.state, faultState);
    assert.deepEqual(rolledBack.assignments, []); assert.deepEqual(rolledBack.snapshots, []); assert.deepEqual(rolledBack.pending, []);
    await restart();
    const restoredFailure = (await call('checkpoint-fault', 'inspect')).body;
    assert.deepEqual(restoredFailure, rolledBack);
    assert.equal(outbound, 0);
  } finally { await mf.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
});

import Database from 'better-sqlite3';
import { SyntheticCanonicalCycle } from '../src/cloudflare/canonical-cycle.js';
import { SyntheticJsonTransport } from '../src/cloudflare/transport.js';
import type { DurableSqlStorage } from '../src/cloudflare/sqlite-storage.js';
function localFixture() {
  const db = new Database(':memory:');
  let failSync = false;
  const storage: DurableSqlStorage = {
    sql: { exec(sql, ...bindings) {
      if (/^\s*CREATE\b/i.test(sql)) { db.exec(sql); return { toArray: () => [] }; }
      const statement = db.prepare(sql);
      const rows = statement.reader ? statement.all(...bindings) : (statement.run(...bindings), []);
      return { toArray: () => rows as any };
    } }, transactionSync: callback => db.transaction(callback)(),
    sync: async () => { if (failSync) throw Error('Dummy durability loss'); },
  };
  const create = () => new SyntheticCanonicalCycle(storage, { now: () => '2026-11-04T00:00:00Z', randomUUID: () => 'SYNTHETIC_revision' });
  return { db, storage, create, setFailSync: () => { failSync = true; } };
}
const transport = (fetch: typeof globalThis.fetch, timeoutMs = 1000) => new SyntheticJsonTransport({ syntheticOnly: true, origin: 'https://canvas.invalid', requestBudget: 1, timeoutMs, fetch });

test('explicit new read generation fences old delayed response without reapplying local state', async () => {
  const { db, create } = localFixture();
  try {
    const first = create(), second = create();
    const initial = await first.initialize({ syntheticOnly: true, cycleId: 'SYNTHETIC_race' });
    let resolve!: (r: Response) => void;
    let started!: () => void;
    const dispatched = new Promise<void>(r => { started = r; });
    const old = first.step(initial, transport(async () => { started(); return await new Promise<Response>(r => { resolve = r; }); }));
    const oldRejected = assert.rejects(old, /stale/);
    await dispatched;
    const admitted = (await second.inspect())!;
    assert.equal(admitted.status, 'reading');
    const newer = await second.retryRead(admitted, transport(async () => Response.json({ id: 990000005 })));
    assert.equal(newer.phase, 'courses');
    resolve(Response.json({ id: 990000006 }));
    await oldRejected;
    assert.deepEqual(await second.inspect(), newer);
    assert.equal(newer.userId, 990000005);
    assert.equal((db.prepare('SELECT count(*) AS n FROM sync_runs').get() as { n: number }).n, 1);
  } finally { db.close(); }
});

test('unsettled timed-out read cannot be retried by live instance; explicit settled retry can proceed', async () => {
  const { db, create } = localFixture();
  try {
    const cycle = create(), state = await cycle.initialize({ syntheticOnly: true, cycleId: 'SYNTHETIC_timeout' });
    let finish!: (r: Response) => void;
    const slow = transport(async () => new Promise<Response>(resolve => { finish = resolve; }), 5);
    await assert.rejects(cycle.step(state, slow), /read/);
    const pending = (await cycle.inspect())!;
    await assert.rejects(cycle.retryRead(pending, transport(async () => Response.json({ id: 990000005 }))), /blocked/);
    finish(Response.json({ id: 990000005 })); await slow.settleStartedRequests();
    assert.equal((await cycle.retryRead(pending, transport(async () => Response.json({ id: 990000005 })))).phase, 'courses');
  } finally { db.close(); }
});

test('failed durability acknowledgment prevents dispatch and subsequent work in same instance', async () => {
  const fixture = localFixture();
  try {
    const cycle = fixture.create(), initial = await cycle.initialize({ syntheticOnly: true, cycleId: 'SYNTHETIC_sync' });
    fixture.setFailSync(); let reads = 0;
    const port = transport(async () => { reads++; return Response.json({ id: 990000005 }); });
    await assert.rejects(cycle.step(initial, port), /uncertain/);
    const persisted = (await cycle.inspect())!;
    await assert.rejects(cycle.retryRead(persisted, port), /uncertain/);
    assert.equal(reads, 0);
    assert.equal((fixture.db.prepare('SELECT status FROM sync_runs').get() as { status: string }).status, 'running');
  } finally { fixture.db.close(); }
});

test('course capacity refusal rolls back the whole page with no source completion', async () => {
  const { db, create } = localFixture();
  try {
    const cycle = create(); let state = await cycle.initialize({ syntheticOnly: true, cycleId: 'SYNTHETIC_capacity' });
    state = await cycle.step(state, transport(async () => Response.json({ id: 990000005 })));
    for (let page = 0; page < 3; page++) {
      const read = () => cycle.step(state, transport(async input => {
        const next = new URL(String(input)); next.searchParams.set('page', String(page + 2));
        return Response.json(Array.from({ length: 100 }, (_, i) => ({ id: 990001000 + page * 100 + i, name: 'Dummy course' })), { headers: { Link: `<${next.href}>; rel="next"` } });
      }));
      if (page < 2) state = await read(); else await assert.rejects(read(), /capacity/);
    }
    const persisted = (await cycle.inspect())!;
    assert.equal(persisted.status, 'reading'); assert.equal(persisted.coursesSeen, 200);
    assert.equal((db.prepare('SELECT count(*) AS n FROM courses').get() as { n: number }).n, 200);
  } finally { db.close(); }
});

test('assignment page cannot exceed the 1000-observation planner bound', async () => {
  const { db, create } = localFixture();
  try {
    const cycle = create(); let state = await cycle.initialize({ syntheticOnly: true, cycleId: 'SYNTHETIC_observation_capacity' });
    for (const payload of [{ id: 990000005 }, [{ id: 990000001, name: 'Dummy course' }], []]) state = await cycle.step(state, transport(async () => Response.json(payload)));
    assert.equal(state.phase, 'assignments');
    // Test-only boundary checkpoint, avoiding 999 irrelevant observation writes.
    state.assignmentsSeen = 999;
    db.prepare('UPDATE synthetic_canonical_cycle_v1 SET document=? WHERE slot=1').run(JSON.stringify(state));
    await assert.rejects(cycle.step(state, transport(async () => Response.json([990000020, 990000021].map(id => ({ id, course_id: 990000001, name: 'Dummy assignment' }))))), /capacity/);
    const after = (await cycle.inspect())!;
    assert.equal(after.assignmentsSeen, 999); assert.equal(after.staged, null); assert.equal(after.status, 'reading');
    assert.equal((db.prepare('SELECT count(*) AS n FROM assignments').get() as { n: number }).n, 0);
  } finally { db.close(); }
});

test('tampered source checkpoints reject mismatched phase, course, counters, staged page and canonical run evidence', async () => {
  const { db, create } = localFixture();
  try {
    const cycle = create(); let state = await cycle.initialize({ syntheticOnly: true, cycleId: 'SYNTHETIC_validation' });
    const payloads = [{ id: 990000005 }, [{ id: 990000001, name: 'Dummy course' }], [], [{ id: 990000020, course_id: 990000001, name: 'Dummy assignment', submission: { assignment_id: 990000020, score: 1 } }]];
    for (const payload of payloads) state = await cycle.step(state, transport(async () => Response.json(payload)));
    assert.equal(state.phase, 'observations');
    const put = (value: any) => db.prepare('UPDATE synthetic_canonical_cycle_v1 SET document=?').run(JSON.stringify(value));
    const mutations: ((s: any) => void)[] = [
      s => { s.phase = 'groups'; }, s => { s.courses[0].id = 990000009; },
      s => { s.userId = null; }, s => { s.userId = 1; },
      s => { s.coursesSeen++; }, s => { s.fallbackUnavailable = 1; },
      s => { s.runId += 1; }, s => { s.startedAt = '2000-01-01T00:00:00Z'; },
      s => { s.staged.items[0].course_id = 990000009; },
      s => { s.staged.items[0].id = 990000099; },
      s => { s.since = '2020-01-01T00:00:00.000Z'; },
      s => { s.phase = 'source_complete'; s.status = 'source_complete'; },
    ];
    for (const mutate of mutations) {
      const bad = structuredClone(state); mutate(bad); put(bad);
      await assert.rejects(cycle.inspect(), /invalid|response/);
      let calls = 0;
      await assert.rejects(cycle.step(bad, transport(async () => { calls++; return Response.json([]); })), /invalid|response/);
      assert.equal(calls, 0); put(state);
    }
    db.prepare("UPDATE sync_runs SET status='ok' WHERE id=?").run(state.runId);
    await assert.rejects(cycle.inspect(), /invalid/);
    db.prepare("UPDATE sync_runs SET status='running', started_at='1999-01-01' WHERE id=?").run(state.runId);
    await assert.rejects(cycle.inspect(), /invalid/);
    db.prepare('UPDATE sync_runs SET started_at=? WHERE id=?').run(state.startedAt, state.runId);
    state = await cycle.step(state);
    assert.equal(state.status, 'source_complete');
    for (const mutate of [(s: any) => { s.courseIndex = 0; }, (s: any) => { s.page = (structuredClone(payloads) as any); }, (s: any) => { s.groups = [{ id: 990000010, name: 'Dummy', weight: 0.2 }]; }]) {
      const bad = structuredClone(state); mutate(bad); put(bad);
      await assert.rejects(cycle.inspect()); put(state);
    }
    assert.deepEqual(await cycle.inspect(), state);
  } finally { db.close(); }
});
