// Calls the separate eventbrite-checkin-bot service (see
// /eventbrite-checkin-bot), which drives a real browser against Eventbrite's
// organizer UI — there's no public API for writing check-in status, so this
// is the only way to reflect a local check-in on Eventbrite's side. Best-
// effort: callers should not fail the local check-in if this throws.
export async function pushEventbriteCheckIn(
  eventbriteEventId: string,
  attendeeEmail: string | null,
  attendeeName: string
): Promise<void> {
  const baseUrl = process.env.EVENTBRITE_CHECKIN_BOT_URL
  if (!baseUrl) throw new Error('EVENTBRITE_CHECKIN_BOT_URL is not configured')

  const res = await fetch(`${baseUrl}/check-in`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.EVENTBRITE_CHECKIN_BOT_SECRET}`,
    },
    body: JSON.stringify({ eventbriteEventId, attendeeEmail, attendeeName }),
  })

  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.ok) {
    throw new Error(body?.error ?? `Eventbrite check-in bot -> ${res.status}`)
  }
}
