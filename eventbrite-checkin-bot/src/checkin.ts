import type { Page } from 'playwright'
import { getContext, persistStorageState } from './browser.js'

export type CheckInRequest = {
  eventbriteEventId: string
  attendeeEmail: string | null
  attendeeName: string
  checkedIn: boolean
}

export type CheckInResult = { ok: true } | { ok: false; error: string }

let lastFailureHtml: string | null = null
let lastFailureScreenshot: Buffer | null = null

export function getLastFailureDebug() {
  return { html: lastFailureHtml, screenshot: lastFailureScreenshot }
}

// Confirmed against the real page HTML (2026-06-29, from a logged failure):
// it's a genuine <table> with columns Attendee Name / Email / Ticket Type /
// Status. The search box has no `placeholder` attribute at all — its default
// text ("Enter name or email") is just its `value`, with a stable
// `#checkin_table_filter_input` id instead.
//
// The Status cell's *real* markup, also confirmed from a logged failure,
// turned out to be the actual bug behind silent no-op clicks: when not
// checked in, it's a visible `<span class="checkin_button" id="checkin_
// button_<ticketId>">Check in</span>` inside an `<a>`; once checked in, it's
// an `<i class="checkout_button" id="checkin_button_<ticketId>">` icon, and
// the "Undo check-in" text is wrapped in `<span class="is-hidden-
// accessible">` — a screen-reader-only element that is NOT the clickable
// target. Clicking that hidden text (what this used to do) doesn't reliably
// reach the real click handler. Both states share the same id pattern
// (`checkin_button_<ticketId>`) and sit next to a `<input type="hidden"
// value="0|1">` that's a far more reliable state signal than scraped text.
// This now clicks `[id^="checkin_button_"]` and verifies via that hidden
// input's value, not text.
//
// The Check-in page itself is reached directly via /checkin?eid=<eventId> —
// confirmed from a real (different event's) check-in URL, so this is the
// same templated route for any event, not a guess.
// Individual steps (search box attaching, the row appearing, a click
// registering) have each intermittently failed on an otherwise-working setup
// — most likely Eventbrite occasionally being slow to render rather than
// anything wrong with the selectors themselves, since debug captures taken
// moments after a failure routinely show the exact element rendered fine.
// So the whole flow retries on a fresh page rather than only individual
// steps within one attempt, and only the final attempt's failure is kept
// for debugging.
export async function performEventbriteCheckIn(req: CheckInRequest): Promise<CheckInResult> {
  const maxAttempts = 3
  let lastError: unknown = null

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const context = await getContext()
    const page = await context.newPage()
    try {
      const result = await attemptCheckIn(page, req)
      await page.close()
      return result
    } catch (err) {
      lastError = err
      lastFailureHtml = await page.content().catch(() => null)
      // Full-page screenshots can fail under Xvfb's fixed virtual display
      // size when the page is taller than the configured screen — fall back
      // to a viewport-only capture rather than losing the debug artifact.
      lastFailureScreenshot =
        (await page.screenshot({ fullPage: true }).catch(() => null)) ??
        (await page.screenshot({ fullPage: false }).catch(() => null))
      await page.close()
    }
  }

  return { ok: false, error: lastError instanceof Error ? lastError.message : 'Unknown error' }
}

async function attemptCheckIn(page: Page, req: CheckInRequest): Promise<CheckInResult> {
  await page.goto(`https://www.eventbrite.com/checkin?eid=${req.eventbriteEventId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  })

  if (isLoggedOut(page)) {
    return {
      ok: false,
      error: 'Eventbrite session expired — run `npm run login` again and update EVENTBRITE_STORAGE_STATE_B64.',
    }
  }

  const query = req.attendeeEmail ?? req.attendeeName
  const search = page.locator('#checkin_table_filter_input')
  // A plain visibility/stability wait (Playwright's default actionability
  // check before click/fill) never settles here even given 25s — it's
  // visible in any single screenshot, so something on the page likely
  // keeps re-rendering it (e.g. a live-polling attendee list), which
  // never lets Playwright see it as "stable." `force` skips that check
  // and fills directly once the element merely exists.
  await search.waitFor({ state: 'attached', timeout: 25_000 })
  await search.fill(query, { force: true })
  await page.waitForTimeout(800) // results filter client-side; give it a beat

  const row = page.getByRole('row', { name: query }).first()
  await row.waitFor({ timeout: 12_000 })

  const stateInput = row.locator('.row_control_cell input[type="hidden"]').first()
  const clickTarget = row.locator('[id^="checkin_button_"]').first()
  await stateInput.waitFor({ state: 'attached', timeout: 8_000 })

  const currentValue = await stateInput.getAttribute('value')
  const isCurrentlyCheckedIn = currentValue === '1'

  if (isCurrentlyCheckedIn !== req.checkedIn) {
    // A click not throwing isn't proof it worked — verified independently
    // via Eventbrite's read API that a force-click could report success
    // with no actual change. Re-check the hidden input's real value after
    // each attempt rather than trusting the click itself.
    let confirmed = false
    for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
      await clickTarget.click({ timeout: 8_000, force: true })
      await page.waitForTimeout(1_000) // AJAX call + row re-render
      const newValue = await stateInput.getAttribute('value').catch(() => null)
      confirmed = newValue === (req.checkedIn ? '1' : '0')
    }
    if (!confirmed) {
      throw new Error(
        `Clicked check-in toggle but the row's state never flipped to ${req.checkedIn ? 'checked-in' : 'not-checked-in'} — the change did not register on Eventbrite.`
      )
    }
  }

  await persistStorageState()
  return { ok: true }
}

function isLoggedOut(page: Page): boolean {
  return page.url().includes('/signin')
}
