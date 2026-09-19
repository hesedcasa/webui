import {expect, test} from '@playwright/test'

import {expectedBin, isSdkckLeg} from './helpers.js'

test.describe('e2e: web UI in a browser', () => {
  test.beforeEach(async ({page}) => {
    await page.goto('/')
  })

  test('serves the app shell branded with the serving bin and the API version', async ({page, request}) => {
    const pageErrors: Error[] = []
    page.on('pageerror', (error) => {
      pageErrors.push(error)
    })

    const brand = page.locator('.brand')
    await expect(brand).toBeVisible()

    const text = ((await brand.textContent()) ?? '').replaceAll(/\s+/g, ' ').trim()
    expect(text).toContain(expectedBin())
    expect(text).toMatch(/web UI · v/)

    // The rendered version must come from the same surface the API serves,
    // not from a stale build-time constant.
    const response = await request.get('/api/commands')
    expect(response.status()).toBe(200)
    expect(text).toContain(`v${(await response.json()).version}`)

    expect(pageErrors, 'uncaught page errors').toEqual([])
  })

  test('toggles the color theme', async ({page}) => {
    await expect(page.locator('.theme-toggle')).toBeVisible()

    const before = await page.locator('html').getAttribute('class')
    await page.locator('.theme-toggle').click()
    await expect.poll(async () => page.locator('html').getAttribute('class'), {timeout: 5000}).not.toBe(before)
  })

  test.describe('standalone leg', () => {
    test.skip(isSdkckLeg(), 'standalone leg only')

    test('shows the empty state when no commands exist', async ({page}) => {
      // The standalone CLI serves exactly one command — webui itself — which
      // the surface hides, so the browser gets an empty list and must render
      // the empty state rather than hang on the loading placeholder.
      await expect(page.getByText('0 commands available.')).toBeVisible()
      await expect(page.locator('.command-item')).toHaveCount(0)
    })
  })

  test.describe('sdkck host leg', () => {
    test.skip(!isSdkckLeg(), 'sdkck host leg only')

    test('lists the installed host commands', async ({page}) => {
      const items = page.locator('.command-item')
      await expect(items.first()).toBeVisible()

      const count = await items.count()
      expect(count, 'the host bundles more than its core plugins').toBeGreaterThan(5)
      await expect(page.locator('.command-item .cmd-id', {hasText: 'synonyms:export'})).toHaveCount(1)

      const listedIds = await page.locator('.command-item .cmd-id').allTextContents()
      expect(listedIds, 'the serving command must not index itself').not.toContain('webui')
    })

    test('filters the list by query', async ({page}) => {
      const items = page.locator('.command-item')
      await expect(items.first()).toBeVisible()
      const before = await items.count()

      await page.getByRole('textbox', {name: 'Filter commands'}).fill('synonyms')
      await expect(page.locator('.command-item', {hasText: 'synonyms:export'})).toBeVisible()

      const after = await items.count()
      expect(after, 'the filter must narrow the list').toBeLessThan(before)
      expect(after).toBeGreaterThan(0)
      await expect(page.locator('.command-item', {hasText: 'synonyms:import'})).toHaveCount(1)
      await expect(page.locator('.command-item', {hasText: 'bb:commit'})).toHaveCount(0)
    })

    test('filters the list by topic', async ({page}) => {
      await expect(page.locator('.command-item').first()).toBeVisible()

      await page.locator('#topic').selectOption('help')
      await expect(page.locator('.command-item .cmd-id')).toHaveText(['help'])
    })

    test("shows the selected command's details and argv preview", async ({page}) => {
      await expect(page.locator('.command-item').first()).toBeVisible()

      await page.locator('.command-item', {hasText: 'synonyms:export'}).click()
      const detail = page.locator('.detail')
      await expect(detail.locator('h1')).toBeVisible()

      // The h1 also contains the plugin badge span, so match the id within it.
      await expect(detail.locator('h1')).toContainText('synonyms:export')
      await expect(detail.locator('.badge').first()).toHaveText('@hesed/search')
      await expect(detail.locator('.preview')).toHaveText('$ sdkck synonyms:export')
    })

    test('runs a command from the UI and renders its output', async ({page}) => {
      await expect(page.locator('.command-item').first()).toBeVisible()

      await page.locator('.command-item', {hasText: 'synonyms:export'}).click()
      await page.locator('.run-btn').click()

      // `synonyms:export` against the throwaway config dir has nothing stored,
      // so the round-trip from browser form to /api/run to the host's installed
      // command ends in exactly one empty JSON array.
      await expect(page.locator('.status.ok')).toContainText('✓ Success', {timeout: 30_000})
      await expect(page.locator('.output pre')).toHaveText('[]')
    })

    test('reports a failing command run', async ({page}) => {
      await expect(page.locator('.command-item').first()).toBeVisible()

      // `synonyms:import` requires a <file> argument; submitting the form
      // without one must surface the command's failure, not a hung spinner.
      await page.locator('.command-item', {hasText: 'synonyms:import'}).click()
      await page.locator('.run-btn').click()

      await expect(page.locator('.status.err')).toContainText('✗ Failed', {timeout: 30_000})
    })
  })
})
