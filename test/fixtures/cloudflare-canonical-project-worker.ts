/** Actual-workerd canonical/projector fixture. All data and credentials are public dummies. */
import { createDurableSqlDatabase } from '../../src/cloudflare/canonical-sql.js';
import { createStore, type AssignmentInput } from '../../src/store/core.js';
import { planCanonicalPendingBatch } from '../../src/cloudflare/canonical-plan.js';
import { CompactSyntheticJournal, compactTriggerId } from '../../src/cloudflare/compact-journal.js';
import { DurableSqlCompactStorage } from '../../src/cloudflare/compact-sqlite-storage.js';
import { SyntheticAuthStateAdapter, createSyntheticAesGcmCipher, type SyntheticAuthStateRecord } from '../../src/cloudflare/auth-state.js';
import type { DurableSqlStorage } from '../../src/cloudflare/sqlite-storage.js';
import { SyntheticSqlPort } from './synthetic-sql-port.js';
import { SyntheticCanonicalProjector } from '../../src/cloudflare/canonical-project.js';
import { SyntheticCanonicalCycle } from '../../src/cloudflare/canonical-cycle.js';
import { SyntheticJsonTransport } from '../../src/cloudflare/transport.js';
import { initialProvider, providerFetch, type DummyProvider } from './canonical-projection-http.js';
const binding = { accountId: 'SYNTHETIC_account', sourceId: 'SYNTHETIC_canvas', destinationId: 'SYNTHETIC_notion' };
const COURSE = 990000001, IDS = [990000020, 990000021];
const destinations = { assignmentsDbId: 'SYNTHETIC_assignments_db', assignmentsDsId: 'SYNTHETIC_assignments_ds', coursesDbId: 'SYNTHETIC_courses_db', coursesDsId: 'SYNTHETIC_courses_ds' };
const assignment = (id: number): AssignmentInput => ({ canvas_id: id, course_id: COURSE, name: 'dummy-assignment', due_at: null, calendar_due_at: null, unlock_at: null, lock_at: null, points_possible: 10, description_html: '<p>Dummy</p>', submission_types: '["online_text_entry"]', group_id: null, group_name: null, group_weight: null, is_quiz: false, position: 1, updated_at: null, sub_workflow_state: 'graded', sub_score: 8, sub_grade: '8', sub_submitted_at: null, sub_graded_at: null, sub_attempts: 1, sub_late: false, sub_excused: null, sub_missing: false });
export class SyntheticCanonicalProjectObject {
  private journal: CompactSyntheticJournal;
  private db;
  private store;
  private authPromise?: Promise<SyntheticAuthStateAdapter>;
  constructor(private state: { storage: DurableSqlStorage }) {
    this.journal = new CompactSyntheticJournal(new DurableSqlCompactStorage(state.storage));
    this.db = createDurableSqlDatabase(state.storage);
    this.store = createStore(this.db, { now: () => '2026-11-04T01:00:00.000Z', randomUUID: () => crypto.randomUUID() });
  }
  private auth() { return this.authPromise ??= (async () => {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(17), 'AES-GCM', false, ['encrypt', 'decrypt']);
    return new SyntheticAuthStateAdapter({ scope: { ...binding, syntheticOnly: true }, storage: new SyntheticSqlPort<SyntheticAuthStateRecord>(this.state.storage), cipher: createSyntheticAesGcmCipher(key) });
  })(); }
  private readProvider(): DummyProvider { return JSON.parse((this.db.prepare('SELECT document FROM dummy_provider WHERE slot=1').get() as { document: string }).document); }
  private async saveProvider(provider: DummyProvider) { this.db.prepare('INSERT INTO dummy_provider VALUES(1, ?) ON CONFLICT(slot) DO UPDATE SET document=excluded.document').run(JSON.stringify(provider)); await this.state.storage.sync(); }
  async fetch(request: Request): Promise<Response> {
    const body = await request.json() as any;
    try {
      if (body.action === 'initialize') {
        this.db.exec('CREATE TABLE dummy_provider(slot INTEGER PRIMARY KEY, document TEXT NOT NULL)');
        this.store.upsertCourse({ id: COURSE, name: 'dummy-course' });
        const cycle = new SyntheticCanonicalCycle(this.state.storage, { now: () => '2026-11-04T01:00:00.000Z', randomUUID: () => crypto.randomUUID() });
        let source = await cycle.initialize({ syntheticOnly: true, cycleId: 'SYNTHETIC_cycle', full: false });
        while (source.phase !== 'source_complete') {
          const transport = new SyntheticJsonTransport({ syntheticOnly: true, origin: 'https://canvas.invalid', requestBudget: 1, fetch: async input => {
            const path = new URL(String(input)).pathname;
            if (path.endsWith('/users/self')) return Response.json({ id: 990000005 });
            if (path.endsWith('/courses')) return Response.json([{ id: COURSE, name: 'dummy-course', time_zone: 'UTC' }]);
            return Response.json([]);
          } });
          source = await cycle.step({ cycleId: source.cycleId, revision: source.revision }, transport);
        }
        for (const id of IDS) {
          this.store.upsertAssignment({ ...assignment(id), sub_score: 7, sub_grade: '7' });
          this.store.completeProjection(this.store.pendingProjectionsForCourse(COURSE).find(p => p.assignment_id === id)!);
          this.store.upsertAssignment(assignment(id));
        }
        const provider = initialProvider(IDS);
        if (body.mode === 'frozen') provider.pages[`SYNTHETIC_page_${IDS[0]}`].properties['Do Not Sync'].checkbox = true;
        await this.saveProvider(provider);
        await this.journal.initialize(binding);
        await (await this.auth()).initialize({ accessToken: 'dummy-access', refreshToken: 'dummy-refresh', expiresAt: Date.now() + 600000 });
        return Response.json({ pending: this.store.pendingProjectionsForCourse(COURSE) });
      }
      if (body.action === 'inspect') return Response.json({ provider: this.readProvider(), pending: this.store.pendingProjectionsForCourse(COURSE), journal: await this.journal.inspect(), projection: await new SyntheticCanonicalProjector(this.state.storage, { now: () => '2026-11-04T01:00:00.000Z', randomUUID: () => crypto.randomUUID() }).inspect(), runs: this.db.prepare('SELECT * FROM sync_runs').all(), watermark: this.store.lastSuccessfulSyncStart() ?? null });
      if (body.action === 'project') return await this.project(body);
      throw Error('Unknown dummy command');
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
  }
  private async project(body: any): Promise<Response> {
    const old = await new SyntheticCanonicalProjector(this.state.storage, { now: () => '2026-11-04T01:00:00.000Z', randomUUID: () => crypto.randomUUID() }).inspect();
    const plan = await planCanonicalPendingBatch(this.store, { mode: 'dummy', binding, destinations,
      observedCourses: [{ courseId: COURSE, coursePageId: 'SYNTHETIC_course_page', courseLabel: 'dummy-course', domain: 'dummy.invalid' }], maxOperations: body.limit ?? 2,
      ...(old?.phase === 'terminal' ? { attemptedAssignmentIds: old.attemptedAssignmentIds } : {}),
    });
    const before = await this.journal.inspect();
    const handle = await this.journal.admit({ ...binding, expectedGeneration: before.generation, triggerId: compactTriggerId(before.generation), plan: plan.operations.map(({ kind, targetId, requestDigest }) => ({ kind, targetId, requestDigest })) });
    const provider = this.readProvider();
    const source = JSON.parse((this.db.prepare('SELECT document FROM synthetic_canonical_cycle_v1 WHERE slot=1').get() as { document: string }).document);
    const cycle = { cycleId: source.cycleId, revision: source.revision, runId: source.runId };
    const storage: DurableSqlStorage = { sql: this.state.storage.sql, sync: async () => { await this.state.storage.sync(); if (body.mode === 'sync-failure' && this.store.pendingProjectionsForCourse(COURSE).length < 2) throw Error('Dummy durability confirmation failure'); }, transactionSync: callback => this.state.storage.transactionSync(() => {
      const result = callback();
      if (body.mode === 'rollback' && this.store.pendingProjectionsForCourse(COURSE).length < 2) throw Error('Dummy acknowledgment transaction rollback');
      return result;
    }) };
    let mutated = false;
    const fetchPort = providerFetch(provider, () => this.saveProvider(provider), body.mode ?? 'success', () => {
      if (body.mode === 'same-revision' && !mutated) {
        mutated = true;
        this.store.upsertAssignment(assignment(IDS[0]!), { forceProjection: true });
      }
    });
    if (body.mode === 'terminal-mutation') {
      const finish = this.journal.finish.bind(this.journal);
      this.journal.finish = async handle => { const terminal = await finish(handle); this.store.upsertAssignment({ ...assignment(IDS[0]!), sub_score: 9 }); await this.state.storage.sync(); return terminal; };
    }
    const runner = new SyntheticCanonicalProjector(storage, { now: () => '2026-11-04T01:00:00.000Z', randomUUID: () => crypto.randomUUID() });
    const result = await runner.run({ plan, handle, cycle, journal: this.journal, auth: await this.auth(), authGeneration: 0,
      ...(old?.terminal ? { previousTerminal: old.terminal } : {}), nowMs: () => Date.now(), minValidityMs: body.mode === 'validity' ? 1000 : 15000,
      operationTimeoutMs: 10000, batchTimeoutMs: body.mode === 'deadline' ? 30 : 10000, timeoutMs: body.mode === 'unsettled' ? 30 : 1000, requestBudget: body.mode === 'budget' ? 15 : 50, maxResponseBytes: 65536, fetch: fetchPort,
      verifyContext: (c, p) => JSON.stringify(c) === JSON.stringify(cycle) && p.observedCourses.length === 1 && p.observedCourses[0]?.courseId === COURSE && Object.entries(destinations).every(([key, value]) => p.destinations[key as keyof typeof destinations] === value),
      verifyResult: async (operation, projected) => {
        if (body.mode === 'deadline') await new Promise(resolve => setTimeout(resolve, 50));
        const page = provider.pages[projected.pageId];
        if (!page || projected.pageId !== `SYNTHETIC_page_${operation.assignmentId}` || !page.properties.Hidden.checkbox || !page.properties['In Progress'].checkbox) return false;
        const contents = page.blocks.map((b: any) => (b[b.type]?.rich_text ?? []).map((t: any) => t.text?.content ?? '').join(''));
        if (!contents.includes('USER NOTE') || !contents.includes('HISTORICAL ACTIVITY') || !contents.includes('USER PREFACE')) return false;
        if (!projected.pushed) return page.properties['Do Not Sync'].checkbox === true;
        return page.properties.AssignmentID.number === operation.assignmentId && page.properties.Score.number === operation.row.sub_score && contents.some((v: string) => v.includes(`revision=${operation.revision}`));
      },
    });
    return Response.json(result);
  }
}
export default { fetch(request: Request, env: { PROJECT: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }) { return env.PROJECT.get(env.PROJECT.idFromName(new URL(request.url).pathname)).fetch(request); } };
