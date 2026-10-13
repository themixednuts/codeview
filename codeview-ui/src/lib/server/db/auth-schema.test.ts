import { describe, expect, it } from "vite-plus/test";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getTableColumns } from "drizzle-orm";
import { account, authTables, authUserAdditionalFields } from "./auth-schema";

describe("auth schema", () => {
  // Better Auth validates the Drizzle schema on every request and throws when it
  // disagrees, so a mismatch after an upgrade turns every page into a 500.
  it("passes Better Auth's schema check", async () => {
    const auth = betterAuth({
      secret: "test-secret-at-least-32-characters-long",
      baseURL: "http://localhost",
      // SAFETY: the schema check introspects `schema`, never the client, so no database is needed.
      database: drizzleAdapter({} as never, { provider: "sqlite", schema: authTables }),
      user: { additionalFields: authUserAdditionalFields },
    });
    const { explicitSchemaCheck } = await auth.$context;
    expect(explicitSchemaCheck).toBeDefined();
    await expect(explicitSchemaCheck?.()).resolves.toBeUndefined();
  });

  it("drops the issuer column that only Better Auth 1.7.0-1.7.2 needed", () => {
    expect(getTableColumns(account)).not.toHaveProperty("issuer");
  });
});
