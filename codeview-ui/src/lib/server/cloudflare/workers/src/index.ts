// Cloudflare Worker entrypoint for Durable Objects and Workflows.
// Deployed as a separate worker ("codeview-services") and referenced
// via script_name from the main SvelteKit worker.

import { setupLogging } from '$lib/log';

await setupLogging();

export { GraphStore } from '$cloudflare/graph-store';
export { CrateRegistry } from '$cloudflare/crate-registry';
export { ParseCrateWorkflow } from '$cloudflare/workflows/parse-crate';

// Default fetch handler (required by Workers runtime, but all traffic
// goes through the SvelteKit worker — this is only the DO host).
export default {
	async fetch() {
		return new Response('codeview-workers: not a public endpoint', { status: 404 });
	}
};
