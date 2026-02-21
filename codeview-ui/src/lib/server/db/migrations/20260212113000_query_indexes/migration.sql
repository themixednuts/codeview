CREATE INDEX IF NOT EXISTS `edges_to_kind_idx`
ON `edges` (`ecosystem`, `crate_name`, `crate_version`, `to_id`, `kind`);

CREATE INDEX IF NOT EXISTS `cross_edges_from_idx`
ON `cross_edges` (`ecosystem`, `from_id`);

CREATE INDEX IF NOT EXISTS `cross_edges_to_idx`
ON `cross_edges` (`ecosystem`, `to_id`);
