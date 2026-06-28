import type { Page } from 'playwright'
import { getContext, persistStorageState } from './browser.js'

export type CheckInRequest = {
  eventbriteEventId: string
  attendeeEmail: string | null
  attendeeName: string
}

export type CheckInResult = { ok: true } | { ok: false; error: string }

let lastFailureHtml: string | null = null
let lastFailureScreenshot: Buffer | null = null

export function getLastFailureDebug() {
  return { html: lastFailureHtml, screenshot: lastFailureScreenshot }
}

// Confirmed against a real screenshot of the page (2026-06-27): it's a
// genuine <table> with columns Attendee Name / Email / Ticket Type / Status.
// The search box's placeholder is "Enter name or email" (not "search"). The
// Status cell shows the text "Check in" when not yet checked in, and *only*
// a green checkmark icon — no text at all — once they are. That last part
// matters: this code must only click when it has positively found the
// not-yet-checked-in "Check in" text — if that text isn't there (already
// checked in), it must NOT click whatever else is in the row, since the
// checkmark's own click action un-checks them in.
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
    const search = page.getByPlaceholder(/name or email/i).first()
    await search.click({ timeout: 10_000 })
    await search.fill(query)
    await page.waitForTimeout(800) // results filter client-side; give it a beat

    const row = page.getByRole('row', { name: query }).first()
    await row.waitFor({ timeout: 8_000 })

    const checkInText = row.getByText(/^check.?in$/i)
    await checkInText.first().waitFor({ state: 'attached', timeout: 3_000 }).catch(() => {})
    const alreadyCheckedIn = (await checkInText.count()) === 0
    if (!alreadyCheckedIn) {
      await checkInText.first().click({ timeout: 8_000 })
      await page.waitForTimeout(500)
    }

    await persistStorageState()
    return { ok: true }
  } catch (err) {
    lastFailureHtml = await page.content().catch(() => null)
    lastFailureScreenshot = (await page.screenshot({ fullPage: true }).catch(() => null)) ?? null
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' }
  } finally {
    await page.close()
  }
}

function isLoggedOut(page: Page): boolean {
  return page.url().includes('/signin')
}
