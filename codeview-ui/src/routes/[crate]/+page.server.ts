import { error, redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { isValidCrateNameParam } from "#lib/crate-ref.js";

// `/serde` has no page of its own; send it to the newest version, which the
// explorer layout then resolves to a concrete semver.
export const load: PageServerLoad = ({ params, url }) => {
  if (!isValidCrateNameParam(params.crate)) error(404, "Crate not found");
  redirect(307, `/${params.crate}/latest${url.search}`);
};
