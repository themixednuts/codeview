import { describe, expect, it } from "vite-plus/test";
import { getTableColumns } from "drizzle-orm";
import { account } from "./auth-schema";

describe("auth account schema", () => {
  it("stores Better Auth 1.7 issuer so OAuth callback can look up accounts", () => {
    const columns = getTableColumns(account);
    expect(columns.issuer).toBeDefined();
    expect(columns.issuer.name).toBe("issuer");
    expect(columns.issuer.notNull).toBe(true);
  });
});
