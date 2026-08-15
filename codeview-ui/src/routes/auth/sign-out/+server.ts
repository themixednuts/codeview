import { authEnv, isAuthConfigured, signOutCurrentSession } from "#lib/server/auth.js";
import { redirectWithCookies } from "#lib/server/auth-redirect.js";
import { safeReturnPath } from "#lib/server/safe-return.js";
import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
  if (!isAuthConfigured(authEnv(event))) error(503, "Authentication is not configured");

  const form = await event.request.formData();
  const setCookies = await signOutCurrentSession(event);
  return redirectWithCookies(safeReturnPath(form.get("returnTo")), setCookies);
};
