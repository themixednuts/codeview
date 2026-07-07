import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	dialect: 'sqlite',
	out: './src/lib/server/db/auth-migrations',
	schema: './src/lib/server/db/auth-schema.ts',
	breakpoints: true,
});
