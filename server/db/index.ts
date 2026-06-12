import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { Database } from 'bun:sqlite'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import * as schema from './schema'
import { initializeFulcrumDirectories, getDatabasePath } from '../lib/settings'
import { log } from '../lib/logger'
import { encryptExistingDbSecrets } from './encrypt-at-rest'

// Use globalThis to ensure singleton across multiple module instances
// (Bun test runner can sometimes create duplicate module instances)
const GLOBAL_KEY = '__FULCRUM_DB_SINGLETON__'

interface DbSingleton {
  db: BunSQLiteDatabase<typeof schema> | null
  sqlite: Database | null
}

function getGlobalState(): DbSingleton {
  if (!(globalThis as Record<string, unknown>)[GLOBAL_KEY]) {
    ;(globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      db: null,
      sqlite: null,
    }
  }
  return (globalThis as Record<string, unknown>)[GLOBAL_KEY] as DbSingleton
}

// Initialize and return the database (lazy initialization)
function initializeDatabase(): BunSQLiteDatabase<typeof schema> {
  const state = getGlobalState()

  if (state.db) return state.db

  // Initialize all fulcrum directories (data dir, worktrees, etc.)
  initializeFulcrumDirectories()

  const dbPath = getDatabasePath()

  state.sqlite = new Database(dbPath)

  // Enable WAL mode for better performance
  state.sqlite.exec('PRAGMA journal_mode = WAL')

  state.db = drizzle(state.sqlite, { schema })

  // Run migrations (works for both source and bundled mode)
  runMigrations(state.sqlite, state.db)

  // Encrypt any plaintext secret columns from before field-level
  // encryption existed. No-op without a key or when everything is
  // already encrypted.
  encryptExistingDbSecrets(state.sqlite)

  return state.db
}

// Export a proxy that lazily initializes the database on first access
// This allows tests to set FULCRUM_DIR before the database is initialized
export const db = new Proxy({} as BunSQLiteDatabase<typeof schema>, {
  get(_, prop) {
    const instance = initializeDatabase()
    const value = instance[prop as keyof typeof instance]
    if (typeof value === 'function') {
      return value.bind(instance)
    }
    return value
  },
})

// For testing: reset the database instance so a new one can be created
export function resetDatabase(): void {
  const state = getGlobalState()

  if (state.sqlite) {
    state.sqlite.close()
  }
  state.db = null
  state.sqlite = null
}

// For testing: get the underlying SQLite instance
export function getSqlite(): Database | null {
  return getGlobalState().sqlite
}

// Run migrations (works for both source and bundled mode)
function runMigrations(_sqlite: Database, drizzleDb: BunSQLiteDatabase<typeof schema>): void {
  let migrationsPath: string

  if (process.env.FULCRUM_PACKAGE_ROOT) {
    migrationsPath = join(process.env.FULCRUM_PACKAGE_ROOT, 'drizzle')
  } else {
    const serverDir = dirname(import.meta.dir)
    const projectRoot = dirname(serverDir)
    migrationsPath = join(projectRoot, 'drizzle')
  }

  if (!existsSync(migrationsPath)) {
    log.db.warn('Migrations folder not found', { migrationsPath })
    return
  }

  migrate(drizzleDb, { migrationsFolder: migrationsPath })
}

// Re-export schema for convenience
export * from './schema'
