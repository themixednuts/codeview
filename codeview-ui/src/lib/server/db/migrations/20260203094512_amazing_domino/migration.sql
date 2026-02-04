CREATE TABLE `crate_graphs` (
	`ecosystem` text NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`index_json` text NOT NULL,
	`tree_json` text,
	`node_count` integer DEFAULT 0 NOT NULL,
	`edge_count` integer DEFAULT 0 NOT NULL,
	`parsed_at` integer NOT NULL,
	CONSTRAINT `crate_graphs_pk` PRIMARY KEY(`ecosystem`, `name`, `version`)
);
--> statement-breakpoint
CREATE TABLE `crate_status` (
	`ecosystem` text NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`error` text,
	`last_step` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT `crate_status_pk` PRIMARY KEY(`ecosystem`, `name`, `version`)
);
--> statement-breakpoint
CREATE TABLE `cross_edges` (
	`ecosystem` text NOT NULL,
	`source_name` text NOT NULL,
	`source_version` text NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`kind` text NOT NULL,
	`confidence` text NOT NULL,
	CONSTRAINT `cross_edges_pk` PRIMARY KEY(`ecosystem`, `source_name`, `source_version`, `from_id`, `to_id`, `kind`, `confidence`)
);
--> statement-breakpoint
CREATE TABLE `edges` (
	`ecosystem` text NOT NULL,
	`crate_name` text NOT NULL,
	`crate_version` text NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`kind` text NOT NULL,
	`confidence` text NOT NULL,
	CONSTRAINT `edges_pk` PRIMARY KEY(`ecosystem`, `crate_name`, `crate_version`, `from_id`, `to_id`, `kind`)
);
--> statement-breakpoint
CREATE TABLE `graph_data` (
	`id` integer PRIMARY KEY,
	`json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `node_details` (
	`ecosystem` text NOT NULL,
	`crate_name` text NOT NULL,
	`crate_version` text NOT NULL,
	`node_id` text NOT NULL,
	`node_json` text NOT NULL,
	CONSTRAINT `node_details_pk` PRIMARY KEY(`ecosystem`, `crate_name`, `crate_version`, `node_id`)
);
--> statement-breakpoint
CREATE TABLE `node_index` (
	`node_id` text PRIMARY KEY,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`visibility` text NOT NULL,
	`is_external` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_cache` (
	`path` text PRIMARY KEY,
	`content` text NOT NULL,
	`cached_at` integer NOT NULL
);
