// Minimal ambient mirrors of Cloudflare's SqlStorage globals, just enough for
// workers/sqlStore.ts to typecheck inside the Node test program. The real
// definitions live in @cloudflare/workers-types (tsconfig.workers.json), which
// can't be loaded here because its globals conflict with @types/node.
type SqlStorageValue = ArrayBuffer | string | number | bigint | null;

interface SqlStorageCursor {
  toArray(): Record<string, SqlStorageValue>[];
  one(): Record<string, SqlStorageValue>;
}

interface SqlStorage {
  exec(query: string, ...bindings: SqlStorageValue[]): SqlStorageCursor;
}
