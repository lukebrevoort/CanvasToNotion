import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { Client } from "@notionhq/client";
import type { AssignmentRow } from "../src/store/db.js";
import { assignmentProperties, upsertAssignmentPage, upsertCoursePage } from "../src/notion/projector-core.js";

const destinations = { assignmentsDbId: "dummy-assignment-db", assignmentsDsId: "dummy-assignment-ds", coursesDbId: "dummy-course-db", coursesDsId: "dummy-course-ds" };
const row = { canvas_id: 42, course_id: 1, name: "Dummy", submission_types: "[]" } as AssignmentRow;
const options = { isNew: false, revision: "11111111-2222-4333-8444-555555555555", changedFields: [], coursePageId: null, courseLabel: "Dummy" };
function fixture(existing = true) {
  const calls: unknown[] = [];
  const client = {
    dataSources: { query: async (p: unknown) => { calls.push(["query", p]); return { results: existing ? [{ id: "dummy-page" }] : [], has_more: false }; } },
    pages: {
      retrieve: async (p: unknown) => { calls.push(["retrieve", p]); return { properties: { "Do Not Sync": { checkbox: false } } }; },
      update: async (p: unknown) => { calls.push(["update", p]); return { id: "dummy-page" }; },
      create: async (p: unknown) => { calls.push(["create", p]); return { id: "dummy-page" }; },
    },
  } as unknown as Client;
  return { client, calls };
}

test("pure assignment projection uses only explicit destinations", async () => {
  const f = fixture();
  assert.deepEqual(await upsertAssignmentPage(f.client, row, "dummy.invalid", options, destinations), { pageId: "dummy-page", pushed: true });
  assert.equal((f.calls[0] as any)[1].data_source_id, destinations.assignmentsDsId);
  assert.deepEqual((f.calls.at(-1) as any)[1].properties, assignmentProperties(row, "dummy.invalid", options.courseLabel));
});

test("pure course creation uses explicit data-source and database pair", async () => {
  const f = fixture(false);
  await upsertCoursePage(f.client, { canvas_id: 1, name: "Dummy", course_code: null, term_id: null, start_at: null, end_at: null }, "dummy.invalid", destinations);
  assert.equal((f.calls[0] as any)[1].data_source_id, destinations.coursesDsId);
  assert.deepEqual((f.calls[1] as any)[1].parent, { database_id: destinations.coursesDbId });
});

test("Node wrapper retains projection results and request payloads", async () => {
  const { config } = await import("../src/config.js");
  const previous = { statePath: config.statePath, assignmentsDbId: config.assignmentsDbId, coursesDbId: config.coursesDbId };
  try {
    config.statePath = "/nonexistent-dummy-projector-core-state";
    config.assignmentsDbId = destinations.assignmentsDbId;
    config.coursesDbId = destinations.coursesDbId;
    const node = await import("../src/notion/projector.js");
    const a = fixture(), b = fixture();
    const ids = { ...destinations, assignmentsDsId: destinations.assignmentsDbId, coursesDsId: destinations.coursesDbId };
    assert.deepEqual(await node.upsertAssignmentPage(a.client, row, "dummy.invalid", options), await upsertAssignmentPage(b.client, row, "dummy.invalid", options, ids));
    assert.deepEqual(a.calls, b.calls);
    assert.equal(node.assignmentProperties, assignmentProperties);
  } finally { Object.assign(config, previous); }
});

test("emitted core runtime graph contains no config, SQLite, fs, Node builtins or SDK runtime import", () => {
  const root = path.resolve(import.meta.dirname, "../src/notion/projector-core.ts");
  const seen = new Set<string>();
  const walk = (filename: string) => {
    if (seen.has(filename)) return;
    seen.add(filename);
    const emitted = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true } }).outputText;
    const ast = ts.createSourceFile(filename, emitted, ts.ScriptTarget.ES2023, true);
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      assert(specifier.startsWith("."), `Unexpected runtime dependency: ${specifier}`);
      assert(!/(?:schema|config|store|diagnostics)/.test(specifier));
      walk(path.resolve(path.dirname(filename), specifier.replace(/\.js$/, ".ts")));
    }
    assert(!/\b(?:require|import)\s*\(/.test(emitted), "Dynamic runtime dependency requires review");
  };
  walk(root);
  assert.deepEqual([...seen].map(f => path.basename(f)).sort(), ["activity.ts", "blocks.ts", "projector-core.ts"]);
});
