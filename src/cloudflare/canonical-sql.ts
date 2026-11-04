import type { StoreSqlPort, StoreStatement } from "../store/core.js";
import type { DurableSqlStorage } from "./sqlite-storage.js";

/** Narrow canonical-store bridge, not a better-sqlite3 compatibility layer.
 * SQL cursors are consumed synchronously. Durability/output gating remains the
 * caller's responsibility; this adapter never claims a synchronous sync() ack.
 * https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
 */
type Value = string | number | null;
type Compiled = { sql: string; names: string[]; positional: number; statements: string[] };
function refused(reason: string): never { throw new Error(`Canonical SQL adapter: ${reason}`); }

/** Lex SQL, preserving quoted strings/identifiers and comments verbatim. Only
 * bare ? and @identifier placeholders are supported; no numbered/mixed styles.
 * This intentionally excludes trigger bodies and other multi-statement prepare.
 */
function compile(source: string): Compiled {
  if (typeof source !== "string" || source.includes("\0")) refused("invalid SQL");
  let sql = "", positional = 0, first = "";
  const names: string[] = [], statements: string[] = [];
  for (let i = 0; i < source.length;) {
    const c = source[i]!, next = source[i + 1];
    if (c === "-" && next === "-") {
      const end = source.indexOf("\n", i + 2), stop = end < 0 ? source.length : end;
      sql += source.slice(i, stop); i = stop; continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2); if (end < 0) refused("unterminated comment");
      sql += source.slice(i, end + 2); i = end + 2; continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c, start = i++;
      let closed = false;
      while (i < source.length) {
        if (source[i++] !== close) continue;
        if (c !== "[" && source[i] === close) { i++; continue; }
        closed = true; break;
      }
      if (!closed) refused("unterminated quote");
      if (!first) first = "quoted";
      sql += source.slice(start, i); continue;
    }
    if (c === ";") { if (first) statements.push(first); first = ""; sql += c; i++; continue; }
    if (/\s/.test(c)) { sql += c; i++; continue; }
    if (!first) first = /^[A-Za-z_]+/.exec(source.slice(i))?.[0]?.toUpperCase() ?? "other";
    if (c === "@") {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i + 1))?.[0];
      if (!name) refused("unsupported named binding");
      names.push(name); sql += "?"; i += name.length + 1; continue;
    }
    if (c === "?") {
      if (next && /[0-9]/.test(next)) refused("numbered bindings unsupported");
      positional++; sql += c; i++; continue;
    }
    if (c === ":" || c === "$") refused("unsupported binding syntax");
    sql += c; i++;
  }
  if (first) statements.push(first);
  if (!statements.length) refused("empty SQL");
  if (names.length && positional) refused("mixed bindings unsupported");
  if (statements.some(s => ["PRAGMA", "BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE", "ATTACH", "DETACH"].includes(s))) refused("use supported pragma/transaction methods");
  return { sql, names, positional, statements };
}
function value(input: unknown): Value {
  if (input === null || typeof input === "string") return input;
  if (typeof input === "number" && Number.isFinite(input) && (!Number.isInteger(input) || Number.isSafeInteger(input))) return input;
  return refused("unsupported binding value");
}
function bindings(compiled: Compiled, args: unknown[]): Value[] {
  if (!compiled.names.length) {
    if (args.length !== compiled.positional) refused("positional binding count mismatch");
    return args.map(value);
  }
  if (args.length !== 1 || !args[0] || typeof args[0] !== "object" || Array.isArray(args[0]) || ![null, Object.prototype].includes(Object.getPrototypeOf(args[0]))) refused("named binding object required");
  const descriptors = Object.getOwnPropertyDescriptors(args[0]);
  // Extra record properties are allowed, as canonical insert/update share a row.
  return compiled.names.map(name => {
    const descriptor = descriptors[name];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) refused(`missing or accessor binding ${name}`);
    return value(descriptor.value);
  });
}
function safeInteger(input: unknown, nonnegative: boolean): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || (nonnegative && input < 0)) refused("unsafe result metadata");
  return input;
}
export function createDurableSqlDatabase(storage: Pick<DurableSqlStorage, "sql" | "transactionSync">): StoreSqlPort {
  return {
    exec(source) {
      const compiled = compile(source);
      if (compiled.names.length || compiled.positional) refused("exec bindings unsupported");
      storage.sql.exec(compiled.sql).toArray();
    },
    pragma(source) {
      // Intentionally narrower than the platform: WAL stays in the Node wrapper.
      const input = source.trim();
      if (!/^table_info\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\)$/i.test(input) && !/^foreign_keys(?:\s*=\s*(?:ON|OFF|0|1))?$/i.test(input)) refused("unsupported pragma");
      return storage.sql.exec(`PRAGMA ${input}`).toArray();
    },
    prepare(source): StoreStatement {
      const compiled = compile(source);
      if (compiled.statements.length !== 1) refused("prepare requires one statement");
      const rows = (args: unknown[]) => storage.sql.exec(compiled.sql, ...bindings(compiled, args)).toArray();
      return {
        get: (...args) => rows(args)[0],
        all: (...args) => rows(args),
        run: (...args) => {
          rows(args);
          // changes() excludes index/trigger billing writes. Query immediately,
          // with no async boundary or intervening SQL on this connection.
          const metadata = storage.sql.exec("SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid").toArray();
          if (metadata.length !== 1) refused("missing result metadata");
          return { changes: safeInteger(metadata[0]!.changes, true), lastInsertRowid: safeInteger(metadata[0]!.lastInsertRowid, false) };
        },
      };
    },
    transaction(callback) {
      if (typeof callback !== "function" || callback.constructor.name === "AsyncFunction") refused("synchronous transaction callback required");
      // Forward every nesting level to workerd, whose nested transactionSync
      // savepoints preserve caught-inner rollback (verified in the runtime test).
      return (...args) => storage.transactionSync(() => {
        const result = callback(...args);
        if (result && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") refused("synchronous transaction callback required");
        return result;
      });
    },
  };
}
