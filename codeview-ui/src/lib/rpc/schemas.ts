import * as v from 'valibot';
import { NodeKindSchema } from '$lib/schema';

export const SearchNodesInputSchema = v.object({
	crate: v.optional(v.string()),
	version: v.optional(v.string()),
	q: v.optional(v.string()),
	kinds: v.optional(v.array(NodeKindSchema)),
});

export type SearchNodesInput = v.InferOutput<typeof SearchNodesInputSchema>;

export const GetSourceInputSchema = v.object({
	file: v.string(),
	crateName: v.optional(v.string()),
	crateVersion: v.optional(v.string()),
	sourceProvider: v.optional(v.picklist(['auto', 'crates-io', 'github'])),
});

export const CrateNameInputSchema = v.object({
	name: v.string(),
});

export const CrateVersionInputSchema = v.object({
	name: v.string(),
	version: v.string(),
});

export const TriggerParseInputSchema = v.object({
	name: v.string(),
	version: v.string(),
	force: v.optional(v.boolean()),
});

export const InstallStdDocsInputSchema = v.object({
	name: v.string(),
	version: v.string(),
});

export const RegistrySearchInputSchema = v.object({
	q: v.string(),
});

export const ProbeDocsInputSchema = v.object({
	name: v.string(),
	currentVersion: v.string(),
	candidates: v.array(v.string()),
});

export const NodeIdSchema = v.string();
export const NodeIdsSchema = v.array(v.string());

export const CrateRefSchema = v.object({
	name: v.string(),
	version: v.optional(v.string()),
	mode: v.optional(v.picklist(['structural', 'complete'])),
	includeExternal: v.optional(v.boolean()),
});

export const NodeDetailInputSchema = v.object({
	nodeId: v.string(),
	version: v.optional(v.string()),
	refresh: v.optional(v.number()),
});

export const ProcessingInputSchema = v.object({
	refresh: v.optional(v.number()),
});

export const TreeNodeInputSchema = v.object({
	name: v.string(),
	version: v.optional(v.string()),
	nodeId: v.string(),
});

export const NodeViewInputSchema = v.object({
	name: v.string(),
	version: v.optional(v.string()),
	nodeId: v.string(),
});

export type NodeViewInput = v.InferOutput<typeof NodeViewInputSchema>;
