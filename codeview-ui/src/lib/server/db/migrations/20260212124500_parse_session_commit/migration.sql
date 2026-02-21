ALTER TABLE `crate_graphs` ADD COLUMN `parse_session` text NOT NULL DEFAULT '';

ALTER TABLE `crate_graphs` ADD COLUMN `committed` integer NOT NULL DEFAULT 0;
