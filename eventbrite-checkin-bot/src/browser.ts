import fs from 'fs'
import path from 'path'
import { chromium } from 'playwright-extra'
import stealth from 'puppeteer-extra-plugin-stealth'
import type { BrowserContext } from 'playwright'

chromium.use(stealth())

const DATA_DIR = process.env.DATA_DIR ?? '/data'
export const STORAGE_STATE_PATH = path.join(DATA_DIR, 'storage-state.json')

export function hasStorageState(): boolean {
  return fs.existsSync(STORAGE_STATE_PATH)
}

let contextPromise: Promise<BrowserContext> | null = null

// One persistent context for the life of the process: same cookies/fingerprint
// across requests, which matters more for not tripping bot-detection than any
// single page-automation trick.
export async function getContext(): Promise<BrowserContext> {
  if (!contextPromise) {
    contextPromise = (async () => {
      const browser = await chromium.launch({ headless: false })
      return browser.newContext({
        storageState: hasStorageState() ? STORAGE_STATE_PATH : undefined,
        viewport: { width: 1280, height: 900 },
      })
    })()
  }
  return contextPromise
}

export async function persistStorageState(): Promise<void> {
  const context = await getContext()
  fs.mkdirSync(DATA_DIR, { recursive: true })
  await context.storageState({ path: STORAGE_STATE_PATH })
}
