// Storage entry point. Other folders use the interfaces in ./types.ts; only bootstrap opens the db.

export { backupDatabase } from './backup.ts'
export { MIGRATIONS_FOLDER, openDb } from './db.ts'
