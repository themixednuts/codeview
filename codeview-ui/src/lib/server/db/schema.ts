import type { WorkspaceOutput } from '$lib/schema';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const graphData = sqliteTable('graph_data', {
	id: integer('id').primaryKey(),
	json: text('json', { mode: 'json' }).$type<WorkspaceOutput>().notNull()
});

export const sourceCache = sqliteTable('source_cache', {
	path: text('path').primaryKey(),
	content: text('content').notNull(),
	cachedAt: integer('cached_at').notNull()
});

export const crateStatus = sqliteTable(
	'crate_status',
	{
		ecosystem: text('ecosystem').notNull(),
		name: text('name').notNull(),
		version: text('version').notNull(),
		status: text('status').notNull().default('unknown'),
		error: text('error'),
		updatedAt: integer('updated_at').notNull()
	},
	(table) => [primaryKey({ columns: [table.ecosystem, table.name, table.version] })]
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
		confidence: text('confidence').notNull()
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
				table.confidence
			]
		})
	]
);

export const crateGraphs = sqliteTable(
	'crate_graphs',
	{
		ecosystem: text('ecosystem').notNull(),
		name: text('name').notNull(),
		version: text('version').notNull(),
		graphJson: text('graph_json').notNull(),
		indexJson: text('index_json').notNull(),
		parsedAt: integer('parsed_at').notNull()
	},
	(table) => [primaryKey({ columns: [table.ecosystem, table.name, table.version] })]
);

export const nodeIndex = sqliteTable('node_index', {
	nodeId: text('node_id').primaryKey(),
	name: text('name').notNull(),
	kind: text('kind').notNull(),
	visibility: text('visibility').notNull(),
	isExternal: integer('is_external', { mode: 'boolean' }).notNull(),
	updatedAt: integer('updated_at').notNull()
});
