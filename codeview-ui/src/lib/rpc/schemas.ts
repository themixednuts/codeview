import * as Schema from 'effect/Schema';

const NodeKind = Schema.Literal(
	'Crate',
	'Module',
	'Struct',
	'StructField',
	'Union',
	'Enum',
	'Variant',
	'Trait',
	'TraitAlias',
	'Impl',
	'Function',
	'TypeAlias',
	'AssocType',
	'Constant',
	'AssocConst',
	'Static',
	'Macro',
	'Primitive',
	'ExternCrate',
	'Import',
	'ProcMacro',
);

const SearchNodesInput = Schema.Struct({
	crate: Schema.optional(Schema.String),
	version: Schema.optional(Schema.String),
	q: Schema.optional(Schema.String),
	kinds: Schema.optional(Schema.Array(NodeKind)),
});

const GetSourceInput = Schema.Struct({
	file: Schema.String,
	crateName: Schema.optional(Schema.String),
	crateVersion: Schema.optional(Schema.String),
	sourceProvider: Schema.optional(Schema.Literal('auto', 'crates-io', 'github')),
});

const CrateNameInput = Schema.Struct({
	name: Schema.String,
});

const CrateVersionInput = Schema.Struct({
	name: Schema.String,
	version: Schema.String,
});

const TriggerParseInput = Schema.Struct({
	name: Schema.String,
	version: Schema.String,
	force: Schema.optional(Schema.Boolean),
});

const InstallStdDocsInput = Schema.Struct({
	name: Schema.String,
	version: Schema.String,
});

const RegistrySearchInput = Schema.Struct({
	q: Schema.String,
});

const CrateRef = Schema.Struct({
	name: Schema.String,
	version: Schema.optional(Schema.String),
	mode: Schema.optional(Schema.Literal('structural', 'complete')),
	includeExternal: Schema.optional(Schema.Boolean),
});

const NodeDetailInput = Schema.Struct({
	nodeId: Schema.String,
	version: Schema.optional(Schema.String),
	refresh: Schema.optional(Schema.Number),
});

const ProcessingInput = Schema.Struct({
	refresh: Schema.optional(Schema.Number),
});

const TreeNodeInput = Schema.Struct({
	name: Schema.String,
	version: Schema.optional(Schema.String),
	nodeId: Schema.String,
});

const NodeViewInput = Schema.Struct({
	name: Schema.String,
	version: Schema.optional(Schema.String),
	nodeId: Schema.String,
});

const NodeIds = Schema.Array(Schema.String);

export const SearchNodesInputSchema = Schema.toStandardSchemaV1(SearchNodesInput);
export const GetSourceInputSchema = Schema.toStandardSchemaV1(GetSourceInput);
export const CrateNameInputSchema = Schema.toStandardSchemaV1(CrateNameInput);
export const CrateVersionInputSchema = Schema.toStandardSchemaV1(CrateVersionInput);
export const TriggerParseInputSchema = Schema.toStandardSchemaV1(TriggerParseInput);
export const InstallStdDocsInputSchema = Schema.toStandardSchemaV1(InstallStdDocsInput);
export const RegistrySearchInputSchema = Schema.toStandardSchemaV1(RegistrySearchInput);
export const CrateRefSchema = Schema.toStandardSchemaV1(CrateRef);
export const NodeDetailInputSchema = Schema.toStandardSchemaV1(NodeDetailInput);
export const ProcessingInputSchema = Schema.toStandardSchemaV1(ProcessingInput);
export const TreeNodeInputSchema = Schema.toStandardSchemaV1(TreeNodeInput);
export const NodeViewInputSchema = Schema.toStandardSchemaV1(NodeViewInput);
export const NodeIdsSchema = Schema.toStandardSchemaV1(NodeIds);

export type SearchNodesInput = typeof SearchNodesInput.Type;
export type NodeViewInput = typeof NodeViewInput.Type;
