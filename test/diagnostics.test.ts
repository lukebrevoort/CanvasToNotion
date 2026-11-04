import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDiagnosticLog, sanitizedEvent } from "../src/runtime/diagnostics.js";

test("diagnostics allow only categorical telemetry, never request or error content", () => {
  assert.deepEqual(sanitizedEvent({ sequence: 1, kind: "read", phase: "settled", result: "fulfilled", status: 200, elapsedMs: 10 }),
    { requestSequence: 1, kind: "read", phase: "settled", result: "fulfilled", httpStatus: 200, elapsedMs: 10 });
  for (const key of ["url", "headers", "body", "token", "error", "message", "pageId"]) assert.throws(() => sanitizedEvent({ [key]: "private" }));
  assert.throws(() => sanitizedEvent({ kind: "arbitrary remote content" }));
  assert.throws(() => sanitizedEvent({ elapsedMs: Infinity }));
});
test("private exclusive diagnostic files persist ordered events and reject replaced paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cantn-diagnostics-"));
  try {
    const a = createDiagnosticLog(root), b = createDiagnosticLog(root);
    assert.notEqual(a.directory, b.directory);
    a.record({ type: "sync_started", full: false });
    a.record({ operation: "notion_request", sequence: 4, kind: "read", phase: "started" });
    const filename = path.join(a.directory, "events.ndjson");
    const events = fs.readFileSync(filename, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(events.map(e => e.sequence), [1, 2]);
    assert.equal(events[1].requestSequence, 4);
    assert.equal(fs.statSync(a.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    fs.renameSync(filename, filename + ".preserved");
    fs.writeFileSync(filename, "", { mode: 0o600 });
    assert.throws(() => a.record({ type: "heartbeat" }), /identity changed/);
    a.close(); b.close();
    assert.throws(() => b.record({ type: "heartbeat" }), /closed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
