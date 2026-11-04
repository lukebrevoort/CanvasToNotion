/** Local composed dummy fixture only. No deployment, actual provider or secrets. */
import { SingleWriterJournal } from "../../src/cloudflare/journal.js";
import { DurableSqlJournalStorage, type DurableSqlStorage } from "../../src/cloudflare/sqlite-storage.js";
import { DurableSyntheticMirrorStore } from "../../src/cloudflare/mirror-storage.js";
import { createMirrorState, observeAssignment, acknowledgeRevision, type RevisionToken } from "../../src/cloudflare/mirror-state.js";
import { SyntheticAuthStateAdapter, AuthStateError, createSyntheticAesGcmCipher, type SyntheticAuthStateRecord } from "../../src/cloudflare/auth-state.js";
import { SyntheticCoordinator, type ReadinessReference, type CoordinatorReceipt } from "../../src/cloudflare/coordinator.js";
import { SyntheticJsonTransport } from "../../src/cloudflare/transport.js";
import { SyntheticSqlPort } from "./synthetic-sql-port.js";
const binding = { accountId: "SYNTHETIC_account", sourceId: "SYNTHETIC_canvas", destinationId: "SYNTHETIC_notion" };
const assignment = { canvas_id: 990000020, course_id: 990000001, name: "Dummy assignment", sub_score: 1 };
const frozenAssignment = { ...assignment, canvas_id: 990000021, name: "Dummy frozen assignment" };
const fixture = { schemaVersion: 1, scope: "synthetic-only", importId: "dummy-pipeline", binding,
  courses: [{ canvas_id: 990000001, name: "Dummy course" }], assignments: [assignment, frozenAssignment], snapshots: [], watermark: null,
  notionState: { assignmentsDbId: "dummy-db", assignmentsDsId: "SYNTHETIC_notion", coursesDbId: "dummy-course-db", coursesDsId: "dummy-course-ds" },
  protectedPages: [assignment, frozenAssignment].map((a, i) => ({ assignmentId: a.canvas_id, pageId: `dummy-page-${i}`, hidden: true, inProgress: true, doNotSync: i === 1, notes: [{ text: "Dummy note sentinel", opaque: [null, true] }], activity: [{ text: "Dummy Activity sentinel", icon: null }] })), pendingProjections: [], unresolvedRuns: [] };
const projectionRequest = { url: "https://notion.invalid/dummy-page-0", method: "PATCH" as const, json: { assignmentId: assignment.canvas_id, score: 2, revision: 1 } };
const clockBase = 1800000000000;
const refreshRequest = { action: "dummy-refresh", expectedGeneration: 0 };
const token = (p: RevisionToken): RevisionToken => ({ importId: p.importId, assignmentId: p.assignmentId, revision: p.revision });
const hash = async (v: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(v)))), n => n.toString(16).padStart(2, "0")).join("");
function expectedMirror(stage: number) {
  const initial = createMirrorState(fixture);
  if (stage < 2) return initial;
  const changed = observeAssignment(initial, { ...assignment, sub_score: 2 });
  return acknowledgeRevision(changed.state, token(changed.pending!)).state;
}
const componentReceipt = (stage: number): CoordinatorReceipt => ({ receiptId: `SYNTHETIC_pipeline_ready_${stage}`, componentReceiptIds: stage === 0 ? ["SYNTHETIC_mirror_initial", "SYNTHETIC_auth_0"] : stage === 1 ? ["SYNTHETIC_refresh_run", "SYNTHETIC_auth_1", "SYNTHETIC_mirror_initial"] : ["SYNTHETIC_project_run", "SYNTHETIC_auth_1", "SYNTHETIC_mirror_revision_1"] });
export class SyntheticPipelineObject {
  private journal: SingleWriterJournal;
  private mirror: DurableSyntheticMirrorStore;
  private authPromise?: Promise<SyntheticAuthStateAdapter>;
  private gate: SyntheticCoordinator;
  constructor(private readonly state: { storage: DurableSqlStorage }) {
    this.journal = new SingleWriterJournal(new DurableSqlJournalStorage(state.storage));
    this.mirror = new DurableSyntheticMirrorStore(state.storage);
    this.gate = new SyntheticCoordinator(state.storage, binding, (r, receipt) => this.verify(r, receipt));
  }
  private auth() {
    return this.authPromise ??= (async () => {
      // Public deterministic test key, not secret material or real credentials.
      const key = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(11), "AES-GCM", false, ["encrypt", "decrypt"]);
      return new SyntheticAuthStateAdapter({ scope: { ...binding, syntheticOnly: true }, storage: new SyntheticSqlPort<SyntheticAuthStateRecord>(this.state.storage), cipher: createSyntheticAesGcmCipher(key) });
    })();
  }
  private async reference(stage: number): Promise<ReadinessReference> {
    return { artifactId: "SYNTHETIC_pipeline", artifactDigest: await hash(fixture), cursorId: `SYNTHETIC_pipeline_stage_${stage}`, journalGeneration: stage };
  }
  private effects(): number {
    if (!this.state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='synthetic_pipeline_effects'").toArray().length) return 0;
    return this.state.storage.sql.exec<{ count: number }>("SELECT count FROM synthetic_pipeline_effects WHERE slot=1").toArray()[0]?.count ?? 0;
  }
  private async verify(reference: ReadinessReference, receipt: CoordinatorReceipt): Promise<boolean> {
    const stage = reference.journalGeneration;
    if (![0, 1, 2].includes(stage) || JSON.stringify(reference) !== JSON.stringify(await this.reference(stage)) || JSON.stringify(receipt) !== JSON.stringify(componentReceipt(stage))) return false;
    const mirror = await this.mirror.inspect(); const auth = await (await this.auth()).inspect(); const journal = await this.journal.inspect();
    if (JSON.stringify(mirror) !== JSON.stringify(expectedMirror(stage)) || auth.generation !== (stage === 0 ? 0 : 1) || auth.status !== "ready" || auth.locallyQuarantined || journal.activeRunId !== null || journal.generation !== stage || JSON.stringify(journal.binding) !== JSON.stringify(binding) || journal.runs.length !== stage || this.effects() !== (stage === 2 ? 1 : 0)) return false;
    const operations = [
      { operationId: "SYNTHETIC_refresh", kind: "refresh", targetId: binding.accountId, requestDigest: await hash(refreshRequest), outcome: "succeeded", acknowledged: true, receipt: { receiptId: "dummy-auth-generation-1" } },
      { operationId: "SYNTHETIC_projection", kind: "write", targetId: "dummy-page-0", requestDigest: await hash(projectionRequest), outcome: "succeeded", acknowledged: true, receipt: { receiptId: "SYNTHETIC_effect_1" } },
    ];
    for (let i = 0; i < stage; i++) {
      const expected = { runId: i === 0 ? "SYNTHETIC_refresh_run" : "SYNTHETIC_project_run", generation: i, status: "succeeded", operations: [operations[i]], completedGeneration: i + 1 };
      if (JSON.stringify(journal.runs[i]) !== JSON.stringify(expected)) return false;
    }
    return true;
  }
  async fetch(request: Request): Promise<Response> {
    const input = await request.json() as { action: string; reference?: ReadinessReference; loseEffect?: boolean };
    try {
      if (input.action === "import") {
        // Gate bootstrap is the only out-of-callback write. All component writes
        // (including journal initialization) happen inside admitted import.
        await this.gate.initialize();
        return Response.json(await this.gate.importArtifact({ operationId: "SYNTHETIC_import", reference: await this.reference(0) }, async () => {
          await this.journal.initialize(binding); await this.mirror.initialize(fixture);
          await (await this.auth()).initialize({ accessToken: "dummy-access-0", refreshToken: "dummy-refresh-0", expiresAt: clockBase + 10000 });
          return componentReceipt(0);
        }));
      }
      if (input.action === "refresh") {
        return Response.json(await this.gate.run({ operationId: "SYNTHETIC_refresh_gate", expected: input.reference!, next: await this.reference(1) }, async () => {
          const handle = await this.journal.admit({ ...binding, runId: "SYNTHETIC_refresh_run", expectedGeneration: 0 });
          // A known expired token is refused before intent, but does not poison
          // this admitted run: the same handle can explicitly refresh it.
          let expiryRefused = false;
          try { await (await this.auth()).withAccessToken({ expectedGeneration: 0, journal: this.journal, handle,
            nowMs: () => clockBase + 20000, minValidityMs: 5000,
            intent: { operationId: "SYNTHETIC_expired_probe", kind: "write", targetId: "dummy-page-0", requestDigest: await hash(projectionRequest) },
            use: async () => { throw Error("Expired token must never dispatch"); },
          }); } catch (error) { if (error instanceof AuthStateError && error.code === "expired") expiryRefused = true; else throw error; }
          const admitted = await this.journal.inspect();
          if (!expiryRefused || admitted.runs[0]?.status !== "admitted" || admitted.runs[0].operations.length !== 0 || this.effects() !== 0) throw Error("Expiry changed durable intent");
          await (await this.auth()).refresh({ expectedGeneration: 0, journal: this.journal, handle, operationId: "SYNTHETIC_refresh", requestDigest: await hash(refreshRequest), exchange: async old => {
            if (old.accessToken !== "dummy-access-0" || old.refreshToken !== "dummy-refresh-0") throw Error("Dummy fixture mismatch");
            return { accessToken: "dummy-access-1", expiresAt: clockBase + 60000 };
          } });
          await this.journal.finish(handle); return componentReceipt(1);
        }));
      }
      if (input.action === "project") {
        return Response.json(await this.gate.run({ operationId: "SYNTHETIC_project_gate", expected: input.reference!, next: await this.reference(2) }, async () => {
          const handle = await this.journal.admit({ ...binding, runId: "SYNTHETIC_project_run", expectedGeneration: 1 });
          const changed = await this.mirror.observeAssignment({ ...assignment, sub_score: 2 });
          const frozen = await this.mirror.observeAssignment({ ...frozenAssignment, sub_score: 99 });
          if (!changed.pending || frozen.status !== "frozen") throw Error("Dummy transition mismatch");
          const receipt = await (await this.auth()).withAccessToken({ expectedGeneration: 1, journal: this.journal, handle, nowMs: () => clockBase + 30000, minValidityMs: 5000,
            intent: { operationId: "SYNTHETIC_projection", kind: "write", targetId: "dummy-page-0", requestDigest: await hash(projectionRequest) },
            use: async accessToken => {
              if (accessToken !== "dummy-access-1") throw Error("Dummy access mismatch");
              const transport = new SyntheticJsonTransport({ syntheticOnly: true, origin: "https://notion.invalid", requestBudget: 1, fetch: async () => {
                this.state.storage.transactionSync(() => {
                  this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS synthetic_pipeline_effects(slot INTEGER PRIMARY KEY CHECK(slot=1),count INTEGER NOT NULL)");
                  this.state.storage.sql.exec("INSERT INTO synthetic_pipeline_effects VALUES(1,1) ON CONFLICT(slot) DO UPDATE SET count=count+1");
                }); await this.state.storage.sync();
                if (input.loseEffect) throw Error("Synthetic effect response lost");
                return Response.json({ receiptId: "SYNTHETIC_effect_1" });
              } });
              const result = await transport.request(projectionRequest) as { receiptId: string };
              if (result.receiptId !== "SYNTHETIC_effect_1") throw Error("Dummy receipt mismatch");
              return { receiptId: result.receiptId };
            } });
          if (receipt.receiptId !== "SYNTHETIC_effect_1") throw Error("Dummy receipt mismatch");
          if ((await this.mirror.acknowledgeRevision(token(changed.pending))).status !== "acknowledged") throw Error("Dummy acknowledgment mismatch");
          await this.journal.finish(handle); return componentReceipt(2);
        }));
      }
      if (input.action === "inspect") {
        const authRow = this.state.storage.sql.exec<{ document: string }>("SELECT document FROM synthetic_auth_state WHERE slot=1").toArray()[0]!.document;
        return Response.json({ gate: await this.gate.inspect(), journal: await this.journal.inspect(), mirror: await this.mirror.inspect(), auth: await (await this.auth()).inspect(), effects: this.effects(), plaintextAbsent: !["dummy-access-0", "dummy-access-1", "dummy-refresh-0"].some(v => authRow.includes(v)) });
      }
      return new Response("Unknown fixture action", { status: 400 });
    } catch { return Response.json({ code: "synthetic_pipeline_refused" }, { status: 409 }); }
  }
}
export default {
  fetch(request: Request, env: { PIPELINE: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }) {
    const name = new URL(request.url).pathname.slice(1);
    if (!/^SYNTHETIC_[a-z_]+$/.test(name)) return new Response("Fixture only", { status: 400 });
    return env.PIPELINE.get(env.PIPELINE.idFromName(name)).fetch(request);
  },
};
