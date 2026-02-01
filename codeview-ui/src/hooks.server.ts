import type { Handle } from '@sveltejs/kit';
import { setupLogging } from '$lib/log';

await setupLogging();

export const handle: Handle = async ({ event, resolve }) => {
	return resolve(event);
};
