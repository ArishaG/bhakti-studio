import { randomUUID } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  arketaFetchClasses,
  arketaFetchReservations,
  arketaFetchActivePurchaseClientIds,
} from '@/lib/arketa'
import { canonicalSeriesName, classifySeries } from '@/lib/eventTagging'

export type ArketaSyncResult = {
  seriesCreated: number
  instancesCreated: number
  instancesUpdated: number
  reservations: { attended: number; booked: number; cancelled: number }
  peopleCreated: number
  attendancesCreated: number
  attendancesUpdated: number
  attendancesSkipped: number
}

type ReservationStats = {
  attended: number
  booked: number
  cancelled: number
  peopleCreated: number
  attendancesCreated: number
  attendancesUpdated: number
  attendancesSkipped: number
}

function emptyStats(): ReservationStats {
  return {
    attended: 0,
    booked: 0,
    cancelled: 0,
    peopleCreated: 0,
    attendancesCreated: 0,
    attendancesUpdated: 0,
    attendancesSkipped: 0,
  }
}

// Pulls one class's reservations and upserts them into people / attendances.
// Pulled out so the single-event refresh path (below) can sync just one
// class's reservations without paying for a full classes/reservations crawl.
async function syncClassReservations(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  classId: string,
  instanceId: string,
  classStartTime: string,
  activePurchaseClientIds: Set<string>,
  personIdByEmail: Map<string, string>,
  stats: ReservationStats
): Promise<void> {
  const reservations = await arketaFetchReservations(classId)

  for (const r of reservations) {
    if (r.status === 'CANCELLED') {
      stats.cancelled++
      continue
    }
    r.checked_in ? stats.attended++ : stats.booked++

    const email = r.client?.email?.trim().toLowerCase() || null
    const fullName =
      `${r.client?.first_name ?? ''} ${r.client?.last_name ?? ''}`.trim() || 'Unknown'
    const phone = r.client?.phone ?? null

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
        .insert(email ? { name: fullName, email, phone } : { name: fullName, phone })
        .select('id')
        .single()
      if (error) throw error
      personId = newPerson.id
      stats.peopleCreated++
    }

    if (email) personIdByEmail.set(email, personId!)

    const checkedInAt = r.checked_in_at || r.created_at || classStartTime
    const paid = activePurchaseClientIds.has(r.client_id)

    const { data: updated, error: updErr } = await supabase
      .from('attendances')
      .update({ checked_in: r.checked_in, checked_in_at: checkedInAt, paid })
      .eq('arketa_reservation_id', r.id)
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
      checked_in: r.checked_in,
      paid,
      source: 'arketa',
      arketa_reservation_id: r.id,
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
  stats: ReservationStats,
  extra: { seriesCreated: number; instancesCreated: number; instancesUpdated: number }
): ArketaSyncResult {
  return {
    ...extra,
    reservations: { attended: stats.attended, booked: stats.booked, cancelled: stats.cancelled },
    peopleCreated: stats.peopleCreated,
    attendancesCreated: stats.attendancesCreated,
    attendancesUpdated: stats.attendancesUpdated,
    attendancesSkipped: stats.attendancesSkipped,
  }
}

// Imports Arketa classes within [sinceMonthsAgo, future] into event_series /
// event_instances, and their reservations into people / attendances
// (source='arketa'). Idempotent: matches existing series by name, instances
// by arketa_id, attendances by arketa_reservation_id (so re-running this
// updates checked_in/paid status instead of just skipping), so it's safe to
// re-run from a button, a cron job, or a webhook-triggered refresh.
//
// Passing eventInstanceId skips the classes-wide crawl entirely and syncs
// just that one instance's reservations — used by the check-in page's
// refresh button, which only cares about one event and was paying for a
// full 3-month backfill (one HTTP round trip per class) on every click.
export async function syncArketa(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  {
    sinceMonthsAgo = 3,
    sinceDays,
    eventInstanceId,
  }: { sinceMonthsAgo?: number; sinceDays?: number; eventInstanceId?: string } = {}
): Promise<ArketaSyncResult> {
  const stats = emptyStats()

  if (eventInstanceId) {
    const { data: instance } = await supabase
      .from('event_instances')
      .select('id, arketa_id, date')
      .eq('id', eventInstanceId)
      .maybeSingle()

    if (instance?.arketa_id) {
      const activePurchaseClientIds = await arketaFetchActivePurchaseClientIds()
      await syncClassReservations(
        supabase,
        instance.arketa_id,
        instance.id,
        instance.date,
        activePurchaseClientIds,
        new Map(),
        stats
      )
      await supabase.from('people').update({ is_active: true }).gte('event_count', 3)
    }

    return toResult(stats, { seriesCreated: 0, instancesCreated: 0, instancesUpdated: 0 })
  }

  const rawClasses = await arketaFetchClasses()

  const cutoff = new Date()
  if (sinceDays !== undefined) cutoff.setDate(cutoff.getDate() - sinceDays)
  else cutoff.setMonth(cutoff.getMonth() - sinceMonthsAgo)

  const classes = rawClasses.filter(
    c => !c.deleted && !c.canceled && new Date(c.start_time) >= cutoff
  )

  // ── event_series ────────────────────────────────────────────────────────
  const uniqueNames = [...new Set(classes.map(c => canonicalSeriesName(c.name)))]

  const { data: existingSeries } = await supabase.from('event_series').select('id, name')
  const seriesIdByName = new Map((existingSeries ?? []).map(s => [s.name, s.id as string]))

  const seriesToCreate = uniqueNames.filter(n => !seriesIdByName.has(n))
  if (seriesToCreate.length > 0) {
    const rows = seriesToCreate.map(name => ({ name, tag: classifySeries(name) }))
    const { data: created, error } = await supabase
      .from('event_series')
      .insert(rows)
      .select('id, name')
    if (error) throw error
    for (const row of created) seriesIdByName.set(row.name, row.id)
  }

  // ── event_instances ─────────────────────────────────────────────────────
  const { data: existingInstances } = await supabase
    .from('event_instances')
    .select('id, arketa_id')
    .not('arketa_id', 'is', null)
  const instanceIdByArketaId = new Map(
    (existingInstances ?? []).map(i => [i.arketa_id as string, i.id as string])
  )

  let instancesCreated = 0
  let instancesUpdated = 0
  // Every row needs an explicit `id` (existing or freshly generated) so the
  // batch is homogeneous — Supabase's bulk upsert fills any key missing from
  // an individual row with `null` rather than omitting it, which would send
  // an explicit `id: null` for new rows and violate the not-null constraint.
  const instanceUpserts = classes.map(c => {
    const existingId = instanceIdByArketaId.get(c.id)
    existingId ? instancesUpdated++ : instancesCreated++
    return {
      id: existingId ?? randomUUID(),
      series_id: seriesIdByName.get(canonicalSeriesName(c.name)),
      date: c.start_time,
      arketa_id: c.id,
      instructor_name: c.instructor_name?.trim() || null,
    }
  })

  const { data: upsertedInstances, error: instErr } = await supabase
    .from('event_instances')
    .upsert(instanceUpserts, { onConflict: 'id' })
    .select('id, arketa_id')
  if (instErr) throw instErr
  for (const row of upsertedInstances) instanceIdByArketaId.set(row.arketa_id, row.id)

  // ── reservations -> people + attendances ───────────────────────────────
  const activePurchaseClientIds = await arketaFetchActivePurchaseClientIds()
  const personIdByEmail = new Map<string, string>()

  for (const c of classes) {
    if (!c.total_booked) continue
    const instanceId = instanceIdByArketaId.get(c.id)
    if (!instanceId) continue

    await syncClassReservations(
      supabase,
      c.id,
      instanceId,
      c.start_time,
      activePurchaseClientIds,
      personIdByEmail,
      stats
    )
  }

  await supabase.from('people').update({ is_active: true }).gte('event_count', 3)

  return toResult(stats, { seriesCreated: seriesToCreate.length, instancesCreated, instancesUpdated })
}
