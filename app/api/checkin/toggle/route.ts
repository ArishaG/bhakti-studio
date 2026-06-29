import { createClient } from '@/lib/supabase/server'
import { arketaCheckInReservation } from '@/lib/arketa'
import { pushEventbriteCheckIn } from '@/lib/eventbriteCheckinBot'

// ─── Route handler ────────────────────────────────────────────────────────────
// Toggles an attendance's checked_in state. Checking someone in who came from
// an Arketa reservation also pushes the check-in to Arketa (their API
// supports this); Eventbrite attendees push to the eventbrite-checkin-bot
// service instead (Eventbrite has no public write endpoint, so that bot
// drives a real browser against their organizer UI) for *both* checking in
// and un-checking, since the bot can click either "Check in" or "Undo
// check-in" on the row. Un-checking on Arketa has no documented endpoint and
// stays local-only. Both pushes are best-effort, and the caller is told
// which happened so the UI can show a fallback reminder if either fails.

export async function POST(req: Request) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  const { attendanceId, checkedIn } = (await req.json()) as {
    attendanceId: string
    checkedIn: boolean
  }
  if (!attendanceId || typeof checkedIn !== 'boolean') {
    return Response.json({ error: 'attendanceId and checkedIn are required' }, { status: 400 })
  }

  const { data: attendance, error: fetchErr } = await supabase
    .from('attendances')
    .select('id, person_id, event_instance_id, source, arketa_reservation_id')
    .eq('id', attendanceId)
    .single()
  if (fetchErr) throw fetchErr

  const { error: updErr } = await supabase
    .from('attendances')
    .update({
      checked_in: checkedIn,
      ...(checkedIn ? { checked_in_at: new Date().toISOString() } : {}),
    })
    .eq('id', attendanceId)
  if (updErr) throw updErr

  let arketaPushed = false
  let arketaError: string | null = null
  let eventbritePushed = false
  let eventbriteError: string | null = null

  if (checkedIn) {
    const { data: person } = await supabase
      .from('people')
      .select('event_count')
      .eq('id', attendance.person_id)
      .single()

    await supabase
      .from('people')
      .update({
        last_seen_at: new Date().toISOString(),
        ...((person?.event_count ?? 0) >= 3 && { is_active: true }),
      })
      .eq('id', attendance.person_id)

    if (attendance.source === 'arketa' && attendance.arketa_reservation_id) {
      const { data: instance } = await supabase
        .from('event_instances')
        .select('arketa_id')
        .eq('id', attendance.event_instance_id)
        .single()

      if (instance?.arketa_id) {
        try {
          await arketaCheckInReservation(instance.arketa_id, attendance.arketa_reservation_id)
          arketaPushed = true
        } catch (err) {
          arketaError = err instanceof Error ? err.message : 'Unknown error'
        }
      }
    }
  }

  if (attendance.source === 'eventbrite') {
    const { data: instance } = await supabase
      .from('event_instances')
      .select('eventbrite_id')
      .eq('id', attendance.event_instance_id)
      .single()

    if (instance?.eventbrite_id) {
      const { data: personRow } = await supabase
        .from('people')
        .select('name, email')
        .eq('id', attendance.person_id)
        .single()

      if (personRow) {
        try {
          await pushEventbriteCheckIn(instance.eventbrite_id, personRow.email, personRow.name, checkedIn)
          eventbritePushed = true
        } catch (err) {
          eventbriteError = err instanceof Error ? err.message : 'Unknown error'
        }
      }
    }
  }

  return Response.json({ ok: true, arketaPushed, arketaError, eventbritePushed, eventbriteError })
}
