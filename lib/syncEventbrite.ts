import type { SupabaseClient } from '@supabase/supabase-js'
import { eventbriteFetchAllEvents, eventbriteFetchAllAttendees } from '@/lib/eventbrite'
import { canonicalSeriesName, classifySeries } from '@/lib/eventTagging'

// Events are first matched to existing event_instances (usually imported
// from Arketa) by exact/near start-time match, so Eventbrite acts as a
// second source of attendance/check-in data for events that already exist
// on the calendar. For events with no match anywhere (e.g. anything from
// before the studio adopted Arketa in Nov 2025), Eventbrite is the only
// source of truth, so a new event_series/event_instance is created for them
// here instead of dropping the attendance data.
const MATCH_TOLERANCE_MS = 3 * 60 * 1000

export type EventbriteSyncResult = {
  eventsMatched: number
  eventsCreated: number
  attendees: { checkedIn: number; registered: number; skippedCancelled: number }
  peopleCreated: number
  attendancesCreated: number
  attendancesUpdated: number
  attendancesSkipped: number
}

type AttendeeStats = {
  checkedIn: number
  registered: number
  skippedCancelled: number
  peopleCreated: number
  attendancesCreated: number
  attendancesUpdated: number
  attendancesSkipped: number
}

function emptyStats(): AttendeeStats {
  return {
    checkedIn: 0,
    registered: 0,
    skippedCancelled: 0,
    peopleCreated: 0,
    attendancesCreated: 0,
    attendancesUpdated: 0,
    attendancesSkipped: 0,
  }
}

// Pulls one event's attendees and upserts them into people / attendances.
// Pulled out so the single-event refresh path (below) can sync just one
// event's attendees without paying for a full org-wide events/attendees crawl.
async function syncEventAttendees(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  eventId: string,
  instanceId: string,
  personIdByEmail: Map<string, string>,
  stats: AttendeeStats
): Promise<void> {
  const attendees = await eventbriteFetchAllAttendees(eventId)

  for (const a of attendees) {
    if (a.cancelled || a.refunded) {
      stats.skippedCancelled++
      continue
    }
    a.checked_in ? stats.checkedIn++ : stats.registered++

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
      stats.peopleCreated++
    }

    if (email) personIdByEmail.set(email, personId!)

    const checkedInAt = a.checked_in ? a.changed || a.created : a.created
    const paid = a.costs.gross.value > 0
    const ticketType = a.ticket_class_name?.trim() || null

    const { data: updated, error: updErr } = await supabase
      .from('attendances')
      .update({ checked_in: a.checked_in, checked_in_at: checkedInAt, paid, ticket_type: ticketType })
      .eq('eventbrite_attendee_id', a.id)
      .select('id')
    if (updErr) throw updErr

    if (updated && updated.length > 0) {
      stats.attendancesUpdated++
      continue
    }

    const { error: attErr } = await supabase.from('attendances').insert({
      person_id: personId!,
      event_instance_id: instanceId,
      checked_in_at: checkedInAt,
      checked_in: a.checked_in,
      paid,
      ticket_type: ticketType,
      source: 'eventbrite',
      eventbrite_attendee_id: a.id,
    })

    if (attErr) {
      if (attErr.code === '23505') stats.attendancesSkipped++
      else throw attErr
    } else {
      stats.attendancesCreated++
    }
  }
}

function toResult(
  stats: AttendeeStats,
  extra: { eventsMatched: number; eventsCreated: number }
): EventbriteSyncResult {
  return {
    ...extra,
    attendees: {
      checkedIn: stats.checkedIn,
      registered: stats.registered,
      skippedCancelled: stats.skippedCancelled,
    },
    peopleCreated: stats.peopleCreated,
    attendancesCreated: stats.attendancesCreated,
    attendancesUpdated: stats.attendancesUpdated,
    attendancesSkipped: stats.attendancesSkipped,
  }
}

// Idempotent: matches existing instances by eventbrite_id (from a prior run
// of this same backfill) or exact/near start time (from Arketa), attendees
// by eventbrite_attendee_id (so re-running this updates checked_in/paid
// status instead of just skipping), so it's safe to re-run from a button, a
// cron job, or a webhook-triggered refresh.
//
// Passing eventInstanceId skips the org-wide events/attendees crawl entirely
// and syncs just that one instance's attendees — used by the check-in page's
// refresh button, which only cares about one event and was paying for a full
// 3-month backfill (one HTTP round trip per event) on every click.
export async function syncEventbrite(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  {
    sinceMonthsAgo = 3,
    sinceDays,
    eventInstanceId,
  }: { sinceMonthsAgo?: number; sinceDays?: number; eventInstanceId?: string } = {}
): Promise<EventbriteSyncResult> {
  const stats = emptyStats()

  if (eventInstanceId) {
    const { data: instance } = await supabase
      .from('event_instances')
      .select('id, eventbrite_id')
      .eq('id', eventInstanceId)
      .maybeSingle()

    if (instance?.eventbrite_id) {
      await syncEventAttendees(supabase, instance.eventbrite_id, instance.id, new Map(), stats)
      await supabase.from('people').update({ is_active: true }).gte('event_count', 3)
    }

    return toResult(stats, {
      eventsMatched: instance?.eventbrite_id ? 1 : 0,
      eventsCreated: 0,
    })
  }

  const allEvents = await eventbriteFetchAllEvents(process.env.EVENTBRITE_ORG_ID!)

  const cutoff = new Date()
  if (sinceDays !== undefined) cutoff.setDate(cutoff.getDate() - sinceDays)
  else cutoff.setMonth(cutoff.getMonth() - sinceMonthsAgo)

  const events = allEvents.filter(
    e => e.status !== 'canceled' && e.status !== 'draft' && new Date(e.start.utc) >= cutoff
  )

  const { data: instances } = await supabase
    .from('event_instances')
    .select('id, date, eventbrite_id')
  const instanceList = instances ?? []
  const instanceByExactDate = new Map(instanceList.map(i => [i.date, i.id as string]))
  const instanceByEventbriteId = new Map(
    instanceList.filter(i => i.eventbrite_id).map(i => [i.eventbrite_id as string, i.id as string])
  )

  const { data: existingSeries } = await supabase.from('event_series').select('id, name')
  const seriesIdByName = new Map((existingSeries ?? []).map(s => [s.name, s.id as string]))

  let eventsMatched = 0
  let eventsCreated = 0
  const matches: { eventId: string; instanceId: string }[] = []

  for (const e of events) {
    // 1. previously-created instance from an earlier run of this backfill
    const byEventbriteId = instanceByEventbriteId.get(e.id)
    if (byEventbriteId) {
      matches.push({ eventId: e.id, instanceId: byEventbriteId })
      eventsMatched++
      continue
    }

    // 2. exact start-time match against an existing instance (usually Arketa)
    const exact = instanceByExactDate.get(e.start.utc)
    if (exact) {
      matches.push({ eventId: e.id, instanceId: exact })
      await backfillEventbriteId(supabase, exact, e.id, instanceByEventbriteId)
      eventsMatched++
      continue
    }

    // 3. near-time match (clock skew between platforms)
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
      await backfillEventbriteId(supabase, nearest.id, e.id, instanceByEventbriteId)
      eventsMatched++
      continue
    }

    // 4. no instance anywhere — Eventbrite is the only source for this
    // event, so create its series (if needed) and instance now.
    const seriesName = canonicalSeriesName(e.name.text)
    let seriesId = seriesIdByName.get(seriesName)
    if (!seriesId) {
      const { data: newSeries, error } = await supabase
        .from('event_series')
        .insert({ name: seriesName, tag: classifySeries(seriesName) })
        .select('id')
        .single()
      if (error) throw error
      seriesId = newSeries.id
      seriesIdByName.set(seriesName, seriesId!)
    }

    const { data: newInstance, error: instErr } = await supabase
      .from('event_instances')
      .insert({ series_id: seriesId, date: e.start.utc, eventbrite_id: e.id })
      .select('id')
      .single()
    if (instErr) throw instErr

    matches.push({ eventId: e.id, instanceId: newInstance.id })
    instanceByEventbriteId.set(e.id, newInstance.id)
    eventsCreated++
    eventsMatched++
  }

  const personIdByEmail = new Map<string, string>()

  for (const { eventId, instanceId } of matches) {
    await syncEventAttendees(supabase, eventId, instanceId, personIdByEmail, stats)
  }

  await supabase.from('people').update({ is_active: true }).gte('event_count', 3)

  return toResult(stats, { eventsMatched, eventsCreated })
}

// Instances matched by time (cases 2/3 above) are usually Arketa-created and
// never had eventbrite_id set — until now nothing wrote it back, so every
// event matched that way stayed permanently unlinked for anything that
// depends on event_instances.eventbrite_id (e.g. pushing a check-in to
// Eventbrite). Idempotent: a no-op once set.
async function backfillEventbriteId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  instanceId: string,
  eventbriteId: string,
  instanceByEventbriteId: Map<string, string>
): Promise<void> {
  if (instanceByEventbriteId.get(eventbriteId) === instanceId) return
  const { error } = await supabase
    .from('event_instances')
    .update({ eventbrite_id: eventbriteId })
    .eq('id', instanceId)
    .is('eventbrite_id', null)
  if (error) throw error
  instanceByEventbriteId.set(eventbriteId, instanceId)
}
