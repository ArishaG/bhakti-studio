import { createClient } from '@/lib/supabase/server'

// ─── Types ────────────────────────────────────────────────────────────────────

type EBEvent = {
  id: string
  name: { text: string }
  start: { utc: string }
  status: string
}

type EBAttendeeProfile = {
  first_name: string | null
  last_name: string | null
  email: string | null
  name: string | null
}

type EBAttendee = {
  profile: EBAttendeeProfile
  checked_in: boolean
  cancelled: boolean
  refunded: boolean
  created: string
  changed: string
}

// ─── Eventbrite client ────────────────────────────────────────────────────────
// Events are matched to existing event_instances (imported from Arketa) by
// exact start-time match — Eventbrite is only used here as a second source of
// attendance/check-in data for events that already exist on the calendar, not
// as a source of new events.

const EB_BASE = 'https://www.eventbriteapi.com/v3'

async function eventbriteGet<T>(path: string): Promise<T> {
  const res = await fetch(`${EB_BASE}${path}`, {
    headers: { Authorization: `Bearer ${process.env.EVENTBRITE_API_KEY}` },
  })
  if (!res.ok) throw new Error(`Eventbrite GET ${path} -> ${res.status}`)
  return res.json()
}

async function fetchAllEvents(orgId: string): Promise<EBEvent[]> {
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

async function fetchAllAttendees(eventId: string): Promise<EBAttendee[]> {
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

const MATCH_TOLERANCE_MS = 3 * 60 * 1000

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  if (!process.env.EVENTBRITE_API_KEY || !process.env.EVENTBRITE_ORG_ID) {
    return Response.json({ error: 'Eventbrite is not configured' }, { status: 500 })
  }

  const allEvents = await fetchAllEvents(process.env.EVENTBRITE_ORG_ID)

  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - 3)

  const events = allEvents.filter(
    e => e.status !== 'canceled' && new Date(e.start.utc) >= cutoff
  )

  // ── Match each Eventbrite event to an existing event_instance by start time ──
  const { data: instances } = await supabase
    .from('event_instances')
    .select('id, date')
  const instanceList = instances ?? []
  const instanceByExactDate = new Map(instanceList.map(i => [i.date, i.id as string]))

  let eventsMatched = 0
  let eventsUnmatched = 0
  const matches: { eventId: string; instanceId: string }[] = []

  for (const e of events) {
    const exact = instanceByExactDate.get(e.start.utc)
    if (exact) {
      matches.push({ eventId: e.id, instanceId: exact })
      eventsMatched++
      continue
    }
    const evtTime = new Date(e.start.utc).getTime()
    let nearest: { id: string; diff: number } | null = null
    for (const inst of instanceList) {
      const diff = Math.abs(new Date(inst.date).getTime() - evtTime)
      if (diff <= MATCH_TOLERANCE_MS && (!nearest || diff < nearest.diff)) {
        nearest = { id: inst.id as string, diff }
      }
    }
    if (nearest) {
      matches.push({ eventId: e.id, instanceId: nearest.id })
      eventsMatched++
    } else {
      eventsUnmatched++
    }
  }

  // ── Attendees -> people + attendances ───────────────────────────────────
  let checkedIn = 0
  let registered = 0
  let skippedCancelled = 0
  let peopleCreated = 0
  let attendancesCreated = 0
  let attendancesSkipped = 0
  const personIdByEmail = new Map<string, string>()

  for (const { eventId, instanceId } of matches) {
    const attendees = await fetchAllAttendees(eventId)

    for (const a of attendees) {
      if (a.cancelled || a.refunded) {
        skippedCancelled++
        continue
      }
      a.checked_in ? checkedIn++ : registered++

      const email = a.profile.email?.trim().toLowerCase() || null
      const fullName =
        a.profile.name?.trim() ||
        `${a.profile.first_name ?? ''} ${a.profile.last_name ?? ''}`.trim() ||
        'Unknown'

      let personId = email ? personIdByEmail.get(email) ?? null : null

      if (!personId && email) {
        const { data: existingPerson } = await supabase
          .from('people')
          .select('id')
          .ilike('email', email)
          .limit(1)
          .maybeSingle()
        personId = existingPerson?.id ?? null
      }

      if (!personId) {
        const { data: newPerson, error } = await supabase
          .from('people')
          .insert(email ? { name: fullName, email } : { name: fullName })
          .select('id')
          .single()
        if (error) throw error
        personId = newPerson.id
        peopleCreated++
      }

      if (email) personIdByEmail.set(email, personId!)

      const checkedInAt = a.checked_in ? a.changed || a.created : a.created

      const { error: attErr } = await supabase.from('attendances').insert({
        person_id: personId!,
        event_instance_id: instanceId,
        checked_in_at: checkedInAt,
        source: 'eventbrite',
      })

      if (attErr) {
        if (attErr.code === '23505') attendancesSkipped++
        else throw attErr
      } else {
        attendancesCreated++
      }
    }
  }

  await supabase.from('people').update({ is_active: true }).gte('event_count', 3)

  return Response.json({
    eventsMatched,
    eventsUnmatched,
    attendees: { checkedIn, registered, skippedCancelled },
    peopleCreated,
    attendancesCreated,
    attendancesSkipped,
  })
}
