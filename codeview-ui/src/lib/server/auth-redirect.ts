import { redirect } from "@sveltejs/kit";

export const GITHUB_OAUTH_ORIGIN = "https://github.com";

/** Send the browser to GitHub's OAuth authorize page. */
export function redirectToGithubOAuth(url: string): never {
  redirect(303, url, { external: [GITHUB_OAUTH_ORIGIN] });
}
