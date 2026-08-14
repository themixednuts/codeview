const sqlModules = import.meta.glob<string>("./**/migration.sql", {
  query: "?raw",
  eager: true,
  import: "default",
});

export default {
  migrations: Object.fromEntries(
    Object.entries(sqlModules)
      .sort(([pathA], [pathB]) => pathA.localeCompare(pathB))
      .map(([path, sql]) => [path.split("/").at(-2)!, sql]),
  ),
};
