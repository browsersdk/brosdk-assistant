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
      <p id="controlled-status">Controlled: idle</p>
      <label for="blocked">Blocked field</label>
      <input id="blocked" placeholder="Input is cancelled">
      <button id="apply" type="button">Apply task</button>
      <p id="status" aria-live="polite">Idle</p>
    </main>
    <script>
      const query = document.querySelector('#query')
      const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
      let trackedValue = query.value
      Object.defineProperty(query, 'value', {
        configurable: true,
        get() {
          return nativeValue.get.call(this)
        },
        set(value) {
          trackedValue = String(value)
          nativeValue.set.call(this, value)
        },
      })
      const inputEvents = []
      for (const eventName of ['focus', 'beforeinput', 'input', 'change']) {
        query.addEventListener(eventName, () => {
          inputEvents.push(eventName)
          query.dataset.events = inputEvents.join(',')
        })
      }
      query.addEventListener('input', () => {
        const domValue = nativeValue.get.call(query)
        if (domValue !== trackedValue) {
          trackedValue = domValue
          document.querySelector('#controlled-status').textContent = 'Controlled: ' + domValue
        }
      })
      document.querySelector('#blocked').addEventListener('beforeinput', (event) => {
        event.preventDefault()
      })
      document.querySelector('#apply').addEventListener('click', () => {
        document.querySelector('#status').textContent =
          'Applied: ' + query.value
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

const slowPageHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Brosdk Slow Page</title>
  </head>
  <body>
    <main><h1>Slow navigation complete</h1></main>
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

async function sendToolRequest(extensionPage, name, args = {}) {
  return extensionPage.evaluate(
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
}

async function invokeTool(extensionPage, name, args = {}) {
  const response = await sendToolRequest(extensionPage, name, args)
  assert.equal(response?.ok, true, response?.error || `${name} failed`)
  return response.data
}

async function expectToolError(extensionPage, name, args, expected) {
  const response = await sendToolRequest(extensionPage, name, args)
  assert.equal(
    response?.ok,
    false,
    `${name} unexpectedly succeeded: ${JSON.stringify(response?.data)}`,
  )
  assert.match(response.error || '', expected)
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
    if (request.url === '/slow') {
      setTimeout(() => {
        if (response.destroyed) return
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(slowPageHtml)
      }, 400)
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
    const extensionTab = tabsResult.tabs.find((tab) => tab.url?.startsWith('chrome-extension://'))
    assert(targetTab?.tabId, 'controlled page was not returned by browser_tabs')
    assert(extensionTab?.tabId, 'extension page was not returned by browser_tabs')
    const tabId = targetTab.tabId

    await targetPage.bringToFront()
    const activeResult = await invokeTool(extensionPage, 'browser_active_tab')
    assert.equal(activeResult.tab.tabId, tabId)
    assert.equal(activeResult.tab.title, 'Brosdk Extension Smoke Page')

    const readResult = await invokeTool(extensionPage, 'browser_read_page', { tabId })
    assert.equal(readResult.result.title, 'Brosdk Extension Smoke Page')
    assert.match(readResult.result.text, /deterministic page for browser tool verification/i)

    const firstSnapshot = await invokeTool(extensionPage, 'browser_snapshot', { tabId })
    const firstInput = firstSnapshot.result.elements.find((element) => element.selector === '#query')
    assert(firstInput?.ref, 'first snapshot did not return the task input')
    assert.equal(typeof firstSnapshot.documentId, 'string')
    assert.equal(typeof firstSnapshot.result.revision, 'number')
    assert.match(
      firstInput.ref,
      new RegExp(`^t${tabId}-r${firstSnapshot.result.revision}-e\\d+$`),
    )

    const secondSnapshot = await invokeTool(extensionPage, 'browser_snapshot', { tabId })
    assert.equal(secondSnapshot.result.revision, firstSnapshot.result.revision + 1)
    await expectToolError(
      extensionPage,
      'browser_type',
      { tabId, ref: firstInput.ref, text: 'stale-revision' },
      /latest snapshot revision/i,
    )

    const secondButton = secondSnapshot.result.elements.find(
      (element) => element.selector === '#apply',
    )
    assert(secondButton?.ref, 'second snapshot did not return the apply button')
    await targetPage.locator('#apply').evaluate((button) => {
      button.textContent = 'Apply updated task'
    })
    assert.equal(await targetPage.locator('#apply').textContent(), 'Apply updated task')
    await expectToolError(
      extensionPage,
      'browser_click',
      { tabId, ref: secondButton.ref },
      /page or target element changed/i,
    )

    const snapshotResult = await invokeTool(extensionPage, 'browser_snapshot', { tabId })
    const input = snapshotResult.result.elements.find((element) => element.selector === '#query')
    const blockedInput = snapshotResult.result.elements.find(
      (element) => element.selector === '#blocked',
    )
    const button = snapshotResult.result.elements.find((element) => element.selector === '#apply')
    assert(input?.ref, 'latest snapshot did not return the task input')
    assert(blockedInput?.ref, 'latest snapshot did not return the blocked input')
    assert(button?.ref, 'latest snapshot did not return the apply button')
    await expectToolError(
      extensionPage,
      'browser_click',
      { tabId: extensionTab.tabId, ref: button.ref },
      /does not belong to tab/i,
    )
    await expectToolError(
      extensionPage,
      'browser_type',
      { tabId, ref: blockedInput.ref, text: 'should-not-apply' },
      /text input was cancelled by the page/i,
    )

    const linksResult = await invokeTool(extensionPage, 'browser_extract_links', { tabId })
    assert(
      linksResult.result.links.some(
        (link) => link.text === 'Read the local docs' && link.href === `${pageUrl}docs`,
      ),
      'browser_extract_links did not return the controlled link',
    )
    await expectToolError(
      extensionPage,
      'browser_click',
      { tabId, selector: '#missing-target' },
      /target element not found/i,
    )

    const typeResult = await invokeTool(extensionPage, 'browser_type', {
      tabId,
      ref: input.ref,
      text: 'extension-smoke',
    })
    assert.equal(await targetPage.locator('#query').inputValue(), 'extension-smoke')
    await targetPage.getByText('Controlled: extension-smoke').waitFor()
    assert.equal(
      await targetPage.locator('#query').getAttribute('data-events'),
      'focus,beforeinput,input,change',
    )
    assert.equal(typeResult.result.diagnostics.valueSetter, 'native-prototype')
    assert.equal(typeResult.result.diagnostics.controlType, 'input:text')
    assert.equal(typeResult.result.diagnostics.inputEventType, 'insertReplacementText')
    assert.equal(typeResult.result.diagnostics.valueLength, 'extension-smoke'.length)
    assert.deepEqual(typeResult.result.diagnostics.events, ['beforeinput', 'input', 'change'])

    const clickResult = await invokeTool(extensionPage, 'browser_click', { tabId, ref: button.ref })
    assert.equal(clickResult.result.diagnostics.source, 'snapshot-ref')
    assert.equal(clickResult.result.diagnostics.target.name, 'Apply updated task')
    await targetPage.getByText('Applied: extension-smoke').waitFor()

    const timedNavigation = await invokeTool(extensionPage, 'browser_navigate', {
      tabId,
      url: `${pageUrl}slow`,
      timeoutMs: 100,
    })
    assert.equal(timedNavigation.navigation.status, 'timeout')
    assert.equal(timedNavigation.navigation.requestedUrl, `${pageUrl}slow`)
    assert.equal(timedNavigation.navigation.timeoutMs, 100)
    assert.equal(typeof timedNavigation.navigation.elapsedMs, 'number')
    await targetPage.waitForURL(`${pageUrl}slow`)
    await targetPage.getByRole('heading', { name: 'Slow navigation complete' }).waitFor()
    await expectToolError(
      extensionPage,
      'browser_click',
      { tabId, ref: button.ref },
      /expired|latest browser_snapshot/i,
    )

    const completedNavigation = await invokeTool(extensionPage, 'browser_navigate', {
      tabId,
      url: `${pageUrl}next`,
      timeoutMs: 5_000,
    })
    assert.equal(completedNavigation.navigation.status, 'complete')
    assert.equal(completedNavigation.navigation.finalUrl, `${pageUrl}next`)
    await targetPage.waitForURL(`${pageUrl}next`)
    await targetPage.getByRole('heading', { name: 'Navigation complete' }).waitFor()
    assert.deepEqual(pageErrors, [])

    console.log(`PASS browser_tabs extension_id=${extensionId}`)
    console.log('PASS browser_active_tab controlled_page')
    console.log('PASS browser_read_page controlled_content')
    console.log('PASS browser_snapshot tab_document_revision_refs')
    console.log('PASS stale_revision changed_target cross_tab and navigation_rejection')
    console.log('PASS browser_extract_links controlled_link')
    console.log('PASS browser DOM errors propagate to the background worker')
    console.log('PASS browser_type controlled_input_events cancellation and diagnostics')
    console.log('PASS browser_click target diagnostics and page_state')
    console.log('PASS browser_navigate timeout complete and final_url diagnostics')
    console.log('Chrome extension smoke test passed')
  } finally {
    await context?.close()
    await closeServer(server)
    await rm(userDataDir, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(`Chrome extension smoke test failed: ${error.stack || error.message}`)
  process.exitCode = 1
})
