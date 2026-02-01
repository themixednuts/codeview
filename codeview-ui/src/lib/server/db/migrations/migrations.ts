const sqlModules = import.meta.glob("./**/migration.sql", {
	query: "?raw",
	eager: true,
	import: "default",
}) as Record<string, string>;

export default {
	migrations: Object.fromEntries(
		Object.entries(sqlModules).map(([path, sql]) => [
			path.split("/").at(-2)!,
			sql,
		]),
	),
};
