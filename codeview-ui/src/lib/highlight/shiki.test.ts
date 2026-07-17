import { describe, expect, it } from 'vitest';
import { highlightCode } from './shiki';

function relativeLuminance(hex: string): number {
	const channels = hex
		.slice(1)
		.match(/.{2}/g)
		?.map((channel) => Number.parseInt(channel, 16) / 255);
	if (!channels || channels.length !== 3) throw new Error(`Invalid color: ${hex}`);

	const [red, green, blue] = channels.map((channel) =>
		channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
	);
	return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
	const foregroundLuminance = relativeLuminance(foreground);
	const backgroundLuminance = relativeLuminance(background);
	return (
		(Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
		(Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
	);
}

describe('code highlighting themes', () => {
	it('keeps every emitted theme token readable', async () => {
		const html = await highlightCode(
			'let result: Result<u8, Error> = Err(Error);\nlet text = "value"; // note',
			'rust',
			'dark',
		);
		const themeCases = [
			{ name: 'solarized-light', background: '#f2ebd7' },
			{ name: 'solarized-dark', background: '#001f27' },
			{ name: 'catppuccin-latte', background: '#eff1f5' },
			{ name: 'catppuccin-mocha', background: '#1e1e2e' },
			{ name: 'one-light', background: '#fafafa' },
			{ name: 'one-dark', background: '#282c34' },
			{ name: 'github-light', background: '#ffffff' },
			{ name: 'github-dark', background: '#0d1117' },
		] as const;

		expect(html).toContain('--shiki-solarized-light-bg:#f2ebd7');
		expect(html).toContain('--shiki-solarized-dark-bg:#001f27');
		for (const theme of themeCases) {
			const colors = new Set(
				[...html.matchAll(new RegExp(`--shiki-${theme.name}:(#[\\da-f]{6})`, 'gi'))].map((match) =>
					match[1].toLowerCase(),
				),
			);
			expect(colors.size).toBeGreaterThan(3);
			for (const color of colors) {
				expect(
					contrastRatio(color, theme.background),
					`${theme.name} ${color}`,
				).toBeGreaterThanOrEqual(4.5);
			}
		}
	});
});
