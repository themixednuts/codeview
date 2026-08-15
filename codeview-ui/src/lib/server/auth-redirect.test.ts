import { describe, expect, it } from "vite-plus/test";
import { isRedirect } from "@sveltejs/kit";
import { redirectToGithubOAuth } from "./auth-redirect";

describe("redirectToGithubOAuth", () => {
  it("allows GitHub's OAuth authorize URL", () => {
    const url = "https://github.com/login/oauth/authorize?client_id=example";
    try {
      redirectToGithubOAuth(url);
      throw new Error("expected a SvelteKit redirect");
    } catch (error) {
      expect(isRedirect(error)).toBe(true);
      if (!isRedirect(error)) return;
      expect(error.status).toBe(303);
      expect(error.location).toBe(url);
    }
  });

  it("rejects a non-GitHub origin", () => {
    expect(() => redirectToGithubOAuth("https://evil.example/login")).toThrow(/external/);
  });
});
