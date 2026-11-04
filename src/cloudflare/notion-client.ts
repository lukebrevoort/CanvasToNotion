import { SyntheticJsonTransport } from "./transport.js";

/** Only the HTTP methods used by projector-core/activity/blocks, not a full SDK.
 * Caller supplies a dummy transport. No credentials, retries, provider selection
 * or pagination automation. The projector retains its existing cursor guards.
 */
export const SYNTHETIC_NOTION_VERSION = "2025-09-03" as const;
type Args = Record<string, unknown>;
const invalid = (): never => { throw new Error("Invalid synthetic Notion request"); };
const object = (v: unknown): v is Args => v !== null && typeof v === "object" && !Array.isArray(v);
function args(input: unknown, required: string[], optional: string[] = []): Args {
  if (!object(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).some(k => typeof k !== "string" || ![...required, ...optional].includes(k)) || Object.values(descriptors).some(d => !d.enumerable || !Object.hasOwn(d, "value")) || required.some(k => !Object.hasOwn(input, k))) return invalid();
  return input;
}
function id(v: unknown): string {
  if (typeof v !== "string" || !/^(?:dummy-|SYNTHETIC_)[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(v)) return invalid();
  return v;
}
/** Nested relation/mention/block references must stay synthetic as well. */
function references(value: unknown, depth = 0): void {
  if (depth > 32) return invalid();
  if (Array.isArray(value)) { for (const item of value) references(item, depth + 1); return; }
  if (!object(value)) {
    if (["function", "symbol", "bigint"].includes(typeof value)) return invalid();
    return;
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, "value")) return invalid();
    const child = descriptor.value;
    if (["id", "page_id", "block_id", "database_id", "data_source_id"].includes(key)) id(child);
    else references(child, depth + 1);
  }
}
function properties(value: unknown): void {
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  // Property names themselves are arbitrary, including a property named "id".
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, "value")) return invalid();
    references(descriptor.value);
  }
}
function cursor(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  // Notion cursors are opaque, NOT record IDs; URLSearchParams handles encoding.
  if (typeof v !== "string" || !v.length || new TextEncoder().encode(v).length > 4096) return invalid();
  return v;
}
function pageSize(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 100) return invalid();
  return v as number;
}
function pagination(a: Args): Args {
  const c = cursor(a.start_cursor), n = pageSize(a.page_size);
  return { ...(c === undefined ? {} : { start_cursor: c }), ...(n === undefined ? {} : { page_size: n }) };
}
export function createSyntheticNotionClient(transport: SyntheticJsonTransport) {
  let uncertain = false;
  async function request(path: string, method: "GET" | "POST" | "PATCH" | "DELETE", body: unknown, shape: "page" | "list" | "block") {
    if (uncertain) throw new Error("Synthetic Notion client is uncertain");
    try {
      const response = await transport.request({ url: `https://notion.invalid/v1/${path}`, method, ...(body === undefined ? {} : { json: body }), notionVersion: SYNTHETIC_NOTION_VERSION });
      if (!object(response)) throw new Error();
      if (shape === "list") {
        if (!Array.isArray(response.results) || response.results.length > 100 || typeof response.has_more !== "boolean" || (response.has_more && !response.next_cursor) || (response.next_cursor !== null && response.next_cursor !== undefined && typeof response.next_cursor !== "string")) throw new Error();
        if (response.next_cursor !== null && response.next_cursor !== undefined) cursor(response.next_cursor);
        for (const item of response.results) { if (!object(item)) throw new Error(); id(item.id); }
      } else { id(response.id); }
      return response;
    } catch { uncertain = true; throw new Error("Synthetic Notion operation unresolved"); }
  }
  return {
    dataSources: { query: async (input: Args) => {
      const a = args(input, ["data_source_id"], ["filter", "page_size", "start_cursor"]);
      if (a.filter !== undefined) { if (!object(a.filter)) return invalid(); references(a.filter); }
      return request(`data_sources/${id(a.data_source_id)}/query`, "POST", { ...(a.filter === undefined ? {} : { filter: a.filter }), ...pagination(a) }, "list");
    } },
    pages: {
      retrieve: async (input: Args) => { const a = args(input, ["page_id"]); return request(`pages/${id(a.page_id)}`, "GET", undefined, "page"); },
      update: async (input: Args) => { const a = args(input, ["page_id", "properties"]); properties(a.properties); return request(`pages/${id(a.page_id)}`, "PATCH", { properties: a.properties }, "page"); },
      create: async (input: Args) => {
        const a = args(input, ["parent", "properties"]); const parent = args(a.parent, ["database_id"]);
        properties(a.properties);
        return request("pages", "POST", { parent: { database_id: id(parent.database_id) }, properties: a.properties }, "page");
      },
    },
    blocks: {
      delete: async (input: Args) => { const a = args(input, ["block_id"]); return request(`blocks/${id(a.block_id)}`, "DELETE", undefined, "block"); },
      children: {
        list: async (input: Args) => {
          const a = args(input, ["block_id"], ["page_size", "start_cursor"]); const query = new URLSearchParams();
          for (const [k, v] of Object.entries(pagination(a))) query.set(k, String(v));
          return request(`blocks/${id(a.block_id)}/children${query.size ? `?${query}` : ""}`, "GET", undefined, "list");
        },
        append: async (input: Args) => {
          const a = args(input, ["block_id", "children"], ["position"]);
          if (!Array.isArray(a.children) || a.children.length < 1 || a.children.length > 100) return invalid();
          references(a.children);
          if (a.position !== undefined) {
            if (!object(a.position)) return invalid();
            if (a.position.type === "start") args(a.position, ["type"]);
            else { const p = args(a.position, ["type", "after_block"]); if (p.type !== "after_block") return invalid(); id(args(p.after_block, ["id"]).id); }
          }
          return request(`blocks/${id(a.block_id)}/children`, "PATCH", { children: a.children, ...(a.position === undefined ? {} : { position: a.position }) }, "list");
        },
      },
    },
  };
}
