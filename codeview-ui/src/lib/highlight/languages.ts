export type SupportedLanguage =
	| 'rust'
	| 'typescript'
	| 'javascript'
	| 'json'
	| 'toml'
	| 'bash'
	| 'sql'
	| 'text';

export type ProjectType = 'rust' | 'typescript' | 'javascript';

const languageAliases: Record<string, SupportedLanguage> = {
	rs: 'rust',
	ts: 'typescript',
	js: 'javascript',
	sh: 'bash',
	shell: 'bash',
	zsh: 'bash',
	plaintext: 'text',
	txt: 'text',
	'': 'text',
};

const supportedLanguages = new Set<SupportedLanguage>([
	'rust',
	'typescript',
	'javascript',
	'json',
	'toml',
	'bash',
	'sql',
	'text',
]);

const defaultLanguages: Record<ProjectType, SupportedLanguage> = {
	rust: 'rust',
	typescript: 'typescript',
	javascript: 'javascript',
};

export function normalizeLanguage(lang: string): SupportedLanguage {
	const lower = lang.toLowerCase().trim();
	return (
		languageAliases[lower] ??
		(supportedLanguages.has(lower as SupportedLanguage) ? (lower as SupportedLanguage) : 'text')
	);
}

export function getDefaultLanguage(projectType: ProjectType = 'rust'): SupportedLanguage {
	return defaultLanguages[projectType];
}
