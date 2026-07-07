import type { CrateStatus } from '../provider';

export const PARSE_REQUEST_SCHEMA_VERSION = 1;
export const PARSE_STATUS_OBJECT_NAME = 'rust';

export type ParseRequestKind = 'crate' | 'sysroot';

export type ParseRequestSource = 'ui' | 'manual';

export type ParseRequestActor = {
	provider: 'github';
	id: string;
	login: string;
	avatarUrl?: string;
};

export type ParseRequestMessage = {
	schemaVersion: typeof PARSE_REQUEST_SCHEMA_VERSION;
	ecosystem: 'rust';
	kind: ParseRequestKind;
	name: string;
	version: string;
	force: boolean;
	requestId: string;
	requestedAt: string;
	source: ParseRequestSource;
	requestedBy?: ParseRequestActor;
};

export type ParseWorkflowParams = ParseRequestMessage & {
	callbackBaseUrl?: string;
};

export type ParseCompletionPayload = {
	schemaVersion: 1;
	kind?: ParseRequestKind;
	workflowId: string;
	requestId: string;
	name: string;
	version: string;
	ok: boolean;
	runId?: string;
	runUrl?: string;
	error?: string;
	completedAt: string;
};

export type StoredParseStatus = CrateStatus & {
	ecosystem: 'rust';
	kind: ParseRequestKind;
	name: string;
	version: string;
	requestId?: string;
	workflowId?: string;
	githubRunId?: string;
	githubRunUrl?: string;
	requestedBy?: ParseRequestActor;
	createdAt: string;
	updatedAt: string;
	sequence: number;
};

export type ParseQueueSnapshot = {
	active: StoredParseStatus[];
	recent: StoredParseStatus[];
};

export type BeginParseResponse = {
	accepted: boolean;
	leased: boolean;
	workflowId: string;
	retryAfterSeconds?: number;
	status: StoredParseStatus;
};

export type ParseStatusEvent = {
	kind?: ParseRequestKind;
	name: string;
	version: string;
	status: CrateStatus['status'];
	step?: string;
	error?: string;
	action?: CrateStatus['action'];
	requestId?: string;
	workflowId?: string;
	githubRunId?: string;
	githubRunUrl?: string;
	requestedBy?: ParseRequestActor;
};

export function crateStatusTag(name: string, version: string): string {
	return `rust:${name}:${version}`;
}

export function parseStatusObject(namespace: DurableObjectNamespace): DurableObjectStub {
	const id = namespace.idFromName(PARSE_STATUS_OBJECT_NAME);
	return namespace.get(id);
}

export function parseWorkflowId(requestId: string): string {
	return `parse-${requestId}`;
}

export function makeParseRequest(
	name: string,
	version: string,
	force: boolean,
	source: ParseRequestSource = 'ui',
	kind: ParseRequestKind = 'crate',
	requestedBy?: ParseRequestActor,
): ParseRequestMessage {
	const requestId =
		typeof crypto !== 'undefined' && 'randomUUID' in crypto
			? crypto.randomUUID()
			: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	return {
		schemaVersion: PARSE_REQUEST_SCHEMA_VERSION,
		ecosystem: 'rust',
		kind,
		name,
		version,
		force,
		requestId,
		requestedAt: new Date().toISOString(),
		source,
		requestedBy,
	};
}

export function isParseRequestMessage(value: unknown): value is ParseRequestMessage {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<ParseRequestMessage>;
	return (
		candidate.schemaVersion === PARSE_REQUEST_SCHEMA_VERSION &&
		candidate.ecosystem === 'rust' &&
		(candidate.kind === 'crate' || candidate.kind === 'sysroot') &&
		typeof candidate.name === 'string' &&
		candidate.name.length > 0 &&
		typeof candidate.version === 'string' &&
		candidate.version.length > 0 &&
		typeof candidate.force === 'boolean' &&
		typeof candidate.requestId === 'string' &&
		candidate.requestId.length > 0 &&
		typeof candidate.requestedAt === 'string' &&
		(candidate.source === 'ui' || candidate.source === 'manual') &&
		(candidate.requestedBy === undefined || isParseRequestActor(candidate.requestedBy))
	);
}

function isParseRequestActor(value: unknown): value is ParseRequestActor {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<ParseRequestActor>;
	return (
		candidate.provider === 'github' &&
		typeof candidate.id === 'string' &&
		candidate.id.length > 0 &&
		typeof candidate.login === 'string' &&
		candidate.login.length > 0 &&
		(candidate.avatarUrl === undefined || typeof candidate.avatarUrl === 'string')
	);
}
