import { PUBLIC_CODEVIEW_PLATFORM } from "$app/env/public";

/** Build-time platform identifier — 'cloudflare' | 'local' etc. */
export const platform = PUBLIC_CODEVIEW_PLATFORM;

/** True when built for a hosted platform (Cloudflare, Vercel, etc.) */
export const isHosted = platform === "cloudflare";
