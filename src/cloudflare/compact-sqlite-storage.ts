import type { CompactState, CompactStorage, CompactTransaction } from "./compact-journal.js";
import type { DurableSqlStorage } from "./sqlite-storage.js";

/** Experimental single-row ledger. A bounded prototype, not a full mirror store.
 * transactionSync provides isolation; sync is awaited BEFORE an effect is allowed.
 * A failed durability acknowledgment permanently blocks this adapter instance.
 */
export class DurableSqlCompactStorage implements CompactStorage {
  private failed = false;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly storage: DurableSqlStorage) {}

  transaction<T>(callback: (transaction: CompactTransaction) => T): Promise<T> {
    const pending = this.tail.then(() => this.commit(callback));
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async commit<T>(callback: (transaction: CompactTransaction) => T): Promise<T> {
    if (this.failed) throw new Error("Compact ledger durability is uncertain");
    const value = this.storage.transactionSync(() => {
      for (const legacy of ["sync_journal_v1", "synthetic_coordinator_v1"]) {
        if (this.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name=?", legacy).toArray().length &&
            this.storage.sql.exec(`SELECT slot FROM ${legacy} WHERE slot=1`).toArray().length) throw new Error("Fresh compact storage required");
      }
      this.storage.sql.exec("CREATE TABLE IF NOT EXISTS synthetic_compact_journal_v2 (slot INTEGER PRIMARY KEY CHECK (slot = 1), document TEXT NOT NULL)");
      let open = true;
      const assertOpen = () => { if (!open) throw new Error("Compact ledger transaction has closed"); };
      const transaction: CompactTransaction = {
        get: () => {
          assertOpen();
          const rows = this.storage.sql.exec<{ document: string }>("SELECT document FROM synthetic_compact_journal_v2 WHERE slot = 1").toArray();
          if (rows.length > 1) throw new Error("Ambiguous ledger state");
          if (!rows.length) return undefined;
          return JSON.parse(rows[0]!.document) as CompactState;
        },
        put: state => {
          assertOpen();
          const document = JSON.stringify(state);
          if (new TextEncoder().encode(document).byteLength > 65_536) throw new Error("Prototype ledger capacity exceeded");
          this.storage.sql.exec("INSERT INTO synthetic_compact_journal_v2 (slot, document) VALUES (1, ?) ON CONFLICT(slot) DO UPDATE SET document = excluded.document", document);
        },
      };
      try {
        const result = callback(transaction);
        if (result && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") throw new Error("Synchronous ledger transaction required");
        return result;
      } finally { open = false; }
    });
    try { await this.storage.sync(); }
    catch { this.failed = true; throw new Error("Compact ledger durability is uncertain"); }
    return value;
  }
}
