import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

// Lazily initialised singletons. We deliberately do NOT read
// `process.env.DATABASE_URL` at module-load time, because Next.js's
// page-data-collection phase imports every route module to classify it
// as static or dynamic. With an eager `new Pool({ connectionString })`
// (and an early-throw on the missing env), that phase would crash on
// any machine without DB credentials — e.g. CI image builds, local
// machines building before `docker compose up`, code-review sandboxes.
//
// The exported `db` and `pool` proxies forward every property read to
// a lazily-constructed underlying instance, so existing call sites
// (`db.select(...).from(...)`, `await db.insert(table).values(...)`)
// keep working without modification. The first actual method call hits
// `requireDatabaseUrl()` and throws a clear runtime error if the env
// var is still missing — so we lose no failure-mode clarity, we just
// move it from "build-time import" to "first query".

declare global {
  var __arenaNextJsPostgresqlPool: Pool | undefined;
}

let cachedPool: Pool | undefined;
let cachedDb: NodePgDatabase | undefined;

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required at runtime. Set it in your environment " +
      "(e.g. via .env, or the deployment platform's secret manager) before " +
      "the server handles its first DB request. The env var is intentionally " +
      "not checked at module-load time so that `next build` succeeds on " +
      "machines that do not have DB credentials available. " +
      "Example format: postgresql://user:password@localhost:5432/dbname"
    );
  }
  return databaseUrl;
}

function getPool(): Pool {
  // Reuse the HMR-time globalThis cache in non-production so dev-server
  // hot-reloads don't leak Postgres sockets. Production never sets the
  // global because each Next.js worker is a fresh Node process anyway.
  if (process.env.NODE_ENV !== "production" && globalThis.__arenaNextJsPostgresqlPool) {
    cachedPool = globalThis.__arenaNextJsPostgresqlPool;
    return cachedPool;
  }
  if (cachedPool) return cachedPool;
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  if (process.env.NODE_ENV !== "production") {
    globalThis.__arenaNextJsPostgresqlPool = pool;
  }
  cachedPool = pool;
  return pool;
}

function getDb(): NodePgDatabase {
  if (cachedDb) return cachedDb;
  cachedDb = drizzle(getPool());
  return cachedDb;
}

/**
 * Lazy proxy over the drizzle wrapper. Every property access (including
 * `db.select`, `db.insert`, `db.update`, `db.delete`, `db.execute`,
 * `db.transaction`) is forwarded through `getDb()` so the pool isn't
 * materialised until a query actually runs.
 *
 * Method binding note: `Reflect.get(real, prop)` returns an unbound
 * function for things like `select`. We `.bind(real)` so calling
 * `db.select(...)` works the same way as on a plain drizzle handle — the
 * bound function still returns a query-builder that itself holds a
 * reference to the right drizzle instance.
 */
export const db = new Proxy({} as NodePgDatabase, {
  get(_target, prop, _receiver) {
    const real = getDb();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

/**
 * Lazy proxy over the pg.Pool, kept for any caller that destructures
 * `{ pool, db }` from this module. Same lazy semantics as `db`.
 */
export const pool = new Proxy({} as Pool, {
  get(_target, prop, _receiver) {
    const real = getPool();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
