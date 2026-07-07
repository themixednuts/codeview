import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const WORKER_PATH = join(process.cwd(), '.svelte-kit', 'cloudflare', '_worker.js');
const HARDENING_MARKER = 'class CachedImmutableAsset extends WorkerEntrypoint';

const IMPORT_BEFORE = 'import { env } from "cloudflare:workers";';
const IMPORT_AFTER = 'import { WorkerEntrypoint, env } from "cloudflare:workers";';

const WORKER_DEFAULT_MARKER = 'var worker_default = {';
const HELPERS = `function withCacheControl(response, value) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", value);
  headers.set("Cloudflare-CDN-Cache-Control", value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
function hasCredentialHeaders(request) {
  return request.headers.has("Cookie") || request.headers.has("Authorization");
}
function withoutCredentialHeaders(request) {
  if (!hasCredentialHeaders(request)) return request;
  const headers = new Headers(request.headers);
  headers.delete("Cookie");
  headers.delete("Authorization");
  return new Request(request, { headers });
}
export class CachedImmutableAsset extends WorkerEntrypoint {
  async fetch(req) {
    const res = await this.env.ASSETS.fetch(withoutCredentialHeaders(req));
    return res.ok ? res : withCacheControl(res, "no-store");
  }
}
`;

const CACHE_READ_BEFORE = `let pragma = req.headers.get("cache-control") || "";
    let res = !pragma.includes("no-cache") && await r2(req);`;
const CACHE_READ_AFTER = `const credentialedRequest = hasCredentialHeaders(req);
    let pragma = req.headers.get("cache-control") || "";
    let res = !credentialedRequest && !pragma.includes("no-cache") && await r2(req);`;

const ASSET_FETCH_BEFORE = `if (is_static_asset || prerendered.has(pathname) || pathname === version_file || pathname.startsWith(immutable)) {
      res = await env2.ASSETS.fetch(req);
    }`;
const ASSET_FETCH_AFTER = `if (pathname.startsWith(immutable)) {
      res = await ctx.exports.CachedImmutableAsset.fetch(withoutCredentialHeaders(req));
    } else if (is_static_asset || prerendered.has(pathname) || pathname === version_file) {
      res = await env2.ASSETS.fetch(req);
      if (pathname === version_file || pathname === "/service-worker.js") {
        res = withCacheControl(res, "no-store");
      }
    }`;

const CACHE_WRITE_BEFORE = 'return pragma && res.status < 400 ? c(req, res, ctx) : res;';
const CACHE_WRITE_AFTER =
	'return !credentialedRequest && pragma && res.status < 400 && !res.headers.has("Set-Cookie") ? c(req, res, ctx) : res;';

let source = await readFile(WORKER_PATH, 'utf8');
if (source.includes(HARDENING_MARKER)) {
	console.log('Cloudflare worker hardening already applied');
	process.exit(0);
}

source = replaceOnce(source, IMPORT_BEFORE, IMPORT_AFTER);
source = replaceOnce(source, WORKER_DEFAULT_MARKER, `${HELPERS}${WORKER_DEFAULT_MARKER}`);
source = replaceOnce(source, CACHE_READ_BEFORE, CACHE_READ_AFTER);
source = replaceOnce(source, ASSET_FETCH_BEFORE, ASSET_FETCH_AFTER);
source = replaceOnce(source, CACHE_WRITE_BEFORE, CACHE_WRITE_AFTER);

await writeFile(WORKER_PATH, source);
console.log('Applied Cloudflare worker cache hardening');

function replaceOnce(source: string, before: string, after: string): string {
	if (!source.includes(before)) {
		throw new Error(`Cloudflare worker hardening failed: missing marker ${JSON.stringify(before)}`);
	}
	return source.replace(before, after);
}
