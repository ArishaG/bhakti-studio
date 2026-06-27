import { createAdminClient } from '@/lib/supabase/admin'
import { eventbriteGetUrl, verifyEventbriteSignature, type EBAttendee } from '@/lib/eventbrite'

// ─── Route handler ────────────────────────────────────────────────────────────
// Eventbrite webhook payloads are thin: { action, api_url }. We verify the
// signature, then re-fetch api_url to get the actual attendee, match it to an
// existing attendances row (or create one if this is the first we've heard of
// it), and update checked_in/paid. This is the near-real-time half of the
// Eventbrite sync — Arketa has no webhook equivalent, so it relies on polling.

export async function POST(req: Request) {
  const rawBody = await req.text()
  const signature = req.headers.get('x-eventbrite-signature')

  if (!verifyEventbriteSignature(rawBody, signature)) {
    return new Response('Invalid signature', { status: 401 })
  }

  const { action, api_url } = JSON.parse(rawBody) as { action: string; api_url: string }

  if (!action.startsWith('attendee.')) {
    return Response.json({ ok: true, skipped: true })
  }

  const attendee = await eventbriteGetUrl<EBAttendee>(api_url)
  const supabase = createAdminClient()

  if (attendee.cancelled || attendee.refunded) {
    return Response.json({ ok: true, skipped: true })
  }

  const checkedInAt = attendee.checked_in ? attendee.changed || attendee.created : attendee.created
  const paid = attendee.costs.gross.value > 0

  const { data: updated, error: updErr } = await supabase
    .from('attendances')
    .update({ checked_in: attendee.checked_in, checked_in_at: checkedInAt, paid })
    .eq('eventbrite_attendee_id', attendee.id)
    .select('id')
  if (updErr) throw updErr
  if (updated && updated.length > 0) {
    return Response.json({ ok: true, updated: true })
  }

  // Not yet known to us (e.g. a brand-new registration) — match the event by
  // start time and the person by email, same as the full sync route.
  const { data: ebEvent } = await fetch(
    `https://www.eventbriteapi.com/v3/events/${attendee.event_id}/`,
    { headers: { Authorization: `Bearer ${process.env.EVENTBRITE_API_KEY}` } }
  ).then(r => r.json())

  const startUtc: string | undefined = ebEvent?.start?.utc
  if (!startUtc) return Response.json({ ok: true, skipped: true })

  // Event_instances.date is stored as "+00:00", Eventbrite sends "Z" — these
  // never string-match, so compare actual instants within a small tolerance
  // rather than relying on exact equality.
  const MATCH_TOLERANCE_MS = 3 * 60 * 1000
  const targetTime = new Date(startUtc).getTime()
  const { data: candidateInstances } = await supabase
    .from('event_instances')
    .select('id, date')
    .gte('date', new Date(targetTime - MATCH_TOLERANCE_MS).toISOString())
    .lte('date', new Date(targetTime + MATCH_TOLERANCE_MS).toISOString())
  const instance = candidateInstances?.[0]
  if (!instance) return Response.json({ ok: true, skipped: true, reason: 'no matching event' })

  const email = attendee.profile.email?.trim().toLowerCase() || null
  const fullName =
    attendee.profile.name?.trim() ||
    `${attendee.profile.first_name ?? ''} ${attendee.profile.last_name ?? ''}`.trim() ||
    'Unknown'

  let personId: string | null = null
  if (email) {
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
  }

  const { error: insErr } = await supabase.from('attendances').insert({
    person_id: personId,
    event_instance_id: instance.id,
    checked_in_at: checkedInAt,
    checked_in: attendee.checked_in,
    paid,
    source: 'eventbrite',
    eventbrite_attendee_id: attendee.id,
  })
  if (insErr && insErr.code !== '23505') throw insErr

  return Response.json({ ok: true, created: true })
}
