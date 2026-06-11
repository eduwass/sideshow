import { DatabaseSync } from "node:sqlite";

// In-memory stand-in for a Durable Object's SqlStorage, backed by node:sqlite.
// Implements only the surface SqlStore touches: exec() with positional
// bindings, cursor.toArray(), cursor.one().
export function createSqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...bindings) {
      // Multi-statement scripts (the schema DDL) can't be prepared; they never
      // bind parameters or return rows.
      if (bindings.length === 0 && /;\s*\S/.test(query)) {
        db.exec(query);
        return cursor([]);
      }
      const rows = db.prepare(query).all(...(bindings as (string | number | bigint | null)[]));
      return cursor(rows as Record<string, SqlStorageValue>[]);
    },
  };
}

function cursor(rows: Record<string, SqlStorageValue>[]): SqlStorageCursor {
  return {
    toArray: () => rows,
    one: () => {
      if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
      return rows[0];
    },
  };
}
