import { test, expect } from '@playwright/test'

test('app smoke test loads the workspace shell', async ({ page }) => {
	await page.goto('/')
	await expect(
		page.getByRole('heading', { name: 'Editing workspace' }),
	).toBeVisible()
	await expect(page.getByText('Eprec Studio')).toBeVisible()
	await expect(page.getByText('Review transcript-based edits')).toBeVisible()
})
