import { authEnv, isAuthConfigured, signInWithGithub } from "#lib/server/auth.js";
import { redirectToGithubOAuth } from "#lib/server/auth-redirect.js";
import { safeReturnPath } from "#lib/server/safe-return.js";
import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
  if (!isAuthConfigured(authEnv(event))) error(503, "GitHub sign-in is not configured");

  const form = await event.request.formData();
  const callbackURL = safeReturnPath(form.get("returnTo"));
  const result = await signInWithGithub(event, callbackURL);

  if (!result.url) error(502, "GitHub sign-in did not return a redirect");
  redirectToGithubOAuth(result.url);
};
