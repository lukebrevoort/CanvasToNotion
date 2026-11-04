/** Dummy-only one-page Canvas acquisition. No auth, fetch construction, retries,
 * timer or durable writes. Caller must persist returned state/items together;
 * replaying old state is an explicit new read, not an automatic retry policy.
 * Source watermark advancement and concurrent ingestion are not implemented.
 */
import type { CanvasCourse, CanvasAssignment, CanvasAssignmentGroup, CanvasSubmission } from "../canvas/types.js";
export type CanvasListEndpoint =
  | { kind: "courses"; enrollmentState?: "active" | "invited_or_pending" }
  | { kind: "assignments"; courseId: number; updatedSince?: string }
  | { kind: "assignmentGroups"; courseId: number };
export type CanvasPageItem = CanvasCourse | (CanvasAssignment & { submission?: CanvasSubmission | null }) | CanvasAssignmentGroup;
export interface CanvasPageState {
  schemaVersion: 1; syntheticOnly: true; endpoint: CanvasListEndpoint;
  initialUrl: string; nextUrl: string | null;
  seenCursors: string[]; seenItemIds: number[];
  pagesRead: number; itemsRead: number; maxPages: number; maxItems: number;
}
export interface CanvasPageTransport {
  requestDetailed(request: { url: string; method: "GET" }): Promise<{ json: unknown; link: string | null }>;
}
export class CanvasPageError extends Error {
  constructor(readonly code: "invalid" | "state" | "scope" | "cycle" | "budget" | "response" | "transport") {
    super(`Synthetic Canvas page: ${code}`); this.name = "CanvasPageError";
  }
}
function fail(code: CanvasPageError["code"]): never { throw new CanvasPageError(code); }
const ORIGIN = "https://canvas.invalid";
const id = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== Object.keys(descriptors).length || Object.values(descriptors).some(d => !d.enumerable || !Object.hasOwn(d, "value"))) fail("invalid");
  return value as Record<string, unknown>;
}
function endpointPlan(input: CanvasListEndpoint): { endpoint: CanvasListEndpoint; url: URL } {
  const value = object(input); let endpoint: CanvasListEndpoint; let url: URL;
  if (value.kind === "courses") {
    if (Object.keys(value).some(k => !["kind", "enrollmentState"].includes(k)) || value.enrollmentState !== undefined && !["active", "invited_or_pending"].includes(value.enrollmentState as string)) fail("invalid");
    const enrollmentState = value.enrollmentState as "active" | "invited_or_pending" | undefined ?? "active";
    endpoint = { kind: "courses", enrollmentState }; url = new URL(`${ORIGIN}/api/v1/courses`);
    url.searchParams.set("enrollment_state", enrollmentState); url.searchParams.set("include", "term");
  } else if (value.kind === "assignments" || value.kind === "assignmentGroups") {
    if (!id(value.courseId) || Object.keys(value).some(k => !["kind", "courseId", ...(value.kind === "assignments" ? ["updatedSince"] : [])].includes(k))) fail("invalid");
    if (value.kind === "assignmentGroups") {
      endpoint = { kind: "assignmentGroups", courseId: value.courseId }; url = new URL(`${ORIGIN}/api/v1/courses/${value.courseId}/assignment_groups`); url.searchParams.set("per_page", "100");
    } else {
      let updatedSince: string | undefined;
      if (value.updatedSince !== undefined) {
        if (typeof value.updatedSince !== "string" || !Number.isFinite(Date.parse(value.updatedSince))) fail("invalid");
        updatedSince = new Date(value.updatedSince).toISOString();
      }
      endpoint = { kind: "assignments", courseId: value.courseId, ...(updatedSince ? { updatedSince } : {}) };
      url = new URL(`${ORIGIN}/api/v1/courses/${value.courseId}/assignments`);
      for (const [k, v] of Object.entries({ order_by: "due_at", per_page: "100", include: "submission", all_dates: "true", ...(updatedSince ? { updated_since: updatedSince } : {}) })) url.searchParams.set(k, v);
    }
  } else fail("invalid");
  return { endpoint, url };
}
/** Keep endpoint/filter identity fixed. Only page cursor (and a bounded default
 * per_page for courses) may vary. Query ordering/escaping cannot evade cycles. */
function cursor(input: string, initial: URL): string {
  let url: URL;
  try { url = new URL(input, initial); } catch { return fail("scope"); }
  if (url.origin !== ORIGIN || url.username || url.password || url.hash || url.pathname !== initial.pathname || url.href.length > 4096) fail("scope");
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length) fail("scope");
  for (const [key, value] of initial.searchParams) if (url.searchParams.get(key) !== value) fail("scope");
  for (const [key, value] of url.searchParams) {
    if (initial.searchParams.has(key)) continue;
    if (key === "page" && value.length > 0 && value.length <= 1024) continue;
    if (key === "per_page" && /^[1-9][0-9]{0,2}$/.test(value) && Number(value) <= 100) continue;
    fail("scope");
  }
  url.searchParams.sort(); return url.href;
}
export function createCanvasPageState(options: { syntheticOnly: true; endpoint: CanvasListEndpoint; maxPages: number; maxItems: number }): CanvasPageState {
  if (options.syntheticOnly !== true || !Number.isSafeInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 50 || !Number.isSafeInteger(options.maxItems) || options.maxItems < 1 || options.maxItems > 5000) fail("invalid");
  const { endpoint, url } = endpointPlan(options.endpoint);
  return { schemaVersion: 1, syntheticOnly: true, endpoint, initialUrl: url.href, nextUrl: cursor(url.href, url), seenCursors: [], seenItemIds: [], pagesRead: 0, itemsRead: 0, maxPages: options.maxPages, maxItems: options.maxItems };
}
function checkedState(input: CanvasPageState): CanvasPageState {
  object(input);
  const initial = createCanvasPageState(input);
  if (input.schemaVersion !== 1 || input.initialUrl !== initial.initialUrl || !Array.isArray(input.seenCursors) || !Array.isArray(input.seenItemIds) ||
      !Number.isSafeInteger(input.pagesRead) || input.pagesRead < 0 || input.pagesRead > input.maxPages || input.pagesRead !== input.seenCursors.length ||
      !Number.isSafeInteger(input.itemsRead) || input.itemsRead < 0 || input.itemsRead > input.maxItems || input.itemsRead !== input.seenItemIds.length ||
      input.seenItemIds.some(v => !id(v)) || new Set(input.seenItemIds).size !== input.seenItemIds.length) fail("state");
  const url = new URL(initial.initialUrl);
  const seen = input.seenCursors.map(value => { if (typeof value !== "string") fail("state"); return cursor(value, url); });
  if (new Set(seen).size !== seen.length || seen.some((v, i) => v !== input.seenCursors[i])) fail("state");
  if (input.pagesRead === 0 && (input.nextUrl !== initial.nextUrl || input.itemsRead !== 0) || input.pagesRead > 0 && seen[0] !== initial.nextUrl) fail("state");
  if (input.nextUrl !== null && (typeof input.nextUrl !== "string" || cursor(input.nextUrl, url) !== input.nextUrl || seen.includes(input.nextUrl))) fail("state");
  return structuredClone(input);
}
/** Validate and capture a page checkpoint without making a request. */
export function validateCanvasPageState(input: CanvasPageState): CanvasPageState { return checkedState(input); }
function nextLink(header: string | null, initial: URL): string | null {
  if (header === null) return null;
  if (typeof header !== "string" || header.length > 8192 || /[\r\n]/.test(header)) fail("response");
  if (!header.trim()) return null;
  // Split commas only outside URLs and quoted parameter values.
  const entries: string[] = []; let start = 0, angle = false, quoted = false, escaped = false;
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (escaped) { escaped = false; continue; }
    if (quoted && c === "\\") { escaped = true; continue; }
    if (!angle && c === '"') quoted = !quoted;
    else if (!quoted && c === "<") { if (angle) fail("response"); angle = true; }
    else if (!quoted && c === ">") { if (!angle) fail("response"); angle = false; }
    else if (!angle && !quoted && c === ",") { entries.push(header.slice(start, i)); start = i + 1; }
  }
  if (angle || quoted || escaped) fail("response"); entries.push(header.slice(start));
  let next: string | null = null;
  for (const entry of entries) {
    const match = /^\s*<([^<>]+)>\s*((?:;[\s\S]*)?)$/.exec(entry);
    if (!match) fail("response");
    let params = match[2] ?? "", rel: string | undefined;
    const parameterNames = new Set<string>();
    while (params.trim()) {
      const parameter = /^;\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*("(?:[^"\\]|\\.)*"|[^;\s]+)\s*/.exec(params);
      if (!parameter) fail("response");
      const name = parameter[1]!.toLowerCase();
      if (parameterNames.has(name)) fail("response"); parameterNames.add(name);
      const raw = parameter[2]!;
      const value = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw;
      if (name === "rel") rel = value;
      params = params.slice(parameter[0].length);
    }
    if (rel === undefined) fail("response");
    if (rel.split(/\s+/).includes("next")) {
      if (next !== null) fail("response"); next = cursor(match[1]!, initial);
    }
  }
  return next;
}
function normalizeItem(input: unknown, endpoint: CanvasListEndpoint): CanvasPageItem {
  const value = object(input); if (!id(value.id)) fail("response");
  const out: Record<string, unknown> = { id: value.id };
  const copy = (keys: string[], type: "string" | "number" | "boolean", nullable = false) => {
    for (const key of keys) if (Object.hasOwn(value, key)) {
      const v = value[key];
      if (!(nullable && v === null) && (typeof v !== type || type === "number" && !Number.isFinite(v as number))) fail("response");
      out[key] = v;
    }
  };
  if (endpoint.kind === "courses") {
    copy(["name", "course_code", "workflow_state", "time_zone", "created_at"], "string");
    copy(["start_at", "end_at"], "string", true); copy(["enrollment_term_id"], "number");
  } else if (endpoint.kind === "assignmentGroups") {
    copy(["name"], "string"); copy(["group_weight"], "number", true);
  } else {
    if (value.course_id !== endpoint.courseId || typeof value.name !== "string") fail("response");
    out.course_id = endpoint.courseId; out.name = value.name;
    copy(["description", "due_at", "unlock_at", "lock_at"], "string", true);
    copy(["updated_at", "created_at"], "string"); copy(["points_possible", "quiz_id"], "number", true);
    copy(["assignment_group_id", "position"], "number"); copy(["is_quiz_assignment", "is_quiz_lti_assignment"], "boolean");
    if (Object.hasOwn(value, "submission_types")) {
      if (!Array.isArray(value.submission_types) || value.submission_types.some(v => typeof v !== "string")) fail("response");
      out.submission_types = [...value.submission_types];
    }
    if (Object.hasOwn(value, "submission")) {
      if (value.submission === null) out.submission = null;
      else {
        const submission = object(value.submission);
        if (submission.assignment_id !== value.id) fail("response");
        const normalized: Record<string, unknown> = { assignment_id: value.id };
        for (const [key, type, nullable] of [["workflow_state", "string", false], ["submitted_at", "string", true], ["graded_at", "string", true], ["score", "number", true], ["grade", "string", true], ["attempt", "number", true], ["late", "boolean", false], ["excused", "boolean", false], ["missing", "boolean", false], ["points_deducted", "number", true]] as const) {
          if (!Object.hasOwn(submission, key)) continue; const v = submission[key];
          if (!(nullable && v === null) && (typeof v !== type || type === "number" && !Number.isFinite(v as number))) fail("response");
          normalized[key] = v;
        }
        out.submission = normalized;
      }
    }
  }
  return out as unknown as CanvasPageItem;
}
export async function readCanvasPage(input: CanvasPageState, transport: CanvasPageTransport): Promise<{ state: CanvasPageState; items: CanvasPageItem[]; done: boolean }> {
  const state = checkedState(input);
  if (state.nextUrl === null) return { state, items: [], done: true };
  if (state.pagesRead >= state.maxPages || state.itemsRead >= state.maxItems) fail("budget");
  let response: { json: unknown; link: string | null };
  try { response = await transport.requestDetailed({ url: state.nextUrl, method: "GET" }); }
  catch { throw new CanvasPageError("transport"); }
  if (!response || typeof response !== "object" || !Array.isArray(response.json) || response.json.length > 100 || state.itemsRead + response.json.length > state.maxItems) fail("response");
  const items = response.json.map(item => normalizeItem(item, state.endpoint));
  const ids = items.map(item => item.id);
  if (new Set(ids).size !== ids.length || ids.some(itemId => state.seenItemIds.includes(itemId))) fail("response");
  const next = nextLink(response.link, new URL(state.initialUrl));
  const seen = [...state.seenCursors, state.nextUrl];
  if (next !== null && seen.includes(next)) fail("cycle");
  return { state: { ...state, nextUrl: next, seenCursors: seen, seenItemIds: [...state.seenItemIds, ...ids], pagesRead: state.pagesRead + 1, itemsRead: state.itemsRead + items.length }, items, done: next === null };
}
