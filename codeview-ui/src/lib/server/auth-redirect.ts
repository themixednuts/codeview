export const GITHUB_OAUTH_ORIGIN = "https://github.com";

/** 303 that keeps Better Auth's Set-Cookie headers on the way out. */
export function redirectWithCookies(location: string, setCookies: readonly string[]): Response {
  const headers = new Headers({ Location: location });
  for (const cookie of setCookies) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(null, { status: 303, headers });
}

/** Send the browser to GitHub's OAuth authorize page. */
export function redirectToGithubOAuth(url: string, setCookies: readonly string[]): Response {
  const parsed = new URL(url);
  if (parsed.origin !== GITHUB_OAUTH_ORIGIN) {
    throw new Error("Cannot redirect to external URL unless explicitly allowed");
  }
  return redirectWithCookies(url, setCookies);
}
