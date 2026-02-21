import type { HandleClientError } from '@sveltejs/kit';
import { getLogger, setupLogging } from '$lib/log';

const log = getLogger('client-hooks');

export async function init() {
	await setupLogging();
}

export const handleError: HandleClientError = ({ error, event, status, message }) => {
	log.error`navigation error status=${String(status)} url=${event.url.toString()} message=${message} error=${String(error)}`;

	return { message };
};
