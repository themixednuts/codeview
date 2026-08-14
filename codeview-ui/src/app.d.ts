import type { WebsiteEnv } from '../alchemy.run.ts';
import type { AuthSession, AuthState, AuthUser } from '#lib/server/auth';

declare global {
	namespace App {
		interface Locals {
			auth: AuthState;
			user: AuthUser | null;
			session: AuthSession | null;
		}

		interface Platform {
			env?: WebsiteEnv;
			server?: {
				upgrade(request: Request, options?: { data?: unknown }): boolean;
			};
		}
	}
}

declare module '$env/static/public' {
	export const PUBLIC_CODEVIEW_PLATFORM: string;
}

export {};
