import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";

/** Optional, sanitized local evidence. Missing terminal events never prove success. */
const enums: Record<string, readonly string[]> = {
  type: ["process_started", "heartbeat", "request", "sync_started", "sync_finished", "sync_failed", "process_exit"],
  operation: ["notion_request"], kind: ["read", "write"], phase: ["started", "settled"],
  result: ["fulfilled", "rejected"], status: ["ok", "error"],
};
const counts = new Set(["sequence", "elapsedMs", "httpStatus", "runId", "coursesSeen", "assignmentsSeen", "changesPushed", "pending", "errorCount", "pid", "exitCode"]);
export function sanitizedEvent(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "status" && typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) output.httpStatus = value;
    else if (enums[key]?.includes(value as string)) output[key] = value;
    else if (counts.has(key) && Number.isSafeInteger(value) && (value as number) >= 0) output[key === "sequence" ? "requestSequence" : key] = value;
    else if (key === "full" && typeof value === "boolean") output[key] = value;
    else if (key === "hostFingerprint" && typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) output[key] = value;
    else throw new Error("Diagnostic event contains unsupported data");
  }
  return output;
}
const syncDirectory = (p: string) => { const fd = fs.openSync(p, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
export function createDiagnosticLog(base: string) {
  const root = path.resolve(base);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) throw new Error("Canonical diagnostic directory required");
  const directory = path.join(root, `sync-${randomUUID()}`);
  fs.mkdirSync(directory, { mode: 0o700 }); syncDirectory(root);
  const filename = path.join(directory, "events.ndjson");
  const fd = fs.openSync(filename, "wx", 0o600); syncDirectory(directory);
  const original = fs.fstatSync(fd); let sequence = 0, closed = false;
  return {
    directory,
    record(event: Record<string, unknown>) {
      const safe = sanitizedEvent(event);
      if (closed) throw new Error("Diagnostic log is closed");
      const current = fs.lstatSync(filename);
      if (current.ino !== original.ino || current.dev !== original.dev || current.nlink !== 1 || (current.mode & 0o777) !== 0o600) throw new Error("Diagnostic file identity changed");
      const line = Buffer.from(JSON.stringify({ at: new Date().toISOString(), sequence: ++sequence, ...safe }) + "\n");
      let offset = 0; while (offset < line.length) offset += fs.writeSync(fd, line, offset);
      fs.fsyncSync(fd);
    },
    close() { if (!closed) { fs.closeSync(fd); closed = true; } },
  };
}
let active: ReturnType<typeof createDiagnosticLog> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
export function recordDiagnostic(event: Record<string, unknown>) {
  if (!process.env.CANTN_DIAGNOSTICS_DIR) return;
  if (!active) {
    active = createDiagnosticLog(process.env.CANTN_DIAGNOSTICS_DIR);
    let identity = os.hostname();
    for (const p of ["/proc/sys/kernel/random/boot_id", "/proc/self/ns/pid"]) {
      try { identity += "\0" + (p.endsWith("/pid") ? fs.readlinkSync(p) : fs.readFileSync(p, "utf8")); } catch { /* non-Linux */ }
    }
    active.record({ type: "process_started", pid: process.pid, hostFingerprint: createHash("sha256").update(identity).digest("hex") });
    timer = setInterval(() => { try { active?.record({ type: "heartbeat" }); } catch { if (timer) clearInterval(timer); } }, 5000);
    timer.unref();
    process.once("exit", code => { try { active?.record({ type: "process_exit", exitCode: code }); } catch { /* cannot recover at exit */ } active?.close(); });
  }
  active.record({ type: event.type ?? "request", ...event });
}
