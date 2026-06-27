import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/lib/supabase/server'

// ─── Types ────────────────────────────────────────────────────────────────────

type PersonRow = {
  id: string
  name: string
  email: string | null
  admin_notes: string | null
  last_seen_at: string | null
}

type AttRow = {
  person_id: string
  checked_in_at: string
  event_instances: {
    series_id: string
    date: string
    event_series: { name: string; tag: string } | null
  } | null
}

type PendingFlag = {
  person_id: string
  reason: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const RULE1_REASON = "Soulfest regular hasn't visited in 2 weeks"
const RULE2_REASON = 'Dropped off a series mid-way'
const RULE3_REASON = 'Outreach attendee not yet in Soulfest'

const SOULFEST_LAPSED_DAYS = 14
const SERIES_DROPPED_DAYS = 30
const SOULFEST_CURRENT_DAYS = 30

const anthropic = new Anthropic()

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function POST() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  // ── 1. Load all data in parallel ───────────────────────────────────────────

  const [{ data: people }, { data: rawAtts }, { data: existingFlags }] =
    await Promise.all([
      supabase
        .from('people')
        .select('id, name, email, admin_notes, last_seen_at'),
      supabase
        .from('attendances')
        .select(
          'person_id, checked_in_at, event_instances(series_id, date, event_series(name, tag))'
        )
        .order('checked_in_at', { ascending: true }),
      supabase
        .from('follow_up_flags')
        .select('person_id, reason')
        .eq('resolved', false),
    ])

  const personList = (people as PersonRow[]) ?? []
  const attList = (rawAtts as unknown as AttRow[]) ?? []
  const existingList = existingFlags ?? []

  // ── 2. Build lookup structures ─────────────────────────────────────────────

  const personMap = new Map<string, PersonRow>(personList.map(p => [p.id, p]))

  // Existing unresolved flag keys → skip creation
  const flagKeys = new Set(existingList.map(f => `${f.person_id}:${f.reason}`))

  // Per-person attendance grouped by series
  const personAtts = new Map<string, AttRow[]>()
  for (const att of attList) {
    if (!personAtts.has(att.person_id)) personAtts.set(att.person_id, [])
    personAtts.get(att.person_id)!.push(att)
  }

  const now = Date.now()

  function daysSince(iso: string) {
    return (now - new Date(iso).getTime()) / 86_400_000
  }

  // ── 3. Evaluate rules for each person ──────────────────────────────────────

  const toCreate: PendingFlag[] = []

  for (const person of personList) {
    const atts = personAtts.get(person.id) ?? []

    // Partition by series tag
    const soulfestAtts = atts.filter(
      a => a.event_instances?.event_series?.tag === 'soulfest'
    )
    const outreachAtts = atts.filter(
      a => a.event_instances?.event_series?.tag === 'outreach'
    )

    // ── Rule 1 ──────────────────────────────────────────────────────────────
    // 3+ soulfest events AND last_seen_at > 14 days ago
    if (soulfestAtts.length >= 3 && person.last_seen_at) {
      if (daysSince(person.last_seen_at) > SOULFEST_LAPSED_DAYS) {
        const key = `${person.id}:${RULE1_REASON}`
        if (!flagKeys.has(key)) toCreate.push({ person_id: person.id, reason: RULE1_REASON })
      }
    }

    // ── Rule 2 ──────────────────────────────────────────────────────────────
    // Attended 2+ events in a non-soulfest series, stopped (> 30 days),
    // AND not currently in soulfest (no soulfest attendance in last 30 days)
    if (!flagKeys.has(`${person.id}:${RULE2_REASON}`)) {
      const recentSoulfest = soulfestAtts.some(
        a => daysSince(a.checked_in_at) <= SOULFEST_CURRENT_DAYS
      )

      if (!recentSoulfest) {
        // Group by series_id, exclude soulfest
        const bySeries = new Map<string, AttRow[]>()
        for (const att of atts) {
          const tag = att.event_instances?.event_series?.tag
          if (!tag || tag === 'soulfest') continue
          const sid = att.event_instances!.series_id
          if (!bySeries.has(sid)) bySeries.set(sid, [])
          bySeries.get(sid)!.push(att)
        }

        for (const [, seriesAtts] of bySeries) {
          if (seriesAtts.length < 2) continue
          // Sort ascending (already loaded in order, but ensure it)
          const sorted = [...seriesAtts].sort((a, b) =>
            a.checked_in_at.localeCompare(b.checked_in_at)
          )
          const lastAtt = sorted[sorted.length - 1]
          if (daysSince(lastAtt.checked_in_at) > SERIES_DROPPED_DAYS) {
            toCreate.push({ person_id: person.id, reason: RULE2_REASON })
            break // one flag per person
          }
        }
      }
    }

    // ── Rule 3 ──────────────────────────────────────────────────────────────
    // Attended outreach AND zero soulfest attendance
    if (outreachAtts.length >= 1 && soulfestAtts.length === 0) {
      const key = `${person.id}:${RULE3_REASON}`
      if (!flagKeys.has(key)) toCreate.push({ person_id: person.id, reason: RULE3_REASON })
    }
  }

  if (toCreate.length === 0) {
    return Response.json({ created: 0 })
  }

  // ── 4. Insert new flags ────────────────────────────────────────────────────

  const { data: inserted } = await supabase
    .from('follow_up_flags')
    .insert(toCreate)
    .select('id, person_id, reason')

  if (!inserted?.length) {
    return Response.json({ created: 0 })
  }

  const insertedFlags = inserted as { id: string; person_id: string; reason: string }[]

  // ── 5. Generate personalised messages for each new flag ───────────────────

  for (const flag of insertedFlags) {
    if (!flag.person_id) continue
    const person = personMap.get(flag.person_id)
    if (!person) continue

    const history = (personAtts.get(flag.person_id) ?? [])
      .slice(-20) // most recent 20
      .reverse()
      .map(
        a =>
          `${a.event_instances?.event_series?.name ?? 'event'} on ${new Date(
            a.checked_in_at
          ).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
      )
      .join('; ')

    try {
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 256,
        system: `You are a thoughtful assistant for Bhakti Studio, a yoga and movement studio.
Write warm, personal follow-up message suggestions for studio staff to send to students.
Tone: genuine, caring, brief — never sales-y or formulaic.
Write exactly 2–3 sentences. Output only the message text, no preamble or sign-off.`,
        messages: [
          {
            role: 'user',
            content: `Student: ${person.name}
Flag reason: ${flag.reason}
Recent attendance: ${history || 'No attendance on record'}
Staff notes: ${person.admin_notes ?? 'None'}

Write a warm follow-up message a staff member could send to this student.`,
          },
        ],
      })

      const text =
        message.content[0].type === 'text' ? message.content[0].text.trim() : null

      if (text) {
        await supabase
          .from('follow_up_flags')
          .update({ notes: text })
          .eq('id', flag.id)
      }
    } catch {
      // Non-fatal: flag is still created; message generation just failed for this one
    }
  }

  return Response.json({ created: inserted.length })
}
