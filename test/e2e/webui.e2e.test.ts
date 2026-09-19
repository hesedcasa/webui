import type {Browser, Page} from 'playwright'

import {expect} from 'chai'

import {
  captureScreenshot,
  createConfigDir,
  expectedBin,
  fetchJson,
  isSdkckLeg,
  launchBrowser,
  removeConfigDir,
  startWebUi,
  stopWebUi,
  type WebUiServer,
} from './helpers.js'

/**
 * Resolves once the sidebar lists exactly one command with the given id.
 *
 * Passed to page.waitForFunction(), so it must be self-contained and run in
 * the browser.
 *
 * @param id The command id the list should collapse to, e.g. 'help'.
 * @returns True when the list holds exactly that command.
 */
function isOnlyCommandListed(id: string): boolean {
  const ids = [...document.querySelectorAll('.command-item .cmd-id')].map((el) => el.textContent)
  return ids.length === 1 && ids[0] === id
}

describe('e2e: web UI in a browser', () => {
  let browser: Browser
  let configDir: string
  let page: Page
  let pageErrors: Error[]
  let server: WebUiServer

  before(async () => {
    configDir = await createConfigDir()
    server = await startWebUi(configDir)
    browser = await launchBrowser()
    pageErrors = []
    page = await browser.newPage()
    page.on('pageerror', (error) => {
      pageErrors.push(error)
    })
  })

  after(async () => {
    await browser?.close()
    await stopWebUi(server)
    await removeConfigDir(configDir)
  })

  beforeEach(async () => {
    await page.goto(server.url)
  })

  // Captures the resulting page state after every test that ran — pass or
  // fail — so a full run leaves a browsable record under
  // test/e2e/screenshots/<leg>/; suites skipped wholesale by their leg guard
  // never reach this hook.
  afterEach(async function () {
    const test = this.currentTest
    if (!test?.state) return
    await captureScreenshot(page, test.state, test.title)
  })

  it('serves the app shell branded with the serving bin and the API version', async () => {
    const brand = page.locator('.brand')
    await brand.waitFor({state: 'visible'})

    const text = (await brand.textContent())?.replaceAll(/\s+/g, ' ').trim() ?? ''
    expect(text).to.contain(expectedBin())
    expect(text).to.match(/web UI · v/)

    // The rendered version must come from the same surface the API serves,
    // not from a stale build-time constant.
    const {body, status} = await fetchJson<{version: string}>(server, '/api/commands')
    expect(status).to.equal(200)
    expect(text).to.contain(`v${body.version}`)

    expect(pageErrors, 'uncaught page errors').to.deep.equal([])
  })

  it('toggles the color theme', async () => {
    await page.locator('.theme-toggle').waitFor({state: 'visible'})

    const before = (await page.locator('html').getAttribute('class')) ?? ''
    await page.locator('.theme-toggle').click()
    await page.waitForFunction((previous) => document.documentElement.className !== previous, before, {timeout: 5000})

    expect(await page.locator('html').getAttribute('class')).to.not.equal(before)
  })

  describe('standalone leg', () => {
    before(function () {
      if (isSdkckLeg()) this.skip()
    })

    it('shows the empty state when no commands exist', async () => {
      // The standalone CLI serves exactly one command — webui itself — which
      // the surface hides, so the browser gets an empty list and must render
      // the empty state rather than hang on the loading placeholder.
      await page.getByText('0 commands available.').waitFor({state: 'visible'})
      expect(await page.locator('.command-item').count()).to.equal(0)
    })
  })

  describe('sdkck host leg', () => {
    before(function () {
      if (!isSdkckLeg()) this.skip()
    })

    it('lists the installed host commands', async () => {
      await page.locator('.command-item').first().waitFor({state: 'visible'})

      const count = await page.locator('.command-item').count()
      expect(count, 'the host bundles more than its core plugins').to.be.greaterThan(5)
      expect(await page.locator('.command-item .cmd-id', {hasText: 'synonyms:export'}).count()).to.equal(1)

      const listedIds = await page.locator('.command-item .cmd-id').allTextContents()
      expect(listedIds, 'the serving command must not index itself').to.not.include('webui')
    })

    it('filters the list by query', async () => {
      await page.locator('.command-item').first().waitFor({state: 'visible'})
      const before = await page.locator('.command-item').count()

      await page.getByRole('textbox', {name: 'Filter commands'}).fill('synonyms')
      await page.locator('.command-item', {hasText: 'synonyms:export'}).waitFor({state: 'visible'})

      const after = await page.locator('.command-item').count()
      expect(after, 'the filter must narrow the list').to.be.lessThan(before)
      expect(after).to.be.greaterThan(0)
      expect(await page.locator('.command-item', {hasText: 'synonyms:import'}).count()).to.equal(1)
      expect(await page.locator('.command-item', {hasText: 'bb:commit'}).count()).to.equal(0)
    })

    it('filters the list by topic', async () => {
      await page.locator('.command-item').first().waitFor({state: 'visible'})

      await page.locator('#topic').selectOption('help')
      await page.waitForFunction(isOnlyCommandListed, 'help', {timeout: 5000})

      expect(await page.locator('.command-item .cmd-id').allTextContents()).to.deep.equal(['help'])
    })

    it("shows the selected command's details and argv preview", async () => {
      await page.locator('.command-item').first().waitFor({state: 'visible'})

      await page.locator('.command-item', {hasText: 'synonyms:export'}).click()
      await page.locator('.detail h1').waitFor({state: 'visible'})

      // The h1 also contains the plugin badge span, so match the id within it.
      expect(await page.locator('.detail h1').textContent()).to.contain('synonyms:export')
      expect(await page.locator('.detail .badge').first().textContent()).to.equal('@hesed/search')
      expect((await page.locator('.preview').textContent())?.trim()).to.equal('$ sdkck synonyms:export')
    })

    it('runs a command from the UI and renders its output', async () => {
      await page.locator('.command-item').first().waitFor({state: 'visible'})

      await page.locator('.command-item', {hasText: 'synonyms:export'}).click()
      await page.locator('.run-btn').click()

      await page.locator('.status.ok').waitFor({state: 'visible'})
      expect(await page.locator('.status.ok').textContent()).to.contain('✓ Success')

      // `synonyms:export` against the throwaway config dir has nothing stored,
      // so the round-trip from browser form to /api/run to the host's installed
      // command ends in exactly one empty JSON array.
      expect((await page.locator('.output pre').textContent())?.trim()).to.equal('[]')
    })

    it('reports a failing command run', async () => {
      await page.locator('.command-item').first().waitFor({state: 'visible'})

      // `synonyms:import` requires a <file> argument; submitting the form
      // without one must surface the command's failure, not a hung spinner.
      await page.locator('.command-item', {hasText: 'synonyms:import'}).click()
      await page.locator('.run-btn').click()

      await page.locator('.status.err').waitFor({state: 'visible'})
      expect(await page.locator('.status.err').textContent()).to.contain('✗ Failed')
    })
  })
})
