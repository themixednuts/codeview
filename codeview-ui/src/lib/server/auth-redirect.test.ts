import { describe, expect, it } from "vite-plus/test";
import { redirectToGithubOAuth, redirectWithCookies } from "./auth-redirect";

describe("redirectToGithubOAuth", () => {
  it("returns a 303 that keeps Set-Cookie headers", () => {
    const url = "https://github.com/login/oauth/authorize?client_id=example";
    const cookies = [
      "better-auth.oauth_state=abc; Path=/; HttpOnly; Secure; SameSite=Lax",
      "better-auth.state=def; Path=/; HttpOnly; Secure; SameSite=Lax",
    ];
    const response = redirectToGithubOAuth(url, cookies);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(url);
    expect(response.headers.getSetCookie()).toEqual(cookies);
  });

  it("rejects a non-GitHub origin", () => {
    expect(() => redirectToGithubOAuth("https://evil.example/login", [])).toThrow(/external/);
  });
});

describe("redirectWithCookies", () => {
  it("copies every Set-Cookie onto a same-origin 303", () => {
    const cookies = ["better-auth.session_token=; Path=/; Max-Age=0"];
    const response = redirectWithCookies("/queue", cookies);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/queue");
    expect(response.headers.getSetCookie()).toEqual(cookies);
  });
});
