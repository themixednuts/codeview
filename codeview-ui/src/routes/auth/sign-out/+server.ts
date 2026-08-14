import { authEnv, isAuthConfigured, signOutCurrentSession } from "#lib/server/auth.js";
import { safeReturnPath } from "#lib/server/safe-return.js";
import { error, redirect } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
  if (!isAuthConfigured(authEnv(event))) error(503, "Authentication is not configured");

  const form = await event.request.formData();
  await signOutCurrentSession(event);
  redirect(303, safeReturnPath(form.get("returnTo")));
};
