import { describe, expect, it } from 'vite-plus/test';
import { cloneCommand, editorUri, repoBaseUrl, resolveEditorPath } from './source-links';

describe('source links', () => {
	it('builds editor URIs from local absolute paths', () => {
		expect(editorUri('vscode://file/{path}:{line}', 'C:\\src\\proc-macro2\\src\\lib.rs', 42)).toBe(
			'vscode://file/C:\\src\\proc-macro2\\src\\lib.rs:42',
		);
	});

	it('materializes hosted source paths from a configured local source root', () => {
		expect(resolveEditorPath(null, 'C:\\src\\proc-macro2\\', 'src/lib.rs')).toBe(
			'C:\\src\\proc-macro2\\src\\lib.rs',
		);
	});

	it('keeps local provider absolute paths ahead of the configured source root', () => {
		expect(resolveEditorPath('/tmp/workspace/src/lib.rs', 'C:\\src\\proc-macro2', 'src/lib.rs')).toBe(
			'/tmp/workspace/src/lib.rs',
		);
	});

	it('builds git and jj clone commands from blob urls', () => {
		const blob = 'https://github.com/dtolnay/proc-macro2/blob/1.0.106/src/lib.rs';
		expect(repoBaseUrl(blob)).toBe('https://github.com/dtolnay/proc-macro2');
		expect(cloneCommand(blob, 'git')).toBe('git clone https://github.com/dtolnay/proc-macro2');
		expect(cloneCommand(blob, 'jj')).toBe('jj git clone https://github.com/dtolnay/proc-macro2');
	});
});
