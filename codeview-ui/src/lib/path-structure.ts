/**
 * Path structure metadata for accurate skeleton rendering.
 * Tracks child counts per parent node to show realistic placeholders.
 */
export interface PathStructureMetadata {
	/** Map of parent node ID -> number of children expected */
	childCounts: Record<string, number>;
	/** Set of node IDs that have been fully processed */
	completedNodes: string[];
	/** Timestamp of when this metadata was generated */
	timestamp: number;
}
