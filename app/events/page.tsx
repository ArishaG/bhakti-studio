'use client'

import { useState, useEffect, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { SeriesInput, SeriesRecommendation } from '@/app/api/ai/series-recommendations/route'

// ─── Types ────────────────────────────────────────────────────────────────────

type EventTag = 'soulfest' | 'outreach' | 'classes' | 'other'

type RawSeries = {
  id: string
  name: string
  tag: EventTag
  description: string | null
  is_archived: boolean
}

type RawAttendance = {
  person_id: string
  checked_in_at: string
  event_instances: { series_id: string; date: string }[]
}

type SeriesStat = {
  id: string
  name: string
  tag: EventTag
  description: string | null
  isArchived: boolean
  totalAttendances: number
  uniqueAttendees: number
  returnRate: number
  conversionRate: number | null
  hasEnoughData: boolean
  monthsOfData: number
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TAG_STYLES: Record<EventTag, string> = {
  soulfest: 'bg-gold/30 text-espresso',
  outreach: 'bg-terracotta/20 text-terracotta',
  classes: 'bg-walnut/20 text-walnut',
  other: 'bg-parchment text-walnut border border-walnut/20',
}

// ─── Stats computation ────────────────────────────────────────────────────────

function computeSeriesStats(
  allSeries: RawSeries[],
  allAttendances: RawAttendance[]
): SeriesStat[] {
  // Group attendances by series_id
  const bySeriesId = new Map<string, RawAttendance[]>()
  for (const att of allAttendances) {
    const sid = att.event_instances?.[0]?.series_id
    if (!sid) continue
    if (!bySeriesId.has(sid)) bySeriesId.set(sid, [])
    bySeriesId.get(sid)!.push(att)
  }

  // Core series ids (soulfest/classes) for conversion rate
  const coreIds = new Set(
    allSeries.filter(s => s.tag === 'soulfest' || s.tag === 'classes').map(s => s.id)
  )
  const coreAttendances = allAttendances.filter(
    a => a.event_instances?.[0]?.series_id && coreIds.has(a.event_instances[0].series_id)
  )

  return allSeries.map(series => {
    const atts = bySeriesId.get(series.id) ?? []
    const totalAttendances = atts.length

    const personCounts = new Map<string, number>()
    for (const att of atts) {
      personCounts.set(att.person_id, (personCounts.get(att.person_id) ?? 0) + 1)
    }
    const uniqueAttendees = personCounts.size
    const returnVisitors = [...personCounts.values()].filter(c => c > 1).length
    const returnRate = uniqueAttendees > 0 ? (returnVisitors / uniqueAttendees) * 100 : 0

    // Conversion rate only for non-core series
    let conversionRate: number | null = null
    if (!coreIds.has(series.id) && uniqueAttendees > 0) {
      let converted = 0
      for (const [personId] of personCounts) {
        const firstInSeries = atts
          .filter(a => a.person_id === personId)
          .sort((a, b) => a.checked_in_at.localeCompare(b.checked_in_at))[0]

        const laterConverted = coreAttendances.some(
          a =>
            a.person_id === personId &&
            a.checked_in_at > firstInSeries.checked_in_at
        )
        if (laterConverted) converted++
      }
      conversionRate = (converted / uniqueAttendees) * 100
    }

    // Date range for "enough data" check
    const dates = atts
      .map(a => a.event_instances?.[0]?.date)
      .filter(Boolean)
      .sort() as string[]

    let monthsOfData = 0
    if (dates.length >= 2) {
      const first = new Date(dates[0])
      const last = new Date(dates[dates.length - 1])
      monthsOfData =
        (last.getFullYear() - first.getFullYear()) * 12 +
        (last.getMonth() - first.getMonth())
    }

    return {
      id: series.id,
      name: series.name,
      tag: series.tag,
      description: series.description,
      isArchived: series.is_archived,
      totalAttendances,
      uniqueAttendees,
      returnRate,
      conversionRate,
      hasEnoughData: monthsOfData >= 3 && totalAttendances >= 5,
      monthsOfData,
    }
  })
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function EventsPage() {
  const supabase = createClient()

  const [stats, setStats] = useState<SeriesStat[]>([])
  const [recommendations, setRecommendations] = useState<SeriesRecommendation[]>([])
  const [recLoading, setRecLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<string | null>(null)
  const [syncingEB, setSyncingEB] = useState(false)
  const [syncResultEB, setSyncResultEB] = useState<string | null>(null)

  useEffect(() => {
    loadData()
  }, [])

  async function syncArketa() {
    setSyncing(true)
    setSyncResult(null)
    try {
      const res = await fetch('/api/sync/arketa', { method: 'POST' })
      if (res.ok) {
        const r = await res.json()
        setSyncResult(
          `+${r.seriesCreated} series, +${r.instancesCreated} events, +${r.attendancesCreated} attendances`
        )
        await loadData()
      } else {
        setSyncResult('Sync failed. Try again.')
      }
    } catch {
      setSyncResult('Sync failed. Try again.')
    }
    setSyncing(false)
  }

  async function syncEventbrite() {
    setSyncingEB(true)
    setSyncResultEB(null)
    try {
      const res = await fetch('/api/sync/eventbrite', { method: 'POST' })
      if (res.ok) {
        const r = await res.json()
        setSyncResultEB(
          `${r.eventsMatched} events matched, +${r.attendancesCreated} attendances`
        )
        await loadData()
      } else {
        setSyncResultEB('Sync failed. Try again.')
      }
    } catch {
      setSyncResultEB('Sync failed. Try again.')
    }
    setSyncingEB(false)
  }

  async function loadData() {
    setLoading(true)
    const [{ data: series }, { data: attendances }] = await Promise.all([
      supabase.from('event_series').select('id, name, tag, description, is_archived').order('name'),
      supabase
        .from('attendances')
        .select('person_id, checked_in_at, event_instances(series_id, date)'),
    ])

    const computed = computeSeriesStats(
      (series as RawSeries[]) ?? [],
      (attendances as unknown as RawAttendance[]) ?? []
    )
    setStats(computed)
    setLoading(false)

    // Fetch AI recommendations for eligible series
    const eligible = computed.filter(s => s.hasEnoughData && !s.isArchived)
    if (eligible.length > 0) {
      setRecLoading(true)
      try {
        const body: SeriesInput[] = eligible.map(s => ({
          id: s.id,
          name: s.name,
          tag: s.tag,
          totalAttendances: s.totalAttendances,
          uniqueAttendees: s.uniqueAttendees,
          returnRate: s.returnRate,
          conversionRate: s.conversionRate,
          monthsOfData: s.monthsOfData,
        }))
        const res = await fetch('/api/ai/series-recommendations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ series: body }),
        })
        if (res.ok) {
          const data = await res.json()
          setRecommendations(data.recommendations ?? [])
        }
      } finally {
        setRecLoading(false)
      }
    }
  }

  const recBySeriesId = useMemo(
    () => new Map(recommendations.map(r => [r.seriesId, r])),
    [recommendations]
  )

  const activeSorted = useMemo(
    () =>
      stats
        .filter(s => !s.isArchived)
        .sort((a, b) => b.returnRate - a.returnRate),
    [stats]
  )

  const archived = useMemo(() => stats.filter(s => s.isArchived), [stats])

  return (
    <div className="min-h-screen bg-cream pt-16">
      <div className="max-w-2xl mx-auto px-4 pt-6 pb-16">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-2xl font-bold text-espresso">Events</h1>
          <span className="text-xs text-walnut bg-parchment px-3 py-1.5 rounded-full">
            Sorted by return rate
          </span>
        </div>

        <div className="flex items-center gap-3 mb-5">
          <button
            onClick={syncArketa}
            disabled={syncing}
            className="flex items-center gap-1.5 text-xs font-medium bg-parchment hover:bg-walnut/20 disabled:opacity-50 text-walnut px-3 py-1.5 rounded-full transition-colors"
          >
            {syncing ? (
              <>
                <div className="w-3 h-3 border border-walnut/60 border-t-transparent rounded-full animate-spin" />
                Syncing…
              </>
            ) : (
              <>
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Sync Arketa
              </>
            )}
          </button>
          {syncResult && <span className="text-xs text-walnut">{syncResult}</span>}

          <button
            onClick={syncEventbrite}
            disabled={syncingEB}
            className="flex items-center gap-1.5 text-xs font-medium bg-parchment hover:bg-walnut/20 disabled:opacity-50 text-walnut px-3 py-1.5 rounded-full transition-colors"
          >
            {syncingEB ? (
              <>
                <div className="w-3 h-3 border border-walnut/60 border-t-transparent rounded-full animate-spin" />
                Syncing…
              </>
            ) : (
              <>
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Sync Eventbrite
              </>
            )}
          </button>
          {syncResultEB && <span className="text-xs text-walnut">{syncResultEB}</span>}
        </div>

        {loading ? (
          <Spinner />
        ) : (
          <>
            {/* Active series */}
            {activeSorted.length === 0 ? (
              <p className="text-walnut text-sm py-8 text-center">No active event series.</p>
            ) : (
              <ul className="space-y-4">
                {activeSorted.map(s => (
                  <li key={s.id}>
                    <SeriesCard
                      stat={s}
                      recommendation={recBySeriesId.get(s.id) ?? null}
                      recLoading={recLoading && s.hasEnoughData}
                    />
                  </li>
                ))}
              </ul>
            )}

            {/* Archived series */}
            {archived.length > 0 && (
              <div className="mt-8">
                <button
                  onClick={() => setArchiveOpen(o => !o)}
                  className="flex items-center gap-2 text-sm font-medium text-walnut hover:text-espresso transition-colors mb-3"
                >
                  <svg
                    className={`w-4 h-4 transition-transform ${archiveOpen ? 'rotate-90' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                  Archived Series ({archived.length})
                </button>
                {archiveOpen && (
                  <ul className="space-y-4">
                    {archived.map(s => (
                      <li key={s.id}>
                        <SeriesCard stat={s} recommendation={null} recLoading={false} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Series Card ──────────────────────────────────────────────────────────────

function SeriesCard({
  stat,
  recommendation,
  recLoading,
}: {
  stat: SeriesStat
  recommendation: SeriesRecommendation | null
  recLoading: boolean
}) {
  return (
    <div
      className={`bg-parchment rounded-2xl p-5 shadow-sm ${stat.isArchived ? 'opacity-60' : ''}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-semibold text-espresso leading-tight">{stat.name}</h3>
          {stat.description && (
            <p className="text-xs text-walnut mt-0.5 line-clamp-1">{stat.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* AI badge */}
          {stat.hasEnoughData &&
            !stat.isArchived &&
            (recLoading ? (
              <div className="flex items-center gap-1.5 bg-cream px-2.5 py-1 rounded-full">
                <div className="w-3 h-3 border border-walnut/40 border-t-transparent rounded-full animate-spin" />
                <span className="text-xs text-walnut/60">AI</span>
              </div>
            ) : recommendation ? (
              <AIBadge recommendation={recommendation} />
            ) : null)}
          <span
            className={`text-xs font-semibold px-2.5 py-1 rounded-full capitalize ${TAG_STYLES[stat.tag]}`}
          >
            {stat.tag}
          </span>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCell label="Total check-ins" value={stat.totalAttendances.toString()} />
        <StatCell label="Unique attendees" value={stat.uniqueAttendees.toString()} />
        <StatCell
          label="Return rate"
          value={stat.uniqueAttendees > 0 ? `${stat.returnRate.toFixed(0)}%` : '—'}
          highlight={stat.returnRate >= 35}
        />
        <StatCell
          label={stat.conversionRate !== null ? 'Conversion' : 'Conversion'}
          value={
            stat.conversionRate !== null
              ? `${stat.conversionRate.toFixed(0)}%`
              : 'N/A'
          }
          highlight={stat.conversionRate !== null && stat.conversionRate >= 20}
          muted={stat.conversionRate === null}
        />
      </div>

      {/* AI recommendation reason */}
      {recommendation && (
        <p className="mt-3 text-xs text-walnut leading-relaxed border-t border-cream pt-3">
          {recommendation.reason}
        </p>
      )}
    </div>
  )
}

function StatCell({
  label,
  value,
  highlight,
  muted,
}: {
  label: string
  value: string
  highlight?: boolean
  muted?: boolean
}) {
  return (
    <div className="bg-cream rounded-xl px-3 py-2.5">
      <p className="text-xs text-walnut/70 mb-0.5">{label}</p>
      <p
        className={`text-base font-semibold ${
          highlight ? 'text-terracotta' : muted ? 'text-walnut/40' : 'text-espresso'
        }`}
      >
        {value}
      </p>
    </div>
  )
}

function AIBadge({ recommendation }: { recommendation: SeriesRecommendation }) {
  const isContinue = recommendation.badge === 'Continue'
  return (
    <div
      className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${
        isContinue
          ? 'bg-gold/30 text-espresso'
          : 'bg-terracotta/15 text-terracotta'
      }`}
    >
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M13 10V3L4 14h7v7l9-11h-7z"
        />
      </svg>
      {recommendation.badge}
    </div>
  )
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-8 h-8 border-2 border-terracotta border-t-transparent rounded-full animate-spin" />
    </div>
  )
}
