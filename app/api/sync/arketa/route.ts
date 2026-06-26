import { createClient } from '@/lib/supabase/server'

// ─── Types ────────────────────────────────────────────────────────────────────

type ArketaClient = {
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
}

type ArketaClass = {
  id: string
  name: string
  deleted: boolean
  canceled: boolean
  start_time: string
  instructor_name: string | null
  total_booked: number
}

type ArketaReservation = {
  client_id: string
  client: ArketaClient
  status: 'BOOKED' | 'ATTENDED' | 'CANCELLED' | string
  checked_in_at: string | null
  created_at: string
}

type EventTag = 'soulfest' | 'outreach' | 'classes' | 'other'

// ─── Series tag classification ───────────────────────────────────────────────
// Arketa has no concept of our event_tag taxonomy, so every series name seen
// so far has been classified by hand below. Anything new defaults to "other"
// so an admin can re-tag it from the Events page rather than the sync
// silently mis-categorizing it as soulfest/classes/outreach.

const EXPLICIT_TAGS: Record<string, EventTag> = {
  'bhakti flow for body and soul- yoga class': 'classes',
  'yoga flow + sound bath': 'classes',
  'beyond the mat: yoga for real life': 'classes',
  'beginning bhakti | interactive exploration of bhakti yoga': 'classes',
  'harmonium classes with ethan': 'classes',
  'intro to kirtan leading on harmonium': 'classes',
  'intro to leading kirtan on harmonium course': 'classes',
  'chakra alignment yoga class': 'classes',
  'sunday sun salutation yoga': 'classes',
  'yoga flow x yoga nidra - nervous system reset': 'classes',
  'yoga flow + yoga nidra class': 'classes',
  'valentines partner yoga class': 'classes',
  'winter solstice breathwork & yoga': 'classes',

  'soul talks | explore inner-wisdom from bhakti yoga': 'outreach',
  'gong sound immersion': 'outreach',
  'the reflection room': 'outreach',
  'bhakti book club': 'outreach',
  'family friendly kirtan': 'outreach',
  'family kirtan': 'outreach',
  'inner waves - midweek gong relaxation': 'outreach',
  'inner waves sonic creations': 'outreach',
  'inner waves gong meditation: "soundtracks of spring"': 'outreach',
  'sound journey jams with sonic creations': 'outreach',
  'sound journey jams - music workshop': 'outreach',
  'sound journey jams! with sound artist stephanie wood of sonic creations': 'outreach',
  'sound journey gong meditation with sound artist & wellness practitioner stephanie wood':
    'outreach',
  'reiki-infused sound journey | frequency reset sound bath': 'outreach',
  'taming the wild horses | sensory yoga experience | slow your mind': 'outreach',
  'the music within: sound meditation | immersive journey into resonance': 'outreach',
  'bhakti open mic': 'outreach',
  'recovery beyond yoga collab event': 'outreach',
  'special story telling kirtan with raghu from wisdom of the sages podcast!': 'outreach',
  'bhakti immersion: unlocking the secret heart of yoga with raghu': 'outreach',
  'kirtan meditation immersion with madhava das | bhakti yoga & sacred sound': 'outreach',
  'soul charge: art & sound meditation | midweek creative recharge.': 'outreach',

  block: 'other',
  'winter solstice mandala dot art & yoga workshop': 'other',
  'dot mandala art & yoga workshop': 'other',
  'ayurveda workshop | traditional indian healing drinks | cook for your soul!': 'other',
  'oil free cooking | ayurvedic cooking workshop | cook for the soul!': 'other',
  'healing with spices: an introduction to ayurvedic cooking': 'other',
  'lunar new year yoga + diy lantern  art workshop': 'other',
}

function classifySeries(name: string): EventTag {
  const key = name.trim().toLowerCase()
  if (key.includes('soulfest')) return 'soulfest'
  return EXPLICIT_TAGS[key] ?? 'other'
}

// ─── Arketa client ────────────────────────────────────────────────────────────

const ARKETA_BASE = `https://us-central1-sutra-prod.cloudfunctions.net/partnerApi/v0/${process.env.ARKETA_PARTNER_ID}`

async function arketaGet<T>(pathAndQuery: string): Promise<{ items: T[] }> {
  const res = await fetch(`${ARKETA_BASE}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${process.env.ARKETA_API_KEY}` },
  })
  if (!res.ok) throw new Error(`Arketa GET ${pathAndQuery} -> ${res.status}`)
  return res.json()
}

// ─── Route handler ────────────────────────────────────────────────────────────
// Imports Arketa classes (last 3 months -> all future) into event_series /
// event_instances, and their reservations into people / attendances
// (source='arketa'). Idempotent: matches existing series by name, instances
// by arketa_id, people by email, and relies on the attendances
// unique(person_id, event_instance_id) constraint to skip rows already
// imported, so this is safe to re-run on a schedule or via a button.

export async function POST() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  if (!process.env.ARKETA_API_KEY || !process.env.ARKETA_PARTNER_ID) {
    return Response.json({ error: 'Arketa is not configured' }, { status: 500 })
  }

  const { items: rawClasses } = await arketaGet<ArketaClass>('/classes?limit=500')

  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - 3)

  const classes = rawClasses.filter(
    c => !c.deleted && !c.canceled && new Date(c.start_time) >= cutoff
  )

  // ── event_series ────────────────────────────────────────────────────────
  const uniqueNames = [...new Set(classes.map(c => c.name.trim()))]

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
  const instanceUpserts = classes.map(c => {
    const existingId = instanceIdByArketaId.get(c.id)
    existingId ? instancesUpdated++ : instancesCreated++
    return {
      ...(existingId ? { id: existingId } : {}),
      series_id: seriesIdByName.get(c.name.trim()),
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
  let attended = 0
  let booked = 0
  let cancelled = 0
  let peopleCreated = 0
  let attendancesCreated = 0
  let attendancesSkipped = 0
  const personIdByEmail = new Map<string, string>()

  for (const c of classes) {
    if (!c.total_booked) continue
    const instanceId = instanceIdByArketaId.get(c.id)
    if (!instanceId) continue

    const { items: reservations } = await arketaGet<ArketaReservation>(
      `/classes/${c.id}/reservations?limit=200`
    )

    for (const r of reservations) {
      if (r.status === 'CANCELLED') {
        cancelled++
        continue
      }
      r.status === 'ATTENDED' ? attended++ : booked++

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
        peopleCreated++
      }

      if (email) personIdByEmail.set(email, personId!)

      const checkedInAt = r.checked_in_at || r.created_at || c.start_time

      const { error: attErr } = await supabase.from('attendances').insert({
        person_id: personId!,
        event_instance_id: instanceId,
        checked_in_at: checkedInAt,
        source: 'arketa',
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
    seriesCreated: seriesToCreate.length,
    instancesCreated,
    instancesUpdated,
    reservations: { attended, booked, cancelled },
    peopleCreated,
    attendancesCreated,
    attendancesSkipped,
  })
}
