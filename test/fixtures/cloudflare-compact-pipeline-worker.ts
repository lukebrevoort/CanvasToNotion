/** Fresh V2 local-only composition. Public dummy credentials; no external providers. */
import { CompactSyntheticJournal, compactTriggerId, compactPlanDigest, type CompactOperation } from "../../src/cloudflare/compact-journal.js";
import { DurableSqlCompactStorage } from "../../src/cloudflare/compact-sqlite-storage.js";
import { CompactSyntheticCoordinator, type CompactReady, type CompactReadinessReference } from "../../src/cloudflare/compact-coordinator.js";
import { createCompactAuthJournal } from "../../src/cloudflare/compact-auth.js";
import type { DurableSqlStorage } from "../../src/cloudflare/sqlite-storage.js";
import { DurableSyntheticMirrorStore } from "../../src/cloudflare/mirror-storage.js";
import { createMirrorState, observeAssignment, acknowledgeRevision, type RevisionToken } from "../../src/cloudflare/mirror-state.js";
import { SyntheticAuthStateAdapter, createSyntheticAesGcmCipher, type SyntheticAuthStateRecord } from "../../src/cloudflare/auth-state.js";
import { SyntheticSqlPort } from "./synthetic-sql-port.js";
const binding = { accountId: "SYNTHETIC_account", sourceId: "SYNTHETIC_canvas", destinationId: "SYNTHETIC_notion" };
const assignment = { canvas_id: 990000020, course_id: 990000001, name: "Dummy assignment", sub_score: 1 };
const frozenAssignment = { ...assignment, canvas_id: 990000021, name: "Dummy frozen assignment" };
const fixture = { schemaVersion: 1, scope: "synthetic-only", importId: "dummy-pipeline", binding,
  courses: [{ canvas_id: 990000001, name: "Dummy course" }], assignments: [assignment, frozenAssignment], snapshots: [], watermark: null,
  notionState: { assignmentsDbId: "dummy-db", assignmentsDsId: "SYNTHETIC_notion", coursesDbId: "dummy-course-db", coursesDsId: "dummy-course-ds" },
  protectedPages: [assignment, frozenAssignment].map((a, i) => ({ assignmentId: a.canvas_id, pageId: `dummy-page-${i}`, hidden: true, inProgress: true, doNotSync: i === 1, notes: [{ text: "Dummy note sentinel", opaque: [null, true] }], activity: [{ text: "Dummy Activity sentinel", icon: null }] })), pendingProjections: [], unresolvedRuns: [] };

const hash = async (v: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(v)))), n => n.toString(16).padStart(2, "0")).join("");
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const token = (p: RevisionToken): RevisionToken => ({ importId: p.importId, assignmentId: p.assignmentId, revision: p.revision });
const clockBase = 1800000000000;
const refreshRequest = { action: "dummy-refresh", expectedGeneration: 0 };
const cursorId = (generation: number) => `SYNTHETIC_cursor_${generation}`;
const receiptId = (generation: number) => `SYNTHETIC_ready_${generation}`;
function expectedMirror(generation: number) {
  const initial = createMirrorState(fixture);
  if (generation < 2) return initial;
  const changed = observeAssignment(initial, { ...assignment, sub_score: 2 });
  return acknowledgeRevision(changed.state, token(changed.pending!)).state;
}
function projection() {
  const changed = observeAssignment(createMirrorState(fixture), { ...assignment, sub_score: 2 }).pending!;
  return { revision: token(changed), assignment: changed.assignment, targetId: "SYNTHETIC_page_0" };
}
export class SyntheticCompactPipelineObject {
  private journal: CompactSyntheticJournal;
  private mirror: DurableSyntheticMirrorStore;
  private gate: CompactSyntheticCoordinator;
  private authPromise?: Promise<SyntheticAuthStateAdapter>;
  private failAck = false;
  constructor(private readonly state: { storage: DurableSqlStorage }) {
    this.journal = new CompactSyntheticJournal(new DurableSqlCompactStorage(state.storage));
    this.mirror = new DurableSyntheticMirrorStore({ sql: state.storage.sql, sync: () => state.storage.sync(),
      transactionSync: callback => state.storage.transactionSync(() => {
        const result = callback();
        if (this.failAck) { this.failAck = false; throw Error("Injected mirror acknowledgment transaction rollback"); }
        return result;
      }) });
    this.gate = new CompactSyntheticCoordinator(state.storage, binding, ready => this.verify(ready));
  }
  private auth() {
    return this.authPromise ??= (async () => {
      const key = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(11), "AES-GCM", false, ["encrypt", "decrypt"]);
      return new SyntheticAuthStateAdapter({ scope: { ...binding, syntheticOnly: true }, storage: new SyntheticSqlPort<SyntheticAuthStateRecord>(this.state.storage), cipher: createSyntheticAesGcmCipher(key) });
    })();
  }
  private readRow(name: string): any {
    if (!this.state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name=?", name).toArray().length) return null;
    const row = this.state.storage.sql.exec<{ document: string }>(`SELECT document FROM ${name} WHERE slot=1`).toArray()[0];
    return row ? JSON.parse(row.document) : null;
  }
  private async putRow(name: string, value: unknown) {
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${name}(slot INTEGER PRIMARY KEY CHECK(slot=1),document TEXT NOT NULL)`);
      this.state.storage.sql.exec(`INSERT INTO ${name} VALUES(1,?) ON CONFLICT(slot) DO UPDATE SET document=excluded.document`, JSON.stringify(value));
    }); await this.state.storage.sync();
  }
  private async plan(generation: number): Promise<CompactOperation[]> {
    return generation === 0 ? [{ kind: "refresh", targetId: binding.accountId, requestDigest: await hash(refreshRequest) }] : generation === 1 ? [{ kind: "write", targetId: "SYNTHETIC_page_0", requestDigest: await hash(projection()) }] : [];
  }
  private async verify(ready: CompactReady) {
    const g = ready.reference.journalGeneration;
    const journal = await this.journal.inspect(), mirror = await this.mirror.inspect(), auth = await (await this.auth()).inspect();
    const effect = this.readRow("synthetic_compact_effect"), cursor = this.readRow("synthetic_compact_cursor");
    if (ready.reference.artifactId !== "SYNTHETIC_compact_pipeline" || ready.reference.artifactDigest !== await hash(fixture) || ready.reference.cursorId !== cursorId(g) || ready.receiptId !== receiptId(g) ||
      journal.generation !== g || journal.active !== null || !equal(journal.binding, binding) || journal.rootDigest !== ready.reference.journalRootDigest || !equal(journal.latestTerminal, ready.terminal) ||
      !equal(mirror, expectedMirror(g)) || auth.generation !== (g === 0 ? 0 : 1) || auth.status !== "ready" || auth.locallyQuarantined ||
      !equal(cursor, { cursorId: cursorId(g), generation: g, projectionReceipt: g >= 2 ? "SYNTHETIC_effect_1" : null }) ||
      !equal(effect, g < 2 ? null : { count: 1, receiptId: "SYNTHETIC_effect_1", request: projection() })) return false;
    if (g === 0) return ready.terminal === null && journal.rootDigest === "0".repeat(64);
    const t = ready.terminal;
    const outcomes = g === 1 ? [{ status: "succeeded", receipt: { receiptId: "SYNTHETIC_auth_generation_1" } }] : g === 2 ? [{ status: "succeeded", receipt: { receiptId: "SYNTHETIC_effect_1" } }] : [];
    return !!t && t.generation === g - 1 && t.triggerId === compactTriggerId(g - 1) && t.planDigest === await compactPlanDigest(binding, g - 1, await this.plan(g - 1)) && t.receiptDigest === await hash(outcomes);
  }
  async fetch(request: Request): Promise<Response> {
    const input = await request.json() as { action: string; reference?: CompactReadinessReference; triggerId?: string; loseEffect?: boolean; failAck?: boolean };
    try {
      if (input.action === "import") {
        await this.gate.initialize();
        return Response.json(await this.gate.importArtifact({ artifactId: "SYNTHETIC_compact_pipeline", artifactDigest: await hash(fixture), cursorId: cursorId(0), journalGeneration: 0, journalRootDigest: "0".repeat(64) }, async () => {
          await this.journal.initialize(binding); await this.mirror.initialize(fixture);
          await (await this.auth()).initialize({ accessToken: "dummy-access-0", refreshToken: "dummy-refresh-0", expiresAt: clockBase + 10000 });
          await this.putRow("synthetic_compact_cursor", { cursorId: cursorId(0), generation: 0, projectionReceipt: null });
          return { receiptId: receiptId(0) };
        }));
      }
      if (["refresh", "project", "noop"].includes(input.action)) {
        const g = input.reference!.journalGeneration;
        if (input.action !== (g === 0 ? "refresh" : g === 1 ? "project" : "noop")) throw Error("Cannot relabel old work");
        const plan = await this.plan(g);
        return Response.json(await this.gate.run({ triggerId: input.triggerId!, expected: input.reference!, nextCursorId: cursorId(g + 1), plan }, async admission => {
          const handle = await this.journal.admit(admission);
          if (g < 2) {
            const intent = { operationId: g === 0 ? "SYNTHETIC_refresh" : "SYNTHETIC_projection", ...plan[0]! };
            const bridge = await createCompactAuthJournal({ journal: this.journal, handle, operations: [intent] });
            if (g === 0) {
              await (await this.auth()).refresh({ expectedGeneration: 0, ...bridge, operationId: intent.operationId, requestDigest: intent.requestDigest, exchange: async old => {
                if (old.accessToken !== "dummy-access-0" || old.refreshToken !== "dummy-refresh-0") throw Error("Dummy auth mismatch");
                return { accessToken: "dummy-access-1", expiresAt: clockBase + 60000 };
              } });
            } else {
              const changed = await this.mirror.observeAssignment({ ...assignment, sub_score: 2 });
              const frozen = await this.mirror.observeAssignment({ ...frozenAssignment, sub_score: 99 });
              if (!changed.pending || frozen.status !== "frozen") throw Error("Mirror mismatch");
              const derived = { revision: token(changed.pending), assignment: changed.pending.assignment, targetId: "SYNTHETIC_page_0" };
              if (await hash(derived) !== intent.requestDigest) throw Error("Revision request mismatch");
              const receipt = await (await this.auth()).withAccessToken({ expectedGeneration: 1, ...bridge, nowMs: () => clockBase + 30000, minValidityMs: 5000, intent,
                use: async access => {
                  if (access !== "dummy-access-1") throw Error("Dummy token mismatch");
                  const previous = this.readRow("synthetic_compact_effect");
                  await this.putRow("synthetic_compact_effect", { count: (previous?.count ?? 0) + 1, receiptId: "SYNTHETIC_effect_1", request: derived });
                  if (input.loseEffect) throw Error("Injected provider response loss");
                  return { receiptId: "SYNTHETIC_effect_1" };
                } });
              if (!equal(this.readRow("synthetic_compact_effect"), { count: 1, receiptId: receipt.receiptId, request: derived }) || receipt.receiptId !== "SYNTHETIC_effect_1") throw Error("Provider receipt mismatch");
              this.failAck = !!input.failAck;
              if ((await this.mirror.acknowledgeRevision(token(changed.pending))).status !== "acknowledged") throw Error("Revision ack mismatch");
            }
          } else {
            const observed = await this.mirror.observeAssignment({ ...assignment, sub_score: 2 });
            if (observed.pending || !equal(observed.state, expectedMirror(g))) throw Error("No-op changed mirror");
          }
          await this.putRow("synthetic_compact_cursor", { cursorId: cursorId(g + 1), generation: g + 1, projectionReceipt: g >= 1 ? "SYNTHETIC_effect_1" : null });
          // Actual durable mirror/cursor acknowledgement must precede finish.
          if (!equal(await this.mirror.inspect(), expectedMirror(g + 1)) || this.readRow("synthetic_compact_cursor").generation !== g + 1) throw Error("Missing durable acknowledgment");
          return { terminal: await this.journal.finish(handle), receiptId: receiptId(g + 1) };
        }));
      }
      // Fault injection is fixture-only: preserve journal hash while invalidating
      // the concrete fake-provider receipt. This is not a production repair API.
      if (input.action === "tamper-provider-receipt") {
        const effect = this.readRow("synthetic_compact_effect");
        await this.putRow("synthetic_compact_effect", { ...effect, receiptId: "SYNTHETIC_wrong_receipt" });
        return Response.json({ injected: true });
      }
      if (input.action === "inspect") {
        const gate = await this.gate.inspect();
        const tables = this.state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").toArray();
        const sizes = Object.fromEntries(tables.filter(t => t.name.startsWith("synthetic_")).map(t => [t.name, this.state.storage.sql.exec<{ bytes: number }>(`SELECT length(document) AS bytes FROM ${t.name} WHERE slot=1`).toArray()[0]?.bytes ?? 0]));
        const authRow = JSON.stringify(this.readRow("synthetic_auth_state"));
        return Response.json({ gate, journal: await this.journal.inspect(), mirror: await this.mirror.inspect(), auth: await (await this.auth()).inspect(), effect: this.readRow("synthetic_compact_effect"), cursor: this.readRow("synthetic_compact_cursor"), sizes, tables: tables.map(t => t.name), verified: gate.phase === "ready" && !!gate.ready && await this.verify(gate.ready), plaintextAbsent: !["dummy-access-0", "dummy-access-1", "dummy-refresh-0"].some(v => authRow.includes(v)) });
      }
      return new Response("Unknown fixture action", { status: 400 });
    } catch { return Response.json({ code: "synthetic_compact_pipeline_refused" }, { status: 409 }); }
  }
}
export default {
  fetch(request: Request, env: { COMPACT_PIPELINE: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }) {
    const name = new URL(request.url).pathname.slice(1);
    if (!/^SYNTHETIC_[a-z_]+$/.test(name)) return new Response("Fixture only", { status: 400 });
    return env.COMPACT_PIPELINE.get(env.COMPACT_PIPELINE.idFromName(name)).fetch(request);
  },
};
