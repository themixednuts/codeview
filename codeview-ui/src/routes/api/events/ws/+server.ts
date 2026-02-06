import type { RequestHandler } from './$types';
import { handleWsUpgrade } from '$provider';

export const GET: RequestHandler = (event) => handleWsUpgrade(event);
