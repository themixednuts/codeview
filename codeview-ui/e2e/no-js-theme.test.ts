import { expect, test, type BrowserContext, type Page } from '@playwright/test';

test.use({ javaScriptEnabled: false });

const baseUrl = `http://127.0.0.1:${process.env.CODEVIEW_E2E_PORT ?? 8787}`;

async function setThemeCookies(
	context: BrowserContext,
	preferences: {
		theme: 'light' | 'dark' | 'system';
		codeLight?: 'solarized-light' | 'catppuccin-latte' | 'one-light' | 'github-light';
		codeDark?: 'solarized-dark' | 'catppuccin-mocha' | 'one-dark' | 'github-dark';
	},
) {
	await context.addCookies([
		{ name: 'codeview-theme', value: preferences.theme, url: baseUrl },
		{
			name: 'codeview-code-light',
			value: preferences.codeLight ?? 'solarized-light',
			url: baseUrl,
		},
		{
			name: 'codeview-code-dark',
			value: preferences.codeDark ?? 'solarized-dark',
			url: baseUrl,
		},
	]);
}

async function readThemeStyles(page: Page) {
	return page.locator('html').evaluate((html) => {
		const shadowProbe = document.createElement('div');
		shadowProbe.style.boxShadow = 'var(--shadow-soft)';
		document.body.append(shadowProbe);
		const shadowValid = getComputedStyle(shadowProbe).boxShadow !== 'none';
		shadowProbe.remove();

		return {
			background: getComputedStyle(document.body).backgroundColor,
			codeBackground: getComputedStyle(html).getPropertyValue('--code-bg').trim(),
			colorScheme: getComputedStyle(html).colorScheme,
			shadowValid,
		};
	});
}

test.describe('No-JavaScript themes', () => {
	test('system mode follows a dark OS preference and dark code theme', async ({
		context,
		page,
	}) => {
		await page.emulateMedia({ colorScheme: 'dark' });
		await setThemeCookies(context, {
			theme: 'system',
			codeLight: 'github-light',
			codeDark: 'github-dark',
		});

		await page.goto('/');

		await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
		await expect(page.locator('html')).toHaveAttribute('data-code-theme-light', 'github-light');
		await expect(page.locator('html')).toHaveAttribute('data-code-theme-dark', 'github-dark');
		await expect
			.poll(() => readThemeStyles(page))
			.toEqual({
				background: 'rgb(0, 43, 54)',
				codeBackground: '#0d1117',
				colorScheme: 'light dark',
				shadowValid: true,
			});
	});

	test('system mode follows a light OS preference and light code theme', async ({
		context,
		page,
	}) => {
		await page.emulateMedia({ colorScheme: 'light' });
		await setThemeCookies(context, {
			theme: 'system',
			codeLight: 'github-light',
			codeDark: 'github-dark',
		});

		await page.goto('/');

		await expect
			.poll(() => readThemeStyles(page))
			.toEqual({
				background: 'rgb(253, 246, 227)',
				codeBackground: '#fff',
				colorScheme: 'light dark',
				shadowValid: true,
			});
	});

	test('explicit modes override the OS preference', async ({ context, page }) => {
		await page.emulateMedia({ colorScheme: 'dark' });
		await setThemeCookies(context, { theme: 'light' });
		await page.goto('/');
		await expect
			.poll(() => readThemeStyles(page))
			.toMatchObject({
				background: 'rgb(253, 246, 227)',
				colorScheme: 'light',
			});

		await page.emulateMedia({ colorScheme: 'light' });
		await setThemeCookies(context, { theme: 'dark' });
		await page.reload();
		await expect
			.poll(() => readThemeStyles(page))
			.toMatchObject({
				background: 'rgb(0, 43, 54)',
				colorScheme: 'dark',
			});
	});

	test('native settings form persists the selected mode', async ({ page }) => {
		await page.goto('/settings?returnTo=/');
		await page.locator('select[name="codeview-theme"]').selectOption('dark');
		await Promise.all([
			page.waitForURL(`${baseUrl}/`),
			page.getByRole('button', { name: 'Save settings' }).click(),
		]);

		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await expect
			.poll(() => page.context().cookies())
			.toContainEqual(expect.objectContaining({ name: 'codeview-theme', value: 'dark' }));
	});
});
