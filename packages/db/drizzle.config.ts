import { defineConfig } from 'drizzle-kit'

// `bun run db:generate` writes SQL migrations to ./drizzle from the schema; `bun run db:migrate`
// applies them. Never hand-write or edit the generated files.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema/*.ts',
  out: './drizzle',
})
