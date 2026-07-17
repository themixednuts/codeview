import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appCss = readFileSync(new URL('../../app.css', import.meta.url), 'utf8');
const themes = [
	'solarized-light',
	'solarized-dark',
	'catppuccin-latte',
	'catppuccin-mocha',
	'one-light',
	'one-dark',
	'github-light',
	'github-dark',
] as const;

function relativeLuminance(hex: string): number {
	const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
	const linear = channels.map((channel) =>
		channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
	);
	return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground: string, background: string): number {
	const foregroundLuminance = relativeLuminance(foreground);
	const backgroundLuminance = relativeLuminance(background);
	return (
		(Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
		(Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
	);
}

describe('static code theme tokens', () => {
	it.each(themes)('%s keeps every text token at WCAG AA contrast', (theme) => {
		const block = appCss.match(
			new RegExp(`\\[data-code-theme='${theme}'\\] \\{([\\s\\S]*?)\\n\\t\\}`),
		)?.[1];
		expect(block, `${theme} CSS block`).toBeDefined();
		const variables = Object.fromEntries(
			[...(block ?? '').matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map((match) => [
				match[1],
				match[2].toLowerCase(),
			]),
		);
		const background = variables['code-bg'];
		expect(background, `${theme} background`).toBeDefined();

		for (const [name, color] of Object.entries(variables)) {
			if (name !== 'code-ink' && !name.startsWith('syntax-')) continue;
			expect(contrastRatio(color, background), `${theme} ${name} ${color}`).toBeGreaterThanOrEqual(
				4.5,
			);
		}
	});
});
