import crypto from 'crypto'

const EB_BASE = 'https://www.eventbriteapi.com/v3'

export type EBEvent = {
  id: string
  name: { text: string }
  start: { utc: string }
  status: string
}

export type EBAttendee = {
  id: string
  profile: {
    first_name: string | null
    last_name: string | null
    email: string | null
    name: string | null
  }
  checked_in: boolean
  cancelled: boolean
  refunded: boolean
  created: string
  changed: string
  event_id: string
  costs: { gross: { value: number } }
  ticket_class_name: string | null
}

async function eventbriteGet<T>(path: string): Promise<T> {
  const res = await fetch(`${EB_BASE}${path}`, {
    headers: { Authorization: `Bearer ${process.env.EVENTBRITE_API_KEY}` },
  })
  if (!res.ok) throw new Error(`Eventbrite GET ${path} -> ${res.status}`)
  return res.json()
}

// Webhook payloads only contain an action + a URL to re-fetch the actual
// resource, so this hits that absolute URL directly rather than building
// one from a path.
export async function eventbriteGetUrl<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.EVENTBRITE_API_KEY}` },
  })
  if (!res.ok) throw new Error(`Eventbrite GET ${url} -> ${res.status}`)
  return res.json()
}

export async function eventbriteFetchAllEvents(orgId: string): Promise<EBEvent[]> {
  const events: EBEvent[] = []
  let continuation: string | undefined
  do {
    const qs = new URLSearchParams({ status: 'all', page_size: '50' })
    if (continuation) qs.set('continuation', continuation)
    const data = await eventbriteGet<{
      events: EBEvent[]
      pagination: { has_more_items: boolean; continuation?: string }
    }>(`/organizations/${orgId}/events/?${qs}`)
    events.push(...data.events)
    continuation = data.pagination.has_more_items ? data.pagination.continuation : undefined
  } while (continuation)
  return events
}

export async function eventbriteFetchAllAttendees(eventId: string): Promise<EBAttendee[]> {
  const attendees: EBAttendee[] = []
  let continuation: string | undefined
  do {
    const qs = new URLSearchParams()
    if (continuation) qs.set('continuation', continuation)
    const suffix = qs.toString() ? `?${qs}` : ''
    const data = await eventbriteGet<{
      attendees: EBAttendee[]
      pagination: { has_more_items: boolean; continuation?: string }
    }>(`/events/${eventId}/attendees/${suffix}`)
    attendees.push(...data.attendees)
    continuation = data.pagination.has_more_items ? data.pagination.continuation : undefined
  } while (continuation)
  return attendees
}

// Verifies the `x-eventbrite-signature` header: base64(HMAC-SHA256(rawBody, webhookKey)).
export function verifyEventbriteSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!signatureHeader || !process.env.EVENTBRITE_WEBHOOK_KEY) return false
  const expected = crypto
    .createHmac('sha256', process.env.EVENTBRITE_WEBHOOK_KEY)
    .update(rawBody)
    .digest('base64')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader))
  } catch {
    return false
  }
}
