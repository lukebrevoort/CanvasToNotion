/** Bounded, dummy-only canonical SOURCE observation cycle. Not a scheduler or
 * projection coordinator: completion deliberately leaves sync_runs running.
 * Existing Canvas wire filters are retained, not claimed to be server-supported.
 * One cycle only: 200 courses, 500 groups/course, 1000 observations, one staged
 * page (100 items), 1 MiB checkpoint. Prior pending backlog is not bounded by the
 * observation count; the projection planner must independently cap/check it.
 */
import { createStore, type StoreDependencies } from '../store/core.js';
import type { CanvasAssignment, CanvasCourse, CanvasAssignmentGroup, CanvasSubmission } from '../canvas/types.js';
import { toAssignmentInput } from '../sync/assignment-input.js';
import { createDurableSqlDatabase } from './canonical-sql.js';
import type { DurableSqlStorage } from './sqlite-storage.js';
import { createCanvasPageState, readCanvasPage, validateCanvasPageState, type CanvasPageState } from './canvas-pages.js';
import { SyntheticJsonTransport, SyntheticTransportError } from './transport.js';

const TABLE = 'synthetic_canonical_cycle_v1';
const MAX_BYTES = 1_048_576;
type Assignment = CanvasAssignment & { submission?: CanvasSubmission | null };
type Phase = 'me' | 'courses' | 'groups' | 'assignments' | 'observations' | 'submission' | 'source_complete';
export interface CanonicalCycleState {
  schemaVersion: 1; syntheticOnly: true; cycleId: string; revision: number;
  status: 'ready' | 'reading' | 'source_complete'; phase: Phase;
  runId: number; startedAt: string; since: string | null; full: boolean;
  userId: number | null; courses: { id: number; timeZone: string | null }[]; courseIndex: number;
  groups: { id: number; name: string | null; weight: number | null }[];
  page: CanvasPageState | null;
  staged: { items: Assignment[]; index: number; after: CanvasPageState } | null;
  coursesSeen: number; assignmentsSeen: number; fallbackUnavailable: number;
}
export interface CycleReference { cycleId: string; revision: number }
export class CanonicalCycleError extends Error {
  constructor(readonly code: 'invalid' | 'exists' | 'stale' | 'blocked' | 'capacity' | 'uncertain' | 'response' | 'read') {
    super(`Synthetic canonical cycle: ${code}`); this.name = 'CanonicalCycleError';
  }
}
function fail(code: CanonicalCycleError['code']): never { throw new CanonicalCycleError(code); }
function dummySource(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) dummySource(item); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if ((key === 'id' || key.endsWith('_id')) && item != null && (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 990000000 || item > 990999999)) fail('response');
    if (item && typeof item === 'object') dummySource(item);
  }
}
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const phaseList: Phase[] = ['me', 'courses', 'groups', 'assignments', 'observations', 'submission', 'source_complete'];
function checked(state: CanonicalCycleState): CanonicalCycleState {
  if (state.schemaVersion !== 1 || state.syntheticOnly !== true || !/^SYNTHETIC_[A-Za-z0-9_-]{1,100}$/.test(state.cycleId) ||
      !Number.isSafeInteger(state.revision) || state.revision < 0 || !positive(state.runId) ||
      !phaseList.includes(state.phase) || !['ready', 'reading', 'source_complete'].includes(state.status) ||
      typeof state.full !== 'boolean' || !Number.isFinite(Date.parse(state.startedAt)) || state.since !== null && !Number.isFinite(Date.parse(state.since)) ||
      !Array.isArray(state.courses) || state.courses.length > 200 || !Array.isArray(state.groups) || state.groups.length > 500 ||
      !Number.isSafeInteger(state.courseIndex) || state.courseIndex < 0 || state.courseIndex > state.courses.length ||
      state.userId !== null && !positive(state.userId) ||
      state.courses.some(c => !positive(c.id) || c.timeZone !== null && typeof c.timeZone !== 'string') ||
      new Set(state.courses.map(c => c.id)).size !== state.courses.length ||
      state.groups.some(g => !positive(g.id) || g.name !== null && typeof g.name !== 'string' || g.weight !== null && !Number.isFinite(g.weight)) ||
      [state.coursesSeen, state.assignmentsSeen, state.fallbackUnavailable].some(n => !Number.isSafeInteger(n) || n < 0) || state.assignmentsSeen > 1000 ||
      (state.phase === 'source_complete') !== (state.status === 'source_complete')) fail('invalid');
  if (state.coursesSeen !== state.courses.length || state.fallbackUnavailable > state.assignmentsSeen ||
      state.phase !== 'me' && state.userId === null) fail('invalid');
  dummySource(state.courses); dummySource(state.groups);
  if (state.userId !== null) dummySource({ id: state.userId });
  if (state.page) validateCanvasPageState(state.page);
  if (state.phase === 'me') {
    if (state.userId !== null || state.page !== null || state.courses.length || state.groups.length || state.courseIndex !== 0 || state.assignmentsSeen !== 0) fail('invalid');
  } else if (state.phase === 'source_complete') {
    if (state.courseIndex !== state.courses.length || state.page !== null || state.staged !== null || state.groups.length) fail('invalid');
  } else if (state.phase === 'courses') {
    if (state.courseIndex !== 0 || state.groups.length || state.page?.endpoint.kind !== 'courses' || state.page.endpoint.enrollmentState !== 'active') fail('invalid');
  } else {
    const course = state.courses[state.courseIndex];
    const endpoint = state.page?.endpoint;
    if (!course || !endpoint || endpoint.kind === 'courses' || endpoint.courseId !== course.id) fail('invalid');
    if ((state.phase === 'groups') !== (endpoint.kind === 'assignmentGroups')) fail('invalid');
    if (endpoint.kind === 'assignments' && (endpoint.updatedSince ?? null) !== state.since) fail('invalid');
  }
  if (state.staged) {
    if (!Array.isArray(state.staged.items) || state.staged.items.length > 100 || !Number.isSafeInteger(state.staged.index) || state.staged.index < 0 || state.staged.index >= state.staged.items.length) fail('invalid');
    const before = state.page, after = validateCanvasPageState(state.staged.after);
    if (!before || after.initialUrl !== before.initialUrl || after.pagesRead !== before.pagesRead + 1 ||
        after.itemsRead !== before.itemsRead + state.staged.items.length ||
        JSON.stringify(after.seenItemIds.slice(0, before.itemsRead)) !== JSON.stringify(before.seenItemIds) ||
        JSON.stringify(after.seenCursors.slice(0, before.pagesRead)) !== JSON.stringify(before.seenCursors) ||
        after.seenCursors.at(-1) !== before.nextUrl ||
        JSON.stringify(after.seenItemIds.slice(before.itemsRead)) !== JSON.stringify(state.staged.items.map(a => a.id)) ||
        state.staged.items.some(a => a.course_id !== state.courses[state.courseIndex]?.id)) fail('invalid');
    dummySource(state.staged.items);
  }
  if (['observations', 'submission'].includes(state.phase) !== Boolean(state.staged)) fail('invalid');
  if (state.status === 'reading' && ['observations', 'source_complete'].includes(state.phase)) fail('invalid');
  return state;
}
function encoded(state: CanonicalCycleState): string {
  checked(state);
  const value = JSON.stringify(state);
  if (new TextEncoder().encode(value).byteLength > MAX_BYTES) fail('capacity');
  return value;
}

export class SyntheticCanonicalCycle {
  private readonly db;
  private storeValue?: ReturnType<typeof createStore>;
  private failed = false;
  private tail: Promise<void> = Promise.resolve();
  private lastTransport?: SyntheticJsonTransport;
  constructor(private readonly storage: DurableSqlStorage, private readonly dependencies: StoreDependencies) {
    this.db = createDurableSqlDatabase(storage);
  }
  private store() { return this.storeValue ??= createStore(this.db, this.dependencies); }
  private read(): CanonicalCycleState | undefined {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(TABLE)) return undefined;
    const row = this.db.prepare(`SELECT document FROM ${TABLE} WHERE slot=1`).get() as { document: string } | undefined;
    if (!row) return undefined;
    const state = checked(JSON.parse(row.document));
    const run = this.db.prepare('SELECT status, started_at FROM sync_runs WHERE id=?').get(state.runId) as { status: string; started_at: string } | undefined;
    if (!run || run.status !== 'running' || run.started_at !== state.startedAt) fail('invalid');
    return state;
  }
  private put(state: CanonicalCycleState) { this.db.prepare(`INSERT INTO ${TABLE} VALUES(1,?) ON CONFLICT(slot) DO UPDATE SET document=excluded.document`).run(encoded(state)); }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn); this.tail = result.then(() => undefined, () => undefined); return result;
  }
  private async commit<T>(fn: () => T): Promise<T> {
    if (this.failed) fail('uncertain');
    let result: T;
    try { result = this.storage.transactionSync(fn); }
    catch (e) { if (e instanceof CanonicalCycleError) throw e; this.failed = true; throw new CanonicalCycleError('uncertain'); }
    try { await this.storage.sync(); } catch { this.failed = true; fail('uncertain'); }
    return result;
  }
  private current(expected: CycleReference): CanonicalCycleState {
    const state = this.read();
    if (!state || state.cycleId !== expected.cycleId || state.revision !== expected.revision) fail('stale');
    return state;
  }
  initialize(options: { syntheticOnly: true; cycleId: string; full?: boolean }): Promise<CanonicalCycleState> {
    if (options.syntheticOnly !== true || !/^SYNTHETIC_[A-Za-z0-9_-]{1,100}$/.test(options.cycleId) || options.full !== undefined && typeof options.full !== 'boolean') return Promise.reject(new CanonicalCycleError('invalid'));
    return this.enqueue(() => this.commit(() => {
      if (this.read()) fail('exists');
      this.db.pragma('foreign_keys = ON');
      const store = this.store();
      const since = options.full ? null : store.lastSuccessfulSyncStart()?.toISOString() ?? null;
      const runId = store.startSyncRun();
      const { started_at: startedAt } = this.db.prepare('SELECT started_at FROM sync_runs WHERE id=?').get(runId) as { started_at: string };
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE}(slot INTEGER PRIMARY KEY CHECK(slot=1), document TEXT NOT NULL)`);
      const state: CanonicalCycleState = { schemaVersion: 1, syntheticOnly: true, cycleId: options.cycleId, revision: 0, status: 'ready', phase: 'me', runId, startedAt, since, full: options.full ?? false, userId: null, courses: [], courseIndex: 0, groups: [], page: null, staged: null, coursesSeen: 0, assignmentsSeen: 0, fallbackUnavailable: 0 };
      this.put(state); return structuredClone(state);
    }));
  }
  inspect(): Promise<CanonicalCycleState | undefined> { return this.enqueue(async () => this.storage.transactionSync(() => this.read())); }
  private page(endpoint: Parameters<typeof createCanvasPageState>[0]['endpoint']) {
    return createCanvasPageState({ syntheticOnly: true, endpoint, maxPages: 50, maxItems: 5000 });
  }
  private beginCourse(state: CanonicalCycleState) {
    state.groups = []; state.staged = null;
    const course = state.courses[state.courseIndex];
    if (!course) { state.phase = 'source_complete'; state.status = 'source_complete'; state.page = null; return; }
    state.phase = 'groups'; state.page = this.page({ kind: 'assignmentGroups', courseId: course.id });
  }
  private afterAssignments(state: CanonicalCycleState) {
    if (state.page!.nextUrl !== null) { state.phase = 'assignments'; return; }
    state.courseIndex++; this.beginCourse(state);
  }
  private observe(state: CanonicalCycleState, submission: CanvasSubmission | null) {
    const staged = state.staged!, assignment = staged.items[staged.index]!, course = state.courses[state.courseIndex]!;
    this.store().upsertAssignment(toAssignmentInput(assignment, submission, new Map(state.groups.map(g => [g.id, { name: g.name, weight: g.weight }])), course.timeZone), { forceProjection: state.full });
    state.assignmentsSeen++; staged.index++;
    if (staged.index < staged.items.length) { state.phase = 'observations'; return; }
    state.page = staged.after; state.staged = null; this.afterAssignments(state);
  }
  /** One read OR one canonical observation; never automatically repeats a GET. */
  step(expected: CycleReference, transport?: SyntheticJsonTransport): Promise<CanonicalCycleState> {
    return this.enqueue(() => this.advance(expected, transport, false));
  }
  /** Explicit GET-only recovery capability. It cannot reset projection/refresh
   * journals or durability uncertainty. New revision fences any old response.
   * Live unsettled transport must settle first; after actual DO restart only the
   * persisted read intent survives and it is safe to re-read the source. */
  retryRead(expected: CycleReference, transport: SyntheticJsonTransport): Promise<CanonicalCycleState> {
    return this.enqueue(() => this.advance(expected, transport, true));
  }
  private async advance(expected: CycleReference, transport: SyntheticJsonTransport | undefined, retry: boolean): Promise<CanonicalCycleState> {
    if (this.failed) fail('uncertain');
    if (this.lastTransport && this.lastTransport.state().active !== 0) fail('blocked');
    const before = this.current(expected);
    if (before.status !== (retry ? 'reading' : 'ready')) fail('blocked');
    if (before.phase === 'observations') {
      if (retry) fail('blocked');
      return this.commit(() => {
        const state = this.current(expected), assignment = state.staged!.items[state.staged!.index]!;
        if (assignment.submission && assignment.submission.assignment_id != null) this.observe(state, assignment.submission);
        else state.phase = 'submission';
        state.revision++; this.put(state); return structuredClone(state);
      });
    }
    if (!(transport instanceof SyntheticJsonTransport) || transport.state().active || transport.state().uncertain) fail('invalid');
    const admitted = await this.commit(() => {
      const state = this.current(expected); state.status = 'reading'; state.revision++;
      this.put(state); return structuredClone(state);
    });
    this.lastTransport = transport;
    let result: Awaited<ReturnType<typeof readCanvasPage>> | { userId: number } | { submission: CanvasSubmission | null; unavailable: boolean };
    try {
      if (admitted.phase === 'me') {
        const response = await transport.request({ url: 'https://canvas.invalid/api/v1/users/self', method: 'GET' }) as { id?: unknown };
        dummySource(response);
        if (!response || !positive(response.id)) fail('response');
        result = { userId: response.id };
      } else if (admitted.phase === 'submission') {
        const a = admitted.staged!.items[admitted.staged!.index]!;
        try {
          const response = await transport.request({ url: `https://canvas.invalid/api/v1/courses/${a.course_id}/assignments/${a.id}/submissions/${admitted.userId}?include=visibility`, method: 'GET' });
          dummySource(response);
          // Reuse assignment-page normalization to reject mismatched/invalid submissions.
          const validationPage = this.page({ kind: 'assignments', courseId: a.course_id });
          const checked = await readCanvasPage(validationPage, { requestDetailed: async () => ({ json: [{ ...a, submission: response }], link: null }) });
          result = { submission: (checked.items[0] as Assignment).submission ?? null, unavailable: false };
        } catch (e) {
          // The Node client ultimately treats a failed fallback as no submission.
          // Only settled known HTTP failure gets that behavior; timeout/unknown
          // read outcome stays admitted for explicit retry instead of erasing data.
          if (!(e instanceof SyntheticTransportError) || e.code !== 'response' || !e.status || e.status < 400 || transport.state().active !== 0) throw e;
          result = { submission: null, unavailable: true };
        }
      } else result = await readCanvasPage(admitted.page!, { requestDetailed: async request => { const response = await transport.requestDetailed(request); dummySource(response.json); return response; } });
    } catch { throw new CanonicalCycleError('read'); }
    return this.commit(() => {
      const state = this.current(admitted); state.status = 'ready';
      if ('userId' in result) { state.userId = result.userId; state.phase = 'courses'; state.page = this.page({ kind: 'courses', enrollmentState: 'active' }); }
      else if ('submission' in result) { if (result.unavailable) state.fallbackUnavailable++; this.observe(state, result.submission); }
      else if (state.phase === 'courses') {
        if (state.courses.length + result.items.length > 200) fail('capacity');
        for (const course of result.items as CanvasCourse[]) { this.store().upsertCourse(course); state.courses.push({ id: course.id, timeZone: course.time_zone ?? null }); state.coursesSeen++; }
        state.page = result.state; if (result.done) this.beginCourse(state);
      } else if (state.phase === 'groups') {
        if (state.groups.length + result.items.length > 500) fail('capacity');
        for (const g of result.items as CanvasAssignmentGroup[]) state.groups.push({ id: g.id, name: g.name ?? null, weight: g.group_weight != null ? g.group_weight / 100 : null });
        state.page = result.state;
        if (result.done) { state.phase = 'assignments'; state.page = this.page({ kind: 'assignments', courseId: state.courses[state.courseIndex]!.id, ...(state.since ? { updatedSince: state.since } : {}) }); }
      } else {
        if (state.assignmentsSeen + result.items.length > 1000) fail('capacity');
        if (result.items.length) { state.staged = { items: result.items as Assignment[], index: 0, after: result.state }; state.phase = 'observations'; }
        else { state.page = result.state; this.afterAssignments(state); }
      }
      state.revision++; this.put(state); return structuredClone(state);
    });
  }
}
