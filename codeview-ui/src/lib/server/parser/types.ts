import type { Node, Edge } from '$lib/graph';

export interface ParseResult {
	graph: CrateGraphData;
	externalCrates: ExternalCrateData[];
}

export interface CrateGraphData {
	id: string;
	name: string;
	version: string;
	nodes: Node[];
	edges: Edge[];
}

export interface ExternalCrateData {
	id: string;
	name: string;
	version?: string | null;
	nodes: Node[];
}

/** A map of relative file paths to their source content. */
export type SourceFiles = Map<string, string>;

export interface ParserAdapter {
	/**
	 * Parse a raw artifact (e.g. rustdoc JSON) into a crate graph.
	 * If sourceFiles is provided, the parser can extract call edges from source code.
	 */
	parse(
		artifact: Uint8Array | string,
		name: string,
		version: string,
		sourceFiles?: SourceFiles
	): Promise<ParseResult>;
}
