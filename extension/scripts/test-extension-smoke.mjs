import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const EXTENSION_DIR = resolve(SCRIPT_DIR, '..', 'dist', 'chrome-mv3-test')
const headed = process.argv.includes('--headed')

const pageHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Brosdk Extension Smoke Page</title>
    <style>
      body { font: 16px/1.5 system-ui, sans-serif; margin: 40px; max-width: 720px; }
      label, input, button { display: block; margin-top: 12px; }
      input { min-width: 280px; padding: 8px; }
      button { padding: 8px 14px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Extension Smoke Page</h1>
      <p id="summary">A deterministic page for browser tool verification.</p>
      <a id="docs-link" href="/docs">Read the local docs</a>
      <label for="query">Task name</label>
      <input id="query" placeholder="Enter a task name">
      <button id="apply" type="button">Apply task</button>
      <p id="status" aria-live="polite">Idle</p>
    </main>
    <script>
      document.querySelector('#apply').addEventListener('click', () => {
        document.querySelector('#status').textContent =
          'Applied: ' + document.querySelector('#query').value
      })
    </script>
  </body>
</html>`

const navigatedPageHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Brosdk Navigated Page</title>
  </head>
  <body>
    <main><h1>Navigation complete</h1></main>
  </body>
</html>`

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolveListen()
    })
  })
}

function closeServer(server) {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()))
  })
}

async function invokeTool(extensionPage, name, args = {}) {
  const response = await extensionPage.evaluate(
    ({ toolName, toolArgs }) =>
      new Promise((resolveRequest, reject) => {
        chrome.runtime.sendMessage(
          { type: 'extension.tool.invoke', name: toolName, arguments: toolArgs },
          (result) => {
            const error = chrome.runtime.lastError
            if (error) {
              reject(new Error(error.message))
              return
            }
            resolveRequest(result)
          },
        )
      }),
    { toolName: name, toolArgs: args },
  )
  assert.equal(response?.ok, true, response?.error || `${name} failed`)
  return response.data
}

async function run() {
  const server = createServer((request, response) => {
    if (request.url === '/docs') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Local smoke docs')
      return
    }
    if (request.url === '/next') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(navigatedPageHtml)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(pageHtml)
  })
  await listen(server)
  const address = server.address()
  assert(address && typeof address === 'object')
  const pageUrl = `http://127.0.0.1:${address.port}/`
  const userDataDir = await mkdtemp(join(tmpdir(), 'brosdk-extension-smoke-'))
  let context

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: !headed,
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
      ],
    })

    let serviceWorker = context.serviceWorkers()[0]
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15_000 })
    }
    const extensionId = new URL(serviceWorker.url()).host
    assert.match(extensionId, /^[a-p]{32}$/)

    const pageErrors = []
    const targetPage = await context.newPage()
    targetPage.on('pageerror', (error) => pageErrors.push(error.message))
    await targetPage.goto(pageUrl)
    await targetPage.getByRole('heading', { name: 'Extension Smoke Page' }).waitFor()

    const extensionPage = await context.newPage()
    await extensionPage.goto(`chrome-extension://${extensionId}/settings.html`)

    const tabsResult = await invokeTool(extensionPage, 'browser_tabs')
    const targetTab = tabsResult.tabs.find((tab) => tab.url === pageUrl)
    assert(targetTab?.tabId, 'controlled page was not returned by browser_tabs')
    const tabId = targetTab.tabId

    await targetPage.bringToFront()
    const activeResult = await invokeTool(extensionPage, 'browser_active_tab')
    assert.equal(activeResult.tab.tabId, tabId)
    assert.equal(activeResult.tab.title, 'Brosdk Extension Smoke Page')

    const readResult = await invokeTool(extensionPage, 'browser_read_page', { tabId })
    assert.equal(readResult.result.title, 'Brosdk Extension Smoke Page')
    assert.match(readResult.result.text, /deterministic page for browser tool verification/i)

    const snapshotResult = await invokeTool(extensionPage, 'browser_snapshot', { tabId })
    const input = snapshotResult.result.elements.find((element) => element.selector === '#query')
    const button = snapshotResult.result.elements.find((element) => element.selector === '#apply')
    assert(input?.ref, 'snapshot did not return the task input')
    assert(button?.ref, 'snapshot did not return the apply button')

    const linksResult = await invokeTool(extensionPage, 'browser_extract_links', { tabId })
    assert(
      linksResult.result.links.some(
        (link) => link.text === 'Read the local docs' && link.href === `${pageUrl}docs`,
      ),
      'browser_extract_links did not return the controlled link',
    )

    await invokeTool(extensionPage, 'browser_type', {
      tabId,
      ref: input.ref,
      text: 'extension-smoke',
    })
    assert.equal(await targetPage.locator('#query').inputValue(), 'extension-smoke')

    await invokeTool(extensionPage, 'browser_click', { tabId, ref: button.ref })
    await targetPage.getByText('Applied: extension-smoke').waitFor()

    await invokeTool(extensionPage, 'browser_navigate', { tabId, url: `${pageUrl}next` })
    await targetPage.waitForURL(`${pageUrl}next`)
    await targetPage.getByRole('heading', { name: 'Navigation complete' }).waitFor()
    assert.deepEqual(pageErrors, [])

    console.log(`PASS browser_tabs extension_id=${extensionId}`)
    console.log('PASS browser_active_tab controlled_page')
    console.log('PASS browser_read_page controlled_content')
    console.log('PASS browser_snapshot refs')
    console.log('PASS browser_extract_links controlled_link')
    console.log('PASS browser_type and browser_click page_state')
    console.log('PASS browser_navigate controlled_destination')
    console.log('Chrome extension smoke test passed')
  } finally {
    await context?.close()
    await closeServer(server)
    await rm(userDataDir, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(`Chrome extension smoke test failed: ${error.message}`)
  process.exitCode = 1
})
