/** Dummy-only local workerd cycle fixture. All provider reads are intercepted. */
import { SyntheticCanonicalCycle } from '../../src/cloudflare/canonical-cycle.js';
import { createDurableSqlDatabase } from '../../src/cloudflare/canonical-sql.js';
import { createStore } from '../../src/store/core.js';
import type { DurableSqlStorage } from '../../src/cloudflare/sqlite-storage.js';
import { SyntheticJsonTransport } from '../../src/cloudflare/transport.js';
const COURSE = 990000001, USER = 990000005;
export class SyntheticCanonicalCycleObject {
  private cycle: SyntheticCanonicalCycle;
  constructor(private state: { storage: DurableSqlStorage }) {
    this.cycle = new SyntheticCanonicalCycle(state.storage, { now: () => '2026-11-04T01:00:00.000Z', randomUUID: () => crypto.randomUUID() });
  }
  async fetch(request: Request) {
    const body = await request.json() as any;
    const db = createDurableSqlDatabase(this.state.storage);
    try {
      if (body.action === 'initialize') {
        const seed = createStore(db, { now: () => '2026-11-03T01:00:00.000Z', randomUUID: () => 'SYNTHETIC_seed' });
        const run = seed.startSyncRun(); seed.finishSyncRun(run, 'ok', {});
        return Response.json(await this.cycle.initialize({ syntheticOnly: true, cycleId: 'SYNTHETIC_cycle', full: body.full ?? false }));
      }
      if (body.action === 'arm-checkpoint-fault') {
        this.state.storage.sql.exec(`CREATE TRIGGER synthetic_cycle_checkpoint_fault BEFORE UPDATE ON synthetic_canonical_cycle_v1
          WHEN json_extract(NEW.document, '$.assignmentsSeen') > json_extract(OLD.document, '$.assignmentsSeen')
          BEGIN SELECT RAISE(ABORT, 'Dummy checkpoint failure'); END`).toArray();
        await this.state.storage.sync();
        return Response.json({ armed: true });
      }
      if (body.action === 'inspect') {
        const state = await this.cycle.inspect();
        return Response.json({ state, assignments: db.prepare('SELECT * FROM assignments ORDER BY canvas_id').all(), snapshots: db.prepare('SELECT * FROM snapshots ORDER BY id').all(), pending: db.prepare('SELECT * FROM pending_assignment_projections ORDER BY assignment_id').all(), runs: db.prepare('SELECT * FROM sync_runs ORDER BY id').all() });
      }
      let reads = 0;
      const urls: string[] = [];
      const transport = new SyntheticJsonTransport({ syntheticOnly: true, origin: 'https://canvas.invalid', requestBudget: 1, timeoutMs: body.failure === 'delay' ? 20 : 1000, maxResponseBytes: 65536,
        fetch: async (input) => {
          reads++; const url = new URL(String(input)); urls.push(url.href);
          if (body.failure === 'network') throw Error('Dummy network failure');
          if (body.failure === 'delay') await new Promise(resolve => setTimeout(resolve, 80));
          if (body.failure === 'http') return new Response('Dummy unavailable', { status: 404 });
          const next = () => { const n = new URL(url); n.searchParams.set('page', '2'); return { Link: `<${n.href}>; rel="next"` }; };
          if (url.pathname.endsWith('/users/self')) return Response.json({ id: body.badId ? 1 : USER });
          if (url.pathname.endsWith('/courses')) return Response.json(url.searchParams.has('page') ? [{ id: COURSE + 1, name: 'Dummy empty course', time_zone: 'UTC' }] : [{ id: COURSE, name: 'Dummy course', time_zone: 'America/New_York' }], { headers: url.searchParams.has('page') ? {} : next() });
          if (url.pathname.endsWith('/assignment_groups')) return Response.json([{ id: 990000010, name: 'Dummy group', group_weight: 30 }]);
          if (url.pathname.endsWith('/assignments')) {
            if (url.pathname.includes(`/${COURSE + 1}/`)) return Response.json([]);
            const second = url.searchParams.has('page');
            const item = { id: second ? 990000021 : 990000020, course_id: COURSE, name: 'Dummy assignment', assignment_group_id: 990000010, due_at: '2026-11-10T04:59:00Z', submission_types: ['online_text_entry'], ...(second ? {} : { submission: { assignment_id: 990000020, score: 9, late: false } }) };
            return Response.json([item], { headers: second ? {} : next() });
          }
          if (url.pathname.includes('/submissions/')) return Response.json({ assignment_id: body.badSubmission ? 990000099 : 990000021, score: 8, workflow_state: 'graded' });
          throw Error('Unexpected dummy endpoint');
        },
      });
      const result = body.action === 'retry' ? await this.cycle.retryRead(body.expected, transport) : await this.cycle.step(body.expected, transport);
      return Response.json({ state: result, reads, urls });
    } catch (e) { return Response.json({ error: e instanceof Error ? e.message : 'failure', state: await this.cycle.inspect() }, { status: 409 }); }
  }
}
export default { fetch(request: Request, env: { CYCLE: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }) {
  return env.CYCLE.get(env.CYCLE.idFromName(new URL(request.url).pathname)).fetch(request);
} };
