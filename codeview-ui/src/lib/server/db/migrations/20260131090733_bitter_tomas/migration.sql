CREATE TABLE `crate_graphs` (
	`ecosystem` text NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`graph_json` text NOT NULL,
	`index_json` text NOT NULL,
	`parsed_at` integer NOT NULL,
	CONSTRAINT `crate_graphs_pk` PRIMARY KEY(`ecosystem`, `name`, `version`)
);
