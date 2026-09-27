// drizzle-kit configuration (https://orm.drizzle.team/docs/drizzle-config-file). A plain object
// instead of `defineConfig` so no file outside core/src/storage imports drizzle-kit (R-4).
// Generate a migration after a schema change: `bunx drizzle-kit generate --name=<slug>`.

export default {
  dialect: 'sqlite',
  schema: './src/storage/schema.ts',
  out: './drizzle',
}
