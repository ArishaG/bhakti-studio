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
// `#checkin_table_filter_input` id instead. The Status cell shows "Check in"
// text when not yet checked in, and "Undo check-in" once they are (rendered
// to look like a bare checkmark, but the text is real) — the two are
// mutually exclusive states of the same row, and clicking either one
// toggles to the other. req.checkedIn says which state we want; if the row
// is already there, this is a no-op.
//
// The Check-in page itself is reached directly via /checkin?eid=<eventId> —
// confirmed from a real (different event's) check-in URL, so this is the
// same templated route for any event, not a guess.
export async function performEventbriteCheckIn(req: CheckInRequest): Promise<CheckInResult> {
  const context = await getContext()
  const page = await context.newPage()
  try {
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

    const checkInText = row.getByText(/^check.?in$/i)
    const undoText = row.getByText(/^undo check-in$/i)
    await Promise.race([
      checkInText.first().waitFor({ state: 'attached', timeout: 5_000 }).catch(() => {}),
      undoText.first().waitFor({ state: 'attached', timeout: 5_000 }).catch(() => {}),
    ])
    const isCurrentlyCheckedIn = (await undoText.count()) > 0

    if (isCurrentlyCheckedIn !== req.checkedIn) {
      const clickTarget = req.checkedIn ? checkInText : undoText
      const expectAfter = req.checkedIn ? undoText : checkInText
      const clickLabel = req.checkedIn ? 'Check in' : 'Undo check-in'
      const expectLabel = req.checkedIn ? 'Undo check-in' : 'Check in'

      // `force` clicks have reported success here without the change
      // actually registering on Eventbrite's side (verified independently
      // via their read API) — almost certainly the live-polling table
      // replacing the row out from under a single click. So: don't trust
      // the click not throwing — re-resolve and retry until the row's own
      // text actually flips to the expected state, and fail loudly if it
      // never does.
      let confirmed = false
      for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
        await clickTarget.first().click({ timeout: 8_000, force: true })
        await expectAfter.first().waitFor({ state: 'attached', timeout: 4_000 }).catch(() => {})
        confirmed = (await expectAfter.count()) > 0
      }
      if (!confirmed) {
        throw new Error(
          `Clicked "${clickLabel}" but the row never showed "${expectLabel}" — the change did not register on Eventbrite.`
        )
      }
    }

    await persistStorageState()
    return { ok: true }
  } catch (err) {
    lastFailureHtml = await page.content().catch(() => null)
    // Full-page screenshots can fail under Xvfb's fixed virtual display size
    // when the page is taller than the configured screen — fall back to a
    // viewport-only capture rather than losing the debug artifact entirely.
    lastFailureScreenshot =
      (await page.screenshot({ fullPage: true }).catch(() => null)) ??
      (await page.screenshot({ fullPage: false }).catch(() => null))
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' }
  } finally {
    await page.close()
  }
}

function isLoggedOut(page: Page): boolean {
  return page.url().includes('/signin')
}
