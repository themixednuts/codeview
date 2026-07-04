CREATE INDEX IF NOT EXISTS `crate_status_processing_idx` ON `crate_status` (`ecosystem`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `cross_edges_from_idx` ON `cross_edges` (`ecosystem`,`from_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `cross_edges_to_idx` ON `cross_edges` (`ecosystem`,`to_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `edges_from_kind_idx` ON `edges` (`ecosystem`,`crate_name`,`crate_version`,`from_id`,`kind`,`to_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `edges_to_kind_idx` ON `edges` (`ecosystem`,`crate_name`,`crate_version`,`to_id`,`kind`,`from_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `edges_to_idx` ON `edges` (`ecosystem`,`crate_name`,`crate_version`,`to_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `node_index_name_idx` ON `node_index` (`name`);
