/**
 * Streaming rustdoc JSON parser module.
 *
 * Provides streaming parsing of large rustdoc JSON files for use within
 * Cloudflare Workers' CPU time limits.
 */

export {
	createRustdocJsonParser,
	processParsedElement,
	createParseState,
	parseRustdocStream,
	parseRustdocByteStream,
	parseRustdocResponse,
	type StreamingParseCallbacks,
	type ParseState,
	type ParsedElementInfo
} from './parser';

export {
	StreamingGraphBuilder,
	createStreamingGraphBuilder,
	DEFAULT_BATCH_SIZE,
	type BuilderCheckpoint,
	type BatchCallbacks
} from './builder';
