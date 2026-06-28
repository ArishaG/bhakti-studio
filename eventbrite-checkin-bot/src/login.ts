// One-time, run locally (not in the container): opens a real, visible browser
// so a human can log into Eventbrite manually — handles 2FA/captcha the same
// way a normal login would, which an automated flow can't. Saves the
// resulting session so the bot can reuse it without ever seeing a password.
import path from 'path'
import { chromium } from 'playwright-extra'
import stealth from 'puppeteer-extra-plugin-stealth'

chromium.use(stealth())

const OUT_PATH = path.resolve(process.cwd(), 'storage-state.json')

async function main() {
  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('https://www.eventbrite.com/signin/')

  console.log('')
  console.log('A browser window has opened. Log into Eventbrite manually (including any 2FA).')
  console.log('Once you can see your Organizer dashboard, come back here and press Enter.')
  console.log('')
  await waitForEnter()

  await context.storageState({ path: OUT_PATH })
  console.log(`Saved session to ${OUT_PATH}`)
  console.log('')
  console.log('Next, set it as a secret on the bot (do NOT commit this file):')
  console.log('  fly secrets set EVENTBRITE_STORAGE_STATE_B64="$(base64 -w0 storage-state.json)"')
  console.log('')
  await browser.close()
}

function waitForEnter(): Promise<void> {
  return new Promise(resolve => {
    process.stdin.resume()
    process.stdin.once('data', () => resolve())
  })
}

main()
