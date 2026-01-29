export interface ParseResult {
	graph: CrateGraphData;
	externalCrates: ExternalCrateData[];
}

export interface CrateGraphData {
	id: string;
	name: string;
	version: string;
	nodes: unknown[];
	edges: unknown[];
}

export interface ExternalCrateData {
	id: string;
	name: string;
	nodes: unknown[];
}

/** A map of relative file paths to their source content. */
export type SourceFiles = Map<string, string>;

export interface ParserAdapter {
	/**
	 * Parse a raw artifact (e.g. rustdoc JSON) into a crate graph.
	 * If sourceFiles is provided, the parser can extract call edges from source code.
	 */
	parse(
		artifact: ArrayBuffer | string,
		name: string,
		version: string,
		sourceFiles?: SourceFiles
	): Promise<ParseResult>;
}
