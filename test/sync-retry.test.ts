import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../src/config.js";

// Import the store only after redirecting it to disposable, synthetic state.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-retry-test-"));
config.dbPath = path.join(temp, "test.sqlite");
config.statePath = path.join(temp, "state.json");
config.canvasDomain = "canvas.invalid";
config.notionToken = "test-notion-token";
process.env.CANVAS_TOKEN = "test-canvas-token";
fs.writeFileSync(config.statePath, JSON.stringify({
  assignmentsDbId: "assignments-db", assignmentsDsId: "assignments-ds",
  coursesDbId: "courses-db", coursesDsId: "courses-ds",
}));
const { db, getAssignment, pendingProjectionsForCourse, completeProjection } = await import("../src/store/db.js");
const { runSync } = await import("../src/sync/engine.js");
const originalFetch = globalThis.fetch;

const assignment = (name = "Essay") => ({
  id: 101, course_id: 1, name, description: "<p>Instructions</p>",
  submission: { assignment_id: 101, workflow_state: "unsubmitted" },
});
let observed = [assignment()];
let frozen = false;
let fail: "properties" | "details" | "activity" | undefined;
let assignmentWrites: { kind: string; body: any }[] = [];
let blockSequence = 0;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const failure = () => json({ object: "error", status: 400, code: "validation_error", message: "simulated failure" }, 400);

beforeEach(() => {
  db.exec("DELETE FROM pending_assignment_projections; DELETE FROM snapshots; DELETE FROM assignments; DELETE FROM courses; DELETE FROM sync_runs;");
  observed = [assignment()];
  frozen = false;
  fail = undefined;
  assignmentWrites = [];
  // Every HTTP request stays in this fixture, including unexpected requests.
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "canvas.invalid") {
      if (url.pathname === "/api/v1/users/self") return json({ id: 7 });
      if (url.pathname === "/api/v1/courses") return json([{ id: 1, name: "Course", course_code: "C1" }]);
      if (url.pathname.endsWith("/assignment_groups")) return json([]);
      if (url.pathname.endsWith("/assignments")) return json(observed);
    }
    if (url.hostname === "api.notion.com") {
      if (url.pathname === "/v1/data_sources/courses-ds/query") return json({ results: [{ id: "course-page" }] });
      if (url.pathname === "/v1/data_sources/assignments-ds/query") return json({ results: [{ id: "assignment-page" }] });
      if (url.pathname === "/v1/pages/course-page") return json({ id: "course-page" });
      if (url.pathname === "/v1/pages/assignment-page") {
        if (init?.method === "GET") return json({ properties: {
          "Do Not Sync": { checkbox: frozen }, Hidden: { checkbox: true }, "In Progress": { checkbox: true },
        } });
        const body = JSON.parse(String(init?.body));
        assignmentWrites.push({ kind: "properties", body });
        return fail === "properties" ? failure() : json({ id: "assignment-page" });
      }
      if (url.pathname === "/v1/blocks/assignment-page/children") {
        if (init?.method === "GET") return json({ results: [] });
        const body = JSON.parse(String(init?.body));
        const kind = body.children[0]?.type === "paragraph" ? "activity" : "details";
        assignmentWrites.push({ kind, body });
        return fail === kind ? failure() : json({ results: body.children.map((b: object, i: number) => ({ ...b, id: `block-${++blockSequence}` })) });
      }
    }
    throw new Error(`Unexpected mocked request: ${init?.method} ${url.pathname}`);
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

for (const stage of ["properties", "details"] as const) {
  test(`retries a failed ${stage} projection even when Canvas returns no assignments`, async () => {
    fail = stage;
    const first = await runSync();
    assert.equal(first.errors.length, 1);
    assert.equal(first.changesPushed, 0);
    assert.equal(getAssignment(101)?.name, "Essay");
    assert.equal(pendingProjectionsForCourse(1).length, 1);
    // A separate SQLite connection sees committed retry state, not just memory.
    const reopened = new Database(config.dbPath, { readonly: true });
    assert.equal((reopened.prepare("SELECT count(*) AS n FROM pending_assignment_projections").get() as { n: number }).n, 1);
    reopened.close();

    fail = undefined;
    observed = [];
    assignmentWrites = [];
    const retried = await runSync();
    assert.deepEqual(retried.errors, []);
    assert.equal(retried.assignmentsSeen, 0);
    assert.equal(retried.changesPushed, 1);
    assert.ok(assignmentWrites.some(w => w.kind === "details"));
    assert.deepEqual(pendingProjectionsForCourse(1), []);
    assignmentWrites = [];
    assert.equal((await runSync()).changesPushed, 0);
    assert.equal(assignmentWrites.length, 0);
  });
}

test("unchanged observations retain pending work without duplicate snapshots", async () => {
  fail = "properties";
  await runSync();
  const pending = pendingProjectionsForCourse(1)[0]!;
  fail = undefined;
  assert.equal((await runSync()).changesPushed, 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM snapshots").get() as { n: number }).n, 1);
  assert.equal(pending.is_new, 1);
  assert.deepEqual(pendingProjectionsForCourse(1), []);
});

test("Do Not Sync retains pending work without writes and catches up after unfreezing", async () => {
  frozen = true;
  assert.deepEqual((await runSync()).errors, []);
  assert.equal(pendingProjectionsForCourse(1).length, 1);
  observed = [];
  assert.equal((await runSync()).changesPushed, 0);
  assert.equal(assignmentWrites.length, 0);
  assert.equal(pendingProjectionsForCourse(1).length, 1);
  frozen = false;
  assert.equal((await runSync()).changesPushed, 1);
  const properties = assignmentWrites.find(w => w.kind === "properties")!.body.properties;
  assert.deepEqual(properties.Hidden, { checkbox: true });
  assert.deepEqual(properties["In Progress"], { checkbox: true });
  assert.equal(properties["Do Not Sync"], undefined);
  assert.deepEqual(pendingProjectionsForCourse(1), []);
});

test("full-sync retries force details even for an unchanged assignment", async () => {
  await runSync();
  fail = "details";
  assert.equal((await runSync({ full: true })).errors.length, 1);
  const pending = pendingProjectionsForCourse(1)[0]!;
  assert.equal(pending.force_details, 1);
  assert.deepEqual(JSON.parse(pending.changed_fields), []);
  fail = undefined;
  observed = [];
  assignmentWrites = [];
  assert.equal((await runSync()).changesPushed, 1);
  assert.ok(assignmentWrites.some(w => w.kind === "details"));
  assert.deepEqual(pendingProjectionsForCourse(1), []);
});

test("activity failures retain changes and an older acknowledgement cannot clear newer work", async () => {
  await runSync();
  observed = [assignment("Renamed")];
  fail = "activity";
  assert.equal((await runSync()).errors.length, 1);
  const old = pendingProjectionsForCourse(1)[0]!;
  assert.deepEqual(JSON.parse(old.changed_fields), ["name"]);
  observed = [{ ...assignment("Renamed again"), description: "<p>New instructions</p>" }];
  await runSync();
  completeProjection(old);
  const pending = pendingProjectionsForCourse(1)[0]!;
  assert.notEqual(pending.revision, old.revision);
  assert.deepEqual(JSON.parse(pending.changed_fields), ["name", "description_html"]);
  fail = undefined;
  observed = [];
  assert.equal((await runSync()).changesPushed, 1);
  assert.deepEqual(pendingProjectionsForCourse(1), []);
});

test("an enqueue failure rolls back both the observation and its snapshot", async () => {
  db.exec(`CREATE TEMP TRIGGER reject_pending BEFORE INSERT ON pending_assignment_projections
    BEGIN SELECT RAISE(ABORT, 'simulated disk write failure'); END;`);
  try {
    assert.equal((await runSync()).errors.length, 1);
    assert.equal(getAssignment(101), undefined);
    assert.equal((db.prepare("SELECT count(*) AS n FROM snapshots").get() as { n: number }).n, 0);
    assert.deepEqual(pendingProjectionsForCourse(1), []);
    assert.equal(assignmentWrites.length, 0);
  } finally {
    db.exec("DROP TRIGGER reject_pending");
  }
});
