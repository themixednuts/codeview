import { getRequestEvent } from '$app/server';
import { betterAuth, type DBFieldAttribute } from 'better-auth';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/d1';
import type { RequestEvent } from '@sveltejs/kit';
import { authRelations, authTables } from '$lib/server/db/auth-schema';

type AuthEnv = {
	AUTH_DB?: D1Database;
	BETTER_AUTH_SECRET?: string;
	BETTER_AUTH_URL?: string;
	GITHUB_OAUTH_CLIENT_ID?: string;
	GITHUB_OAUTH_CLIENT_SECRET?: string;
	GITHUB_ADMIN_LOGINS?: string;
};

export type AuthUser = {
	id: string;
	name: string;
	email: string;
	emailVerified: boolean;
	image?: string | null;
	githubLogin?: string | null;
};

export type AuthSession = {
	id: string;
	userId: string;
	expiresAt: Date;
	token?: string;
};

export type AuthState = {
	user: AuthUser | null;
	session: AuthSession | null;
	isAdmin: boolean;
	authConfigured: boolean;
	adminAllowlistConfigured: boolean;
};

export type ParseRequestActor = {
	provider: 'github';
	id: string;
	login: string;
	avatarUrl?: string;
};

const githubLoginField = {
	type: 'string',
	required: false,
} satisfies DBFieldAttribute;

export function authEnv(event: RequestEvent): AuthEnv {
	return ((event.platform as { env?: AuthEnv } | undefined)?.env ?? {}) as AuthEnv;
}

export function isAuthConfigured(env: AuthEnv): boolean {
	return Boolean(
		env.AUTH_DB &&
			env.BETTER_AUTH_SECRET &&
			env.BETTER_AUTH_URL &&
			env.GITHUB_OAUTH_CLIENT_ID &&
			env.GITHUB_OAUTH_CLIENT_SECRET,
	);
}

export function createAuth(event: RequestEvent) {
	const env = authEnv(event);
	if (!isAuthConfigured(env)) return null;

	return betterAuth(authOptions(env));
}

export async function handleAuthRequest(event: RequestEvent): Promise<Response> {
	const auth = createAuth(event);
	if (!auth) return new Response('GitHub OAuth is not configured', { status: 503 });
	return auth.handler(event.request);
}

export async function getAuthState(event: RequestEvent): Promise<AuthState> {
	const env = authEnv(event);
	const adminAllowlistConfigured = parseLoginAllowlist(env.GITHUB_ADMIN_LOGINS).size > 0;
	const auth = createAuth(event);
	if (!auth) {
		return {
			user: null,
			session: null,
			isAdmin: false,
			authConfigured: false,
			adminAllowlistConfigured,
		};
	}

	const response = await auth.api
		.getSession({ headers: event.request.headers })
		.catch(() => null);
	const user = normalizeUser(response?.user);
	return {
		user,
		session: normalizeSession(response?.session),
		isAdmin: isAdminUser(user, env),
		authConfigured: true,
		adminAllowlistConfigured,
	};
}

export async function getAuthStateFromRequest(
	request: Request,
	env: AuthEnv,
): Promise<AuthState> {
	const adminAllowlistConfigured = parseLoginAllowlist(env.GITHUB_ADMIN_LOGINS).size > 0;
	if (!isAuthConfigured(env)) {
		return {
			user: null,
			session: null,
			isAdmin: false,
			authConfigured: false,
			adminAllowlistConfigured,
		};
	}

	const auth = betterAuth(authOptions(env));
	const response = await auth.api.getSession({ headers: request.headers }).catch(() => null);
	const user = normalizeUser(response?.user);
	return {
		user,
		session: normalizeSession(response?.session),
		isAdmin: isAdminUser(user, env),
		authConfigured: true,
		adminAllowlistConfigured,
	};
}

export function actorFromUser(user: AuthUser | null): ParseRequestActor | undefined {
	if (!user?.githubLogin) return undefined;
	return {
		provider: 'github',
		id: user.id,
		login: user.githubLogin,
		avatarUrl: user.image ?? undefined,
	};
}

export function isAdminUser(user: AuthUser | null, env: AuthEnv): boolean {
	const login = user?.githubLogin?.trim().toLowerCase();
	if (!login) return false;
	return parseLoginAllowlist(env.GITHUB_ADMIN_LOGINS).has(login);
}

function authOptions(env: AuthEnv) {
	const db = drizzle(env.AUTH_DB!, { relations: authRelations });
	return {
		baseURL: env.BETTER_AUTH_URL,
		secret: env.BETTER_AUTH_SECRET,
		database: drizzleAdapter(db, {
			provider: 'sqlite',
			schema: authTables,
		}),
		experimental: {
			joins: true,
		},
		user: {
			additionalFields: {
				githubLogin: githubLoginField,
			},
		},
		account: {
			accountLinking: {
				trustedProviders: ['github'],
			},
		},
		socialProviders: {
			github: {
				clientId: env.GITHUB_OAUTH_CLIENT_ID!,
				clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET!,
				overrideUserInfoOnSignIn: true,
				mapProfileToUser: (profile: { login?: string }) => ({
					githubLogin: profile.login,
				}),
			},
		},
		advanced: {
			ipAddress: {
				ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'],
			},
		},
		plugins: [sveltekitCookies(getRequestEvent)],
	};
}

function normalizeUser(value: unknown): AuthUser | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== 'string' || typeof raw.email !== 'string') return null;
	return {
		id: raw.id,
		name: typeof raw.name === 'string' ? raw.name : '',
		email: raw.email,
		emailVerified: raw.emailVerified === true,
		image: typeof raw.image === 'string' ? raw.image : null,
		githubLogin: typeof raw.githubLogin === 'string' ? raw.githubLogin : null,
	};
}

function normalizeSession(value: unknown): AuthSession | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== 'string' || typeof raw.userId !== 'string') return null;
	const expiresAt = raw.expiresAt instanceof Date ? raw.expiresAt : new Date(String(raw.expiresAt));
	return {
		id: raw.id,
		userId: raw.userId,
		expiresAt,
		token: typeof raw.token === 'string' ? raw.token : undefined,
	};
}

function parseLoginAllowlist(raw: string | undefined): Set<string> {
	return new Set(
		(raw ?? '')
			.split(',')
			.map((entry) => entry.trim().toLowerCase())
			.filter(Boolean),
	);
}
