import { TaggedError } from 'better-result';

/** Network/HTTP fetch failure. */
export class FetchError extends TaggedError('FetchError')<{
	url: string;
	status: number;
	statusText: string;
}>() {}

/** Package not found in the registry. */
export class RegistryNotFoundError extends TaggedError('RegistryNotFoundError')<{
	name: string;
	version: string;
}>() {}

/** JSON.parse or JSON.stringify failure. */
export class JsonParseError extends TaggedError('JsonParseError')<{
	message: string;
	cause?: unknown;
}>() {}

/** Unknown ecosystem requested. */
export class UnsupportedEcosystemError extends TaggedError('UnsupportedEcosystemError')<{
	ecosystem: string;
	adapterKind: string;
}>() {}

/** Input validation failure. */
export class ValidationError extends TaggedError('ValidationError')<{
	message: string;
}>() {}

/** Feature or resource not available. */
export class NotAvailableError extends TaggedError('NotAvailableError')<{
	message: string;
}>() {}

/** Workflow step exhausted retries. */
export class WorkflowStepError extends TaggedError('WorkflowStepError')<{
	message: string;
	failedStep: string;
}>() {}

/** Rate limit exceeded. */
export class RateLimitError extends TaggedError('RateLimitError')<{
	message: string;
}>() {}

/** Source fetch exceeded size limit. */
export class SourceOverLimitError extends TaggedError('SourceOverLimitError')<{
	message: string;
}>() {}
