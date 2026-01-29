import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	dialect: 'sqlite',
	driver: 'durable-sqlite',
	out: './drizzle',
	schema: './src/lib/server/db/schema.ts'
});
