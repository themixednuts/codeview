import {
  BetterAuth,
  type BetterAuthInstance,
  type BetterAuthProps,
} from "@alchemy.run/better-auth";
import { Drizzle as BetterAuthDrizzle } from "@alchemy.run/better-auth/Drizzle";
import { RuntimeContext, type BaseRuntimeContext } from "alchemy";
import type { RequestEvent } from "@sveltejs/kit";
import { drizzle } from "drizzle-orm/d1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type * as Scope from "effect/Scope";
import type { DBFieldAttribute } from "better-auth";
import { authRelations, authTables } from "#lib/server/db/auth-schema.js";

export type AuthEnv = {
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
  provider: "github";
  id: string;
  login: string;
  avatarUrl?: string;
};

const githubLoginField = {
  type: "string",
  required: false,
} satisfies DBFieldAttribute;

const AuthUserFields = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
  email: Schema.String,
  emailVerified: Schema.optionalKey(Schema.Boolean),
  image: Schema.optionalKey(Schema.NullOr(Schema.String)),
  githubLogin: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const ExpiresAt = Schema.Union([Schema.instanceOf(Date), Schema.String, Schema.Number]);

const AuthSessionFields = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  expiresAt: ExpiresAt,
  token: Schema.optionalKey(Schema.String),
});

type GithubProfile = {
  login?: string;
};

type CodeviewAuth = BetterAuthInstance<ReturnType<typeof authProps>>;

export function authEnv(event: RequestEvent): AuthEnv {
  return event.platform?.env ?? {};
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

export function handleAuthRequest(event: RequestEvent): Promise<Response> {
  const env = authEnv(event);
  if (!isAuthConfigured(env)) {
    return Promise.resolve(new Response("GitHub OAuth is not configured", { status: 503 }));
  }
  return runAuth(event.request, env, (auth) =>
    auth.fetch.pipe(Effect.map((response) => HttpServerResponse.toWeb(response))),
  );
}

export function getAuthState(event: RequestEvent): Promise<AuthState> {
  return getAuthStateFromRequest(event.request, authEnv(event));
}

export async function getAuthStateFromRequest(request: Request, env: AuthEnv): Promise<AuthState> {
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

  const session = await runAuth(request, env, (auth) => auth.getSession());
  const user = normalizeUser(session?.user);
  return {
    user,
    session: normalizeSession(session?.session),
    isAdmin: isAdminUser(user, env),
    authConfigured: true,
    adminAllowlistConfigured,
  };
}

const SignInSocialResult = Schema.Struct({
  url: Schema.optionalKey(Schema.String),
});

export function signInWithGithub(
  event: RequestEvent,
  callbackURL: string,
): Promise<{ url: string | undefined; setCookies: string[] }> {
  const env = authEnv(event);
  if (!isAuthConfigured(env)) {
    return Promise.reject(new Error("GitHub OAuth is not configured"));
  }
  return runAuth(event.request, env, (auth) =>
    Effect.gen(function* () {
      const instance = yield* auth.auth;
      const result = yield* Effect.tryPromise({
        try: () =>
          instance.api.signInSocial({
            body: { provider: "github", callbackURL },
            headers: event.request.headers,
            asResponse: true,
          }),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error("GitHub sign-in failed", { cause }),
      });
      const response = yield* requireAuthResponse(result);
      const payload = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error("GitHub sign-in returned invalid JSON", { cause }),
      });
      const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(SignInSocialResult)(payload));
      return {
        url: decoded?.url,
        setCookies: response.headers.getSetCookie(),
      };
    }),
  );
}

export function signOutCurrentSession(event: RequestEvent): Promise<string[]> {
  const env = authEnv(event);
  if (!isAuthConfigured(env)) {
    return Promise.reject(new Error("GitHub OAuth is not configured"));
  }
  return runAuth(event.request, env, (auth) =>
    Effect.gen(function* () {
      const instance = yield* auth.auth;
      const result = yield* Effect.tryPromise({
        try: () =>
          instance.api.signOut({
            headers: event.request.headers,
            asResponse: true,
          }),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error("Sign-out failed", { cause }),
      });
      const response = yield* requireAuthResponse(result);
      return response.headers.getSetCookie();
    }),
  );
}

export function actorFromUser(user: AuthUser | null): ParseRequestActor | undefined {
  if (!user?.githubLogin) return undefined;
  return {
    provider: "github",
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

function authProps(env: AuthEnv): BetterAuthProps {
  // SAFETY: isAuthConfigured already required these secrets and the D1 binding.
  const secret = env.BETTER_AUTH_SECRET!;
  const githubClientId = env.GITHUB_OAUTH_CLIENT_ID!;
  const githubClientSecret = env.GITHUB_OAUTH_CLIENT_SECRET!;
  return {
    migrate: false,
    secret: Redacted.make(secret),
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    user: {
      additionalFields: {
        githubLogin: githubLoginField,
      },
    },
    account: {
      accountLinking: {
        trustedProviders: ["github"],
      },
    },
    socialProviders: {
      github: {
        clientId: githubClientId,
        clientSecret: githubClientSecret,
        overrideUserInfoOnSignIn: true,
        mapProfileToUser: (profile: GithubProfile) => ({
          githubLogin: profile.login,
        }),
      },
    },
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
      },
    },
  };
}

function databaseLayer(env: AuthEnv) {
  // SAFETY: isAuthConfigured already required AUTH_DB before this runs.
  const db = drizzle(env.AUTH_DB!, { relations: authRelations });
  // SAFETY: drizzle() returns a class instance; Better Auth's Drizzle layer types the client as Record.
  return BetterAuthDrizzle(db as never, {
    provider: "sqlite",
    schema: authTables,
  });
}

function kitRuntimeContext(env: AuthEnv): BaseRuntimeContext {
  return {
    Type: "SvelteKit",
    id: "codeview-website",
    env,
    get: (key): Effect.Effect<never> => {
      // SAFETY: Better Auth RuntimeContext.get is typed never; AuthEnv is a Worker binding bag indexed by the string names Alchemy injects.
      return Effect.succeed(env[key as keyof AuthEnv] as never);
    },
    set: (id) => Effect.succeed(id),
  };
}

function requireAuthResponse(result: unknown): Effect.Effect<Response, Error> {
  if (result instanceof Response) return Effect.succeed(result);
  return Effect.fail(new Error("Better Auth did not return a Response"));
}

function runAuth<A, E>(
  request: Request,
  env: AuthEnv,
  body: (
    auth: CodeviewAuth,
  ) => Effect.Effect<A, E, RuntimeContext | HttpServerRequest.HttpServerRequest | Scope.Scope>,
): Promise<A> {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const auth = yield* BetterAuth(authProps(env));
      return yield* body(auth);
    }).pipe(
      Effect.provide(databaseLayer(env)),
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
      Effect.provide(Layer.succeed(RuntimeContext, kitRuntimeContext(env))),
    ),
  );
  return Effect.runPromise(program, { signal: request.signal });
}

type AuthUserInput = typeof AuthUserFields.Encoded;
type AuthSessionInput = typeof AuthSessionFields.Encoded;

function normalizeUser(value: AuthUserInput | null | undefined): AuthUser | null {
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(AuthUserFields)(value));
  if (!decoded) return null;
  return {
    id: decoded.id,
    name: decoded.name ?? "",
    email: decoded.email,
    emailVerified: decoded.emailVerified === true,
    image: decoded.image ?? null,
    githubLogin: decoded.githubLogin ?? null,
  };
}

function normalizeSession(value: AuthSessionInput | null | undefined): AuthSession | null {
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(AuthSessionFields)(value));
  if (!decoded) return null;
  const expiresAt =
    decoded.expiresAt instanceof Date ? decoded.expiresAt : new Date(decoded.expiresAt);
  return {
    id: decoded.id,
    userId: decoded.userId,
    expiresAt,
    token: decoded.token,
  };
}

function parseLoginAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}
