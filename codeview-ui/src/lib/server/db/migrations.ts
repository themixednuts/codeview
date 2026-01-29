const migrationModules = import.meta.glob('../../../../drizzle/**/migration.sql', {
	eager: true,
	query: '?raw',
	import: 'default'
});

const migrations: Record<string, string> = {};

for (const [path, sql] of Object.entries(migrationModules)) {
	const match = path.match(/drizzle\/([^/]+)\/migration\.sql$/);
	if (!match) continue;
	migrations[match[1]] = sql as string;
}

export default { migrations };
