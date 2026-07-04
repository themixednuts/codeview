import type { WorkspaceOutput } from '$lib/schema';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const graphData = sqliteTable('graph_data', {
	id: integer('id').primaryKey(),
	json: text('json', { mode: 'json' }).$type<WorkspaceOutput>().notNull(),
});

export const sourceCache = sqliteTable('source_cache', {
	path: text('path').primaryKey(),
	content: text('content').notNull(),
	cachedAt: integer('cached_at').notNull(),
});

export const crateStatus = sqliteTable(
	'crate_status',
	{
		ecosystem: text('ecosystem').notNull(),
		name: text('name').notNull(),
		version: text('version').notNull(),
		status: text('status').notNull().default('unknown'),
		error: text('error'),
		lastStep: text('last_step'),
		updatedAt: integer('updated_at').notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.ecosystem, table.name, table.version] }),
		index('crate_status_processing_idx').on(table.ecosystem, table.status, table.updatedAt),
	],
);

export const crossEdges = sqliteTable(
	'cross_edges',
	{
		ecosystem: text('ecosystem').notNull(),
		sourceName: text('source_name').notNull(),
		sourceVersion: text('source_version').notNull(),
		fromId: text('from_id').notNull(),
		toId: text('to_id').notNull(),
		kind: text('kind').notNull(),
		confidence: text('confidence').notNull(),
		isGlob: integer('is_glob', { mode: 'boolean' }).notNull().default(false),
	},
	(table) => [
		primaryKey({
			columns: [
				table.ecosystem,
				table.sourceName,
				table.sourceVersion,
				table.fromId,
				table.toId,
				table.kind,
				table.confidence,
			],
		}),
		index('cross_edges_from_idx').on(table.ecosystem, table.fromId),
		index('cross_edges_to_idx').on(table.ecosystem, table.toId),
	],
);

/**
 * Crate metadata - lightweight, no full graph blob.
 * Nodes stored separately in nodeDetails, edges in edges table.
 */
export const crateGraphs = sqliteTable(
	'crate_graphs',
	{
		ecosystem: text('ecosystem').notNull(),
		name: text('name').notNull(),
		version: text('version').notNull(),
		indexJson: text('index_json').notNull(),
		treeJson: text('tree_json'),
		parseSession: text('parse_session').notNull().default(''),
		committed: integer('committed', { mode: 'boolean' }).notNull().default(false),
		nodeCount: integer('node_count').notNull().default(0),
		edgeCount: integer('edge_count').notNull().default(0),
		parsedAt: integer('parsed_at').notNull(),
	},
	(table) => [primaryKey({ columns: [table.ecosystem, table.name, table.version] })],
);

/**
 * Individual node storage - full node JSON per node.
 * Enables progressive loading and efficient single-node queries.
 */
export const nodeDetails = sqliteTable(
	'node_details',
	{
		ecosystem: text('ecosystem').notNull(),
		crateName: text('crate_name').notNull(),
		crateVersion: text('crate_version').notNull(),
		nodeId: text('node_id').notNull(),
		nodeJson: text('node_json').notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.ecosystem, table.crateName, table.crateVersion, table.nodeId],
		}),
	],
);

/**
 * Normalized edge storage - enables efficient edge queries.
 */
export const edges = sqliteTable(
	'edges',
	{
		ecosystem: text('ecosystem').notNull(),
		crateName: text('crate_name').notNull(),
		crateVersion: text('crate_version').notNull(),
		fromId: text('from_id').notNull(),
		toId: text('to_id').notNull(),
		kind: text('kind').notNull(),
		confidence: text('confidence').notNull(),
		isGlob: integer('is_glob', { mode: 'boolean' }).notNull().default(false),
	},
	(table) => [
		primaryKey({
			columns: [
				table.ecosystem,
				table.crateName,
				table.crateVersion,
				table.fromId,
				table.toId,
				table.kind,
			],
		}),
		index('edges_from_kind_idx').on(
			table.ecosystem,
			table.crateName,
			table.crateVersion,
			table.fromId,
			table.kind,
			table.toId,
		),
		index('edges_to_kind_idx').on(
			table.ecosystem,
			table.crateName,
			table.crateVersion,
			table.toId,
			table.kind,
			table.fromId,
		),
		index('edges_to_idx').on(table.ecosystem, table.crateName, table.crateVersion, table.toId),
	],
);

/**
 * Node index for search - lightweight fields only.
 */
export const nodeIndex = sqliteTable(
	'node_index',
	{
		nodeId: text('node_id').primaryKey(),
		name: text('name').notNull(),
		kind: text('kind').notNull(),
		visibility: text('visibility').notNull(),
		isExternal: integer('is_external', { mode: 'boolean' }).notNull(),
		updatedAt: integer('updated_at').notNull(),
	},
	(table) => [index('node_index_name_idx').on(table.name)],
);
