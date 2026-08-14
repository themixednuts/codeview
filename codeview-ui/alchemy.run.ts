import * as Alchemy from 'alchemy';
import * as Cloudflare from 'alchemy/Cloudflare';
import { Stage } from 'alchemy/Stage';
import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';

const compatibilityDate = '2026-08-14';
const parserScriptName = 'codeview-parser';

export const AuthDb = Cloudflare.D1.Database('AuthDb', {
	name: 'codeview-auth',
	migrationsDir: './src/lib/server/db/auth-migrations',
});

export const CrateGraphs = Cloudflare.R2.Bucket('CrateGraphs', {
	name: 'crate-graphs',
});

export const ParseRequests = Cloudflare.Queues.Queue('ParseRequests', {
	name: 'codeview-parse-requests',
});

export const ParseDeadLetters = Cloudflare.Queues.Queue('ParseDeadLetters', {
	name: 'codeview-parse-dead',
});

export const Parser = Cloudflare.Worker('Parser', {
	name: parserScriptName,
	main: './src/parse-worker.ts',
	compatibility: { date: compatibilityDate },
	env: {
		CRATE_GRAPHS: CrateGraphs,
		PARSE_REQUESTS: ParseRequests,
		PARSE_STATUS: Cloudflare.DurableObject('PARSE_STATUS', {
			className: 'ParseStatusDurableObject',
		}),
		PARSE_WORKFLOW: Cloudflare.Workflow('PARSE_WORKFLOW', {
			className: 'ParseCrateWorkflow',
		}),
		GITHUB_REPO: 'themixednuts/codeview',
		GITHUB_REF: 'main',
		GITHUB_WORKFLOW_FILE: 'parse.yml',
		PARSE_CALLBACK_BASE_URL: 'https://codeview-parser.jonfonts.workers.dev',
		PLAN_DRAIN_ACTIVE_TARGET: '4',
		PLAN_DRAIN_BATCH_SIZE: '0',
		PARSE_DISPATCH_BURST: '4',
		PARSE_DISPATCH_REFILL_SECONDS: '45',
		DOCSRS_PARSE_BURST: '4',
		DOCSRS_PARSE_REFILL_SECONDS: '20',
		SYSROOT_PARSE_BURST: '1',
		SYSROOT_PARSE_REFILL_SECONDS: '600',
		GITHUB_TOKEN: Config.redacted('GITHUB_TOKEN'),
		PARSE_CALLBACK_SECRET: Config.redacted('PARSE_CALLBACK_SECRET'),
	},
});

export const Website = Cloudflare.Website.SvelteKit(
	'Website',
	Effect.gen(function* () {
		const stage = yield* Stage;
		return {
			name: `codeview-website-${stage}`,
			domain: 'codeview.codes',
			compatibility: { date: compatibilityDate },
			env: {
				AUTH_DB: AuthDb,
				CRATE_GRAPHS: CrateGraphs,
				PARSE_REQUESTS: ParseRequests,
				PARSE_STATUS: Cloudflare.DurableObject('PARSE_STATUS', {
					className: 'ParseStatusDurableObject',
					scriptName: parserScriptName,
				}),
				BETTER_AUTH_URL: 'https://codeview.codes',
				GITHUB_OAUTH_CLIENT_ID: 'Ov23liaAIxx0Vmp8F0zE',
				GITHUB_ADMIN_LOGINS: 'themixednuts',
				GITHUB_REPO: 'themixednuts/codeview',
				GITHUB_REF: 'main',
				GITHUB_WORKFLOW_FILE: 'parse.yml',
				PLAN_DRAIN_ACTIVE_TARGET: '4',
				PLAN_DRAIN_BATCH_SIZE: '0',
				GITHUB_ACTIONS_REPO_USAGE_TARGET_PERCENT: '35',
				BETTER_AUTH_SECRET: Config.redacted('BETTER_AUTH_SECRET'),
				GITHUB_OAUTH_CLIENT_SECRET: Config.redacted('GITHUB_OAUTH_CLIENT_SECRET'),
			},
		};
	}),
);

export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>;
export type ParserEnv = Cloudflare.InferEnv<typeof Parser>;

export default Alchemy.Stack(
	'Codeview',
	{
		providers: Cloudflare.providers(),
		state: Cloudflare.state(),
	},
	Effect.gen(function* () {
		const website = yield* Website;
		const parser = yield* Parser;
		const parseRequests = yield* ParseRequests;
		yield* ParseDeadLetters;
		yield* Cloudflare.Queues.Consumer('ParseConsumer', {
			queueId: parseRequests.queueId,
			scriptName: parser.workerName,
			deadLetterQueue: 'codeview-parse-dead',
			settings: {
				batchSize: 10,
				maxRetries: 3,
				maxWaitTimeMs: 5000,
			},
		});
		return { url: website.url, parser: parser.url };
	}),
);
