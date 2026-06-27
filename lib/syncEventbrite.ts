import type { SupabaseClient } from '@supabase/supabase-js'
import { eventbriteFetchAllEvents, eventbriteFetchAllAttendees } from '@/lib/eventbrite'

// Events are matched to existing event_instances (imported from Arketa) by
// exact start-time match — Eventbrite is only used here as a second source of
// attendance/check-in data for events that already exist on the calendar, not
// as a source of new events.
const MATCH_TOLERANCE_MS = 3 * 60 * 1000

export type EventbriteSyncResult = {
  eventsMatched: number
  eventsUnmatched: number
  attendees: { checkedIn: number; registered: number; skippedCancelled: number }
  peopleCreated: number
  attendancesCreated: number
  attendancesUpdated: number
  attendancesSkipped: number
}

// Idempotent: matches existing instances by exact/near start time, attendees
// by eventbrite_attendee_id (so re-running this updates checked_in/paid
// status instead of just skipping), so it's safe to re-run from a button, a
// cron job, or a webhook-triggered refresh.
export async function syncEventbrite(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  { sinceMonthsAgo = 3, sinceDays }: { sinceMonthsAgo?: number; sinceDays?: number } = {}
): Promise<EventbriteSyncResult> {
  const allEvents = await eventbriteFetchAllEvents(process.env.EVENTBRITE_ORG_ID!)

  const cutoff = new Date()
  if (sinceDays !== undefined) cutoff.setDate(cutoff.getDate() - sinceDays)
  else cutoff.setMonth(cutoff.getMonth() - sinceMonthsAgo)

  const events = allEvents.filter(
    e => e.status !== 'canceled' && new Date(e.start.utc) >= cutoff
  )

  const { data: instances } = await supabase.from('event_instances').select('id, date')
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

  let checkedIn = 0
  let registered = 0
  let skippedCancelled = 0
  let peopleCreated = 0
  let attendancesCreated = 0
  let attendancesUpdated = 0
  let attendancesSkipped = 0
  const personIdByEmail = new Map<string, string>()

  for (const { eventId, instanceId } of matches) {
    const attendees = await eventbriteFetchAllAttendees(eventId)

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
      const paid = a.costs.gross.value > 0

      const { data: updated, error: updErr } = await supabase
        .from('attendances')
        .update({ checked_in: a.checked_in, checked_in_at: checkedInAt, paid })
        .eq('eventbrite_attendee_id', a.id)
        .select('id')
      if (updErr) throw updErr

      if (updated && updated.length > 0) {
        attendancesUpdated++
        continue
      }

      const { error: attErr } = await supabase.from('attendances').insert({
        person_id: personId!,
        event_instance_id: instanceId,
        checked_in_at: checkedInAt,
        checked_in: a.checked_in,
        paid,
        source: 'eventbrite',
        eventbrite_attendee_id: a.id,
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

  return {
    eventsMatched,
    eventsUnmatched,
    attendees: { checkedIn, registered, skippedCancelled },
    peopleCreated,
    attendancesCreated,
    attendancesUpdated,
    attendancesSkipped,
  }
}
