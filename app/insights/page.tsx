'use client'

import { Fragment, useState, useEffect, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  ResponsiveContainer,
  ComposedChart,
  AreaChart,
  Area,
  BarChart,
  Bar,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'
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

type RawInstance = {
  id: string
  date: string
  instructor_name: string | null
  series_id: string
  event_series: { name: string; tag: EventTag } | null
}

type RawAttendance = {
  person_id: string
  checked_in_at: string
  event_instance_id: string
  event_instances: {
    date: string
    instructor_name: string | null
    series_id: string
    event_series: { name: string; tag: EventTag } | null
  } | null
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

type InstanceStat = {
  id: string
  date: string
  instructorName: string | null
  seriesName: string
  tag: EventTag
  totalCheckins: number
  uniqueAttendees: number
}

type MonthBucket = {
  key: string
  label: string
  totalCheckins: number
  uniqueAttendees: number
}

type GrowthPoint = {
  key: string
  label: string
  newAttendees: number
  cumulative: number
}

type TagSlice = {
  tag: EventTag
  totalCheckins: number
}

type StudioStats = {
  totalPeople: number
  activeMembers: number
  totalAttendances: number
  uniqueAttendeesEver: number
  overallReturnRate: number
  overallConversionRate: number | null
  avgCheckinsPerEvent: number
  monthlyTrend: MonthBucket[]
  growthTrend: GrowthPoint[]
  tagBreakdown: TagSlice[]
}

type SortDir = 'asc' | 'desc'
type GrowthPeriod = '6M' | '1Y' | '2Y' | 'all'

// ─── Constants ────────────────────────────────────────────────────────────────

const TAG_STYLES: Record<EventTag, string> = {
  soulfest: 'bg-gold/30 text-espresso',
  outreach: 'bg-terracotta/20 text-terracotta',
  classes: 'bg-walnut/20 text-walnut',
  other: 'bg-parchment text-walnut border border-walnut/20',
}

const TAG_HEX: Record<EventTag, string> = {
  soulfest: 'var(--color-gold)',
  outreach: 'var(--color-terracotta)',
  classes: 'var(--color-walnut)',
  other: 'var(--color-rust)',
}

const TAG_LABEL: Record<EventTag, string> = {
  soulfest: 'Soulfest',
  outreach: 'Outreach',
  classes: 'Classes',
  other: 'Other',
}

const ALL_TAGS: EventTag[] = ['soulfest', 'outreach', 'classes', 'other']

const CORE_TAGS = new Set<EventTag>(['soulfest', 'classes'])

const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function monthLabel(d: Date) {
  return `${MONTH_ABBR[d.getMonth()]} '${String(d.getFullYear()).slice(2)}`
}

// ─── Stats computation ────────────────────────────────────────────────────────

function computeSeriesStats(
  allSeries: RawSeries[],
  allAttendances: RawAttendance[]
): SeriesStat[] {
  const bySeriesId = new Map<string, RawAttendance[]>()
  for (const att of allAttendances) {
    const sid = att.event_instances?.series_id
    if (!sid) continue
    if (!bySeriesId.has(sid)) bySeriesId.set(sid, [])
    bySeriesId.get(sid)!.push(att)
  }

  const coreIds = new Set(
    allSeries.filter(s => s.tag === 'soulfest' || s.tag === 'classes').map(s => s.id)
  )
  const coreAttendances = allAttendances.filter(
    a => a.event_instances?.series_id && coreIds.has(a.event_instances.series_id)
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

    const dates = atts
      .map(a => a.event_instances?.date)
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

function computeInstanceStats(
  allInstances: RawInstance[],
  allAttendances: RawAttendance[]
): InstanceStat[] {
  const byInstanceId = new Map<string, RawAttendance[]>()
  for (const att of allAttendances) {
    const iid = att.event_instance_id
    if (!byInstanceId.has(iid)) byInstanceId.set(iid, [])
    byInstanceId.get(iid)!.push(att)
  }

  return allInstances.map(inst => {
    const atts = byInstanceId.get(inst.id) ?? []
    const uniquePersons = new Set(atts.map(a => a.person_id))
    return {
      id: inst.id,
      date: inst.date,
      instructorName: inst.instructor_name,
      seriesName: inst.event_series?.name ?? 'Unknown',
      tag: inst.event_series?.tag ?? 'other',
      totalCheckins: atts.length,
      uniqueAttendees: uniquePersons.size,
    }
  })
}

function computeStudioStats(
  totalPeople: number,
  activeMembers: number,
  allAttendances: RawAttendance[]
): StudioStats {
  const totalAttendances = allAttendances.length

  // Per-person aggregation across the whole studio
  const byPerson = new Map<string, RawAttendance[]>()
  for (const att of allAttendances) {
    if (!byPerson.has(att.person_id)) byPerson.set(att.person_id, [])
    byPerson.get(att.person_id)!.push(att)
  }
  const uniqueAttendeesEver = byPerson.size

  let returnVisitors = 0
  let introFirstTimers = 0
  let introConverted = 0
  const firstAttendanceByPerson = new Map<string, Date>()

  for (const [, atts] of byPerson) {
    if (atts.length > 1) returnVisitors++

    const sorted = [...atts].sort((a, b) => a.checked_in_at.localeCompare(b.checked_in_at))
    const first = sorted[0]
    firstAttendanceByPerson.set(first.person_id, new Date(first.checked_in_at))

    const firstTag = first.event_instances?.event_series?.tag
    if (firstTag && !CORE_TAGS.has(firstTag)) {
      introFirstTimers++
      const laterCore = sorted
        .slice(1)
        .some(a => {
          const tag = a.event_instances?.event_series?.tag
          return tag && CORE_TAGS.has(tag)
        })
      if (laterCore) introConverted++
    }
  }

  const overallReturnRate =
    uniqueAttendeesEver > 0 ? (returnVisitors / uniqueAttendeesEver) * 100 : 0
  const overallConversionRate =
    introFirstTimers > 0 ? (introConverted / introFirstTimers) * 100 : null

  const instancesWithCheckins = new Set(
    allAttendances.map(a => a.event_instance_id)
  ).size
  const avgCheckinsPerEvent =
    instancesWithCheckins > 0 ? totalAttendances / instancesWithCheckins : 0

  // Monthly trend: rolling last 12 months ending this month
  const now = new Date()
  const monthBuckets: MonthBucket[] = []
  const bucketIndex = new Map<string, number>()
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = monthKey(d)
    bucketIndex.set(key, monthBuckets.length)
    monthBuckets.push({ key, label: monthLabel(d), totalCheckins: 0, uniqueAttendees: 0 })
  }
  const monthlyPersonSets = monthBuckets.map(() => new Set<string>())
  for (const att of allAttendances) {
    const d = new Date(att.checked_in_at)
    const key = monthKey(d)
    const idx = bucketIndex.get(key)
    if (idx === undefined) continue
    monthBuckets[idx].totalCheckins++
    monthlyPersonSets[idx].add(att.person_id)
  }
  monthBuckets.forEach((b, i) => (b.uniqueAttendees = monthlyPersonSets[i].size))

  // Growth trend: cumulative unique attendees by month of first-ever attendance
  const growthBucketMap = new Map<string, number>()
  for (const [, firstDate] of firstAttendanceByPerson) {
    const key = monthKey(firstDate)
    growthBucketMap.set(key, (growthBucketMap.get(key) ?? 0) + 1)
  }
  const sortedKeys = [...growthBucketMap.keys()].sort()
  let cumulative = 0
  const growthTrend: GrowthPoint[] = sortedKeys.map(key => {
    const [y, m] = key.split('-').map(Number)
    const newAttendees = growthBucketMap.get(key)!
    cumulative += newAttendees
    return { key, label: monthLabel(new Date(y, m - 1, 1)), newAttendees, cumulative }
  })

  // Tag breakdown across all-time attendances
  const tagCounts = new Map<EventTag, number>()
  for (const att of allAttendances) {
    const tag = att.event_instances?.event_series?.tag ?? 'other'
    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
  }
  const tagBreakdown: TagSlice[] = ALL_TAGS
    .map(tag => ({ tag, totalCheckins: tagCounts.get(tag) ?? 0 }))
    .filter(t => t.totalCheckins > 0)

  return {
    totalPeople,
    activeMembers,
    totalAttendances,
    uniqueAttendeesEver,
    overallReturnRate,
    overallConversionRate,
    avgCheckinsPerEvent,
    monthlyTrend: monthBuckets,
    growthTrend,
    tagBreakdown,
  }
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function InsightsPage() {
  const supabase = createClient()

  const [seriesStats, setSeriesStats] = useState<SeriesStat[]>([])
  const [instanceStats, setInstanceStats] = useState<InstanceStat[]>([])
  const [studioStats, setStudioStats] = useState<StudioStats | null>(null)
  const [recommendations, setRecommendations] = useState<SeriesRecommendation[]>([])
  const [recLoading, setRecLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<string | null>(null)
  const [syncingEB, setSyncingEB] = useState(false)
  const [syncResultEB, setSyncResultEB] = useState<string | null>(null)
  const [growthPeriod, setGrowthPeriod] = useState<GrowthPeriod>('all')
  const [showAllSeries, setShowAllSeries] = useState(false)

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
    const [{ data: series }, { data: attendances }, { data: instances }, { count: totalPeople }, { count: activeMembers }] =
      await Promise.all([
        supabase.from('event_series').select('id, name, tag, description, is_archived').order('name'),
        supabase
          .from('attendances')
          .select(
            'person_id, checked_in_at, event_instance_id, event_instances ( date, instructor_name, series_id, event_series ( name, tag ) )'
          ),
        supabase
          .from('event_instances')
          .select('id, date, instructor_name, series_id, event_series ( name, tag )')
          .order('date', { ascending: false }),
        supabase.from('people').select('id', { count: 'exact', head: true }),
        supabase.from('people').select('id', { count: 'exact', head: true }).eq('is_active', true),
      ])

    const rawSeries = (series as RawSeries[]) ?? []
    const rawAttendances = (attendances as unknown as RawAttendance[]) ?? []
    const rawInstances = (instances as unknown as RawInstance[]) ?? []

    const computedSeries = computeSeriesStats(rawSeries, rawAttendances)
    const computedInstances = computeInstanceStats(rawInstances, rawAttendances)
    const computedStudio = computeStudioStats(totalPeople ?? 0, activeMembers ?? 0, rawAttendances)

    setSeriesStats(computedSeries)
    setInstanceStats(computedInstances)
    setStudioStats(computedStudio)
    setLoading(false)

    const eligible = computedSeries.filter(s => s.hasEnoughData && !s.isArchived)
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

  const filteredGrowthData = useMemo(() => {
    if (!studioStats) return []
    const data = studioStats.growthTrend
    if (growthPeriod === 'all') return data
    const months = growthPeriod === '6M' ? 6 : growthPeriod === '1Y' ? 12 : 24
    return data.slice(-months)
  }, [studioStats, growthPeriod])

  return (
    <div className="min-h-screen bg-cream pt-16">
      <div className="max-w-6xl mx-auto px-4 pt-6 pb-16 space-y-8">
        {/* ── Header ── */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h1 className="text-2xl font-bold text-espresso">Insights</h1>
          <div className="flex items-center gap-3">
            <SyncButton label="Sync Arketa" syncing={syncing} onClick={syncArketa} result={syncResult} />
            <SyncButton label="Sync Eventbrite" syncing={syncingEB} onClick={syncEventbrite} result={syncResultEB} />
          </div>
        </div>

        {loading || !studioStats ? (
          <Spinner />
        ) : (
          <>
            {/* ── Studio KPIs ── */}
            <section>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                <KpiCard label="Total People" value={studioStats.totalPeople.toString()} />
                <KpiCard label="Active Members" value={studioStats.activeMembers.toString()} accent />
                <KpiCard label="Total Check-Ins" value={studioStats.totalAttendances.toString()} />
                <KpiCard label="Unique Attendees" value={studioStats.uniqueAttendeesEver.toString()} />
                <KpiCard
                  label="Studio Return Rate"
                  value={`${studioStats.overallReturnRate.toFixed(0)}%`}
                  sub="ever attended twice+"
                />
                <KpiCard
                  label="Intro→Core Conversion"
                  value={
                    studioStats.overallConversionRate !== null
                      ? `${studioStats.overallConversionRate.toFixed(0)}%`
                      : 'N/A'
                  }
                  sub="outreach/other → soulfest/classes"
                />
              </div>
            </section>

            {/* ── Charts row 1: attendance + donut ── */}
            <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <ChartCard title="Monthly Attendance (last 12 months)" className="lg:col-span-2">
                <ResponsiveContainer width="100%" height={260}>
                  <ComposedChart data={studioStats.monthlyTrend}>
                    <CartesianGrid stroke="var(--color-parchment)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--color-walnut)' }} />
                    <YAxis tick={{ fontSize: 11, fill: 'var(--color-walnut)' }} allowDecimals={false} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="totalCheckins" name="Check-ins" fill="var(--color-terracotta)" radius={[4, 4, 0, 0]} />
                    <Line
                      type="monotone"
                      dataKey="uniqueAttendees"
                      name="Unique attendees"
                      stroke="var(--color-espresso)"
                      strokeWidth={2}
                      dot={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title="Check-Ins by Category">
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Tooltip contentStyle={tooltipStyle} />
                    <Pie
                      data={studioStats.tagBreakdown}
                      dataKey="totalCheckins"
                      nameKey="tag"
                      innerRadius={55}
                      outerRadius={85}
                      paddingAngle={2}
                    >
                      {studioStats.tagBreakdown.map(slice => (
                        <Cell key={slice.tag} fill={TAG_HEX[slice.tag]} />
                      ))}
                    </Pie>
                    <Legend
                      wrapperStyle={{ fontSize: 12 }}
                      formatter={(value: string) => TAG_LABEL[value as EventTag] ?? value}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </ChartCard>
            </section>

            {/* ── Charts row 2: member growth full-width ── */}
            <section>
              <ChartCard
                title="Member Growth (cumulative)"
                controls={
                  <div className="flex gap-1">
                    {(['6M', '1Y', '2Y', 'all'] as GrowthPeriod[]).map(p => (
                      <button
                        key={p}
                        onClick={() => setGrowthPeriod(p)}
                        className={`text-xs font-medium px-2.5 py-1 rounded-full transition-colors ${
                          growthPeriod === p
                            ? 'bg-espresso text-cream'
                            : 'bg-cream text-walnut hover:bg-walnut/10'
                        }`}
                      >
                        {p === 'all' ? 'All' : p}
                      </button>
                    ))}
                  </div>
                }
              >
                {filteredGrowthData.length === 0 ? (
                  <EmptyChart message="No attendance history yet." />
                ) : (
                  <ResponsiveContainer width="100%" height={240}>
                    <AreaChart data={filteredGrowthData}>
                      <defs>
                        <linearGradient id="growthFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--color-gold)" stopOpacity={0.5} />
                          <stop offset="100%" stopColor="var(--color-gold)" stopOpacity={0.05} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="var(--color-parchment)" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--color-walnut)' }} />
                      <YAxis tick={{ fontSize: 11, fill: 'var(--color-walnut)' }} allowDecimals={false} />
                      <Tooltip contentStyle={tooltipStyle} />
                      <Area
                        type="monotone"
                        dataKey="cumulative"
                        name="Total people reached"
                        stroke="var(--color-rust)"
                        fill="url(#growthFill)"
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </ChartCard>
            </section>

            {/* ── Charts row 3: return vs conversion full-width ── */}
            {(() => {
              const activeSeries = seriesStats.filter(s => !s.isArchived)
              const displaySeries = showAllSeries ? activeSeries : activeSeries.slice(0, 10)
              const chartHeight = Math.max(240, displaySeries.length * 36 + 60)
              return (
                <section>
                  <ChartCard
                    title="Return vs. Conversion by Series"
                    controls={
                      activeSeries.length > 10 ? (
                        <button
                          onClick={() => setShowAllSeries(s => !s)}
                          className="text-xs font-medium px-2.5 py-1 rounded-full bg-cream text-walnut hover:bg-walnut/10 transition-colors"
                        >
                          {showAllSeries ? `Top 10` : `Show all ${activeSeries.length}`}
                        </button>
                      ) : undefined
                    }
                  >
                    {activeSeries.length === 0 ? (
                      <EmptyChart message="No active series yet." />
                    ) : (
                      <ResponsiveContainer width="100%" height={chartHeight}>
                        <BarChart
                          data={displaySeries}
                          layout="vertical"
                          margin={{ left: 4, right: 16 }}
                        >
                          <CartesianGrid stroke="var(--color-parchment)" horizontal={false} />
                          <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--color-walnut)' }} unit="%" domain={[0, 100]} />
                          <YAxis
                            type="category"
                            dataKey="name"
                            tick={{ fontSize: 11, fill: 'var(--color-walnut)' }}
                            width={160}
                            tickFormatter={(name: string) =>
                              name.length > 22 ? name.slice(0, 22) + '…' : name
                            }
                          />
                          <Tooltip
                            contentStyle={tooltipStyle}
                            formatter={value => `${Number(value).toFixed(0)}%`}
                          />
                          <Legend wrapperStyle={{ fontSize: 12 }} />
                          <Bar dataKey="returnRate" name="Return rate" fill="var(--color-walnut)" radius={[0, 4, 4, 0]} barSize={12} />
                          <Bar
                            dataKey="conversionRate"
                            name="Conversion rate"
                            fill="var(--color-gold)"
                            radius={[0, 4, 4, 0]}
                            barSize={12}
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </ChartCard>
                </section>
              )
            })()}

            {/* ── Series Performance Table ── */}
            <SeriesTable stats={seriesStats} recBySeriesId={recBySeriesId} recLoading={recLoading} />

            {/* ── Event Instances Table ── */}
            <InstanceTable instances={instanceStats} />
          </>
        )}
      </div>
    </div>
  )
}

const tooltipStyle = {
  backgroundColor: 'var(--color-cream)',
  border: '1px solid var(--color-parchment)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--color-espresso)',
}

// ─── Series Performance Table ─────────────────────────────────────────────────

type SeriesSortKey = 'name' | 'totalAttendances' | 'uniqueAttendees' | 'returnRate' | 'conversionRate'

function SeriesTable({
  stats,
  recBySeriesId,
  recLoading,
}: {
  stats: SeriesStat[]
  recBySeriesId: Map<string, SeriesRecommendation>
  recLoading: boolean
}) {
  const [tagFilter, setTagFilter] = useState<EventTag | 'all'>('all')
  const [showArchived, setShowArchived] = useState(false)
  const [sortKey, setSortKey] = useState<SeriesSortKey>('totalAttendances')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  function toggleSort(key: SeriesSortKey) {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const rows = useMemo(() => {
    let filtered = stats.filter(s => (showArchived ? true : !s.isArchived))
    if (tagFilter !== 'all') filtered = filtered.filter(s => s.tag === tagFilter)

    const sorted = [...filtered].sort((a, b) => {
      let cmp = 0
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name)
      else if (sortKey === 'conversionRate') {
        const av = a.conversionRate ?? -1
        const bv = b.conversionRate ?? -1
        cmp = av - bv
      } else {
        cmp = (a[sortKey] as number) - (b[sortKey] as number)
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return sorted
  }, [stats, tagFilter, showArchived, sortKey, sortDir])

  return (
    <section>
      <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
        <h2 className="text-lg font-semibold text-espresso">Series Performance</h2>
        <div className="flex items-center gap-2 flex-wrap">
          <TagChip label="All" active={tagFilter === 'all'} onClick={() => setTagFilter('all')} />
          {ALL_TAGS.map(tag => (
            <TagChip
              key={tag}
              label={TAG_LABEL[tag]}
              active={tagFilter === tag}
              onClick={() => setTagFilter(tag)}
            />
          ))}
          <label className="flex items-center gap-1.5 text-xs text-walnut ml-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={e => setShowArchived(e.target.checked)}
              className="accent-terracotta"
            />
            Show archived
          </label>
        </div>
      </div>

      <div className="bg-parchment rounded-2xl overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="border-b border-cream/80">
              <Th label="Series" sortKey="name" current={sortKey} dir={sortDir} onClick={toggleSort} />
              <th className="text-left px-4 py-2.5 text-xs font-medium text-walnut">Tag</th>
              <Th label="Check-ins" sortKey="totalAttendances" current={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
              <Th label="Unique" sortKey="uniqueAttendees" current={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
              <Th label="Return %" sortKey="returnRate" current={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
              <Th label="Conversion %" sortKey="conversionRate" current={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
              <th className="text-left px-4 py-2.5 text-xs font-medium text-walnut">AI</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-8 text-walnut text-sm">
                  No series match this filter.
                </td>
              </tr>
            ) : (
              rows.map(s => {
                const rec = recBySeriesId.get(s.id) ?? null
                const isOpen = expandedId === s.id
                return (
                  <Fragment key={s.id}>
                    <tr
                      onClick={() => setExpandedId(isOpen ? null : s.id)}
                      className={`border-b border-cream/60 last:border-0 cursor-pointer hover:bg-cream/40 transition-colors ${
                        s.isArchived ? 'opacity-60' : ''
                      }`}
                    >
                      <td className="px-4 py-2.5 font-medium text-espresso">{s.name}</td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${TAG_STYLES[s.tag]}`}>
                          {s.tag}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-walnut">{s.totalAttendances}</td>
                      <td className="px-4 py-2.5 text-right text-walnut">{s.uniqueAttendees}</td>
                      <td
                        className={`px-4 py-2.5 text-right font-medium ${
                          s.returnRate >= 35 ? 'text-terracotta' : 'text-walnut'
                        }`}
                      >
                        {s.uniqueAttendees > 0 ? `${s.returnRate.toFixed(0)}%` : '—'}
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right font-medium ${
                          s.conversionRate !== null && s.conversionRate >= 20
                            ? 'text-terracotta'
                            : 'text-walnut/60'
                        }`}
                      >
                        {s.conversionRate !== null ? `${s.conversionRate.toFixed(0)}%` : 'N/A'}
                      </td>
                      <td className="px-4 py-2.5">
                        {s.hasEnoughData && !s.isArchived ? (
                          recLoading ? (
                            <div className="w-3 h-3 border border-walnut/40 border-t-transparent rounded-full animate-spin" />
                          ) : rec ? (
                            <AIBadge recommendation={rec} />
                          ) : (
                            <span className="text-xs text-walnut/40">—</span>
                          )
                        ) : (
                          <span className="text-xs text-walnut/40">—</span>
                        )}
                      </td>
                    </tr>
                    {isOpen && (s.description || rec) && (
                      <tr className="border-b border-cream/60 last:border-0 bg-cream/30">
                        <td colSpan={7} className="px-4 py-3 text-xs text-walnut leading-relaxed">
                          {s.description && <p className="mb-1">{s.description}</p>}
                          {rec && <p className="italic">{rec.reason}</p>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Th<K extends string>({
  label,
  sortKey,
  current,
  dir,
  onClick,
  align = 'left',
}: {
  label: string
  sortKey: K
  current: K
  dir: SortDir
  onClick: (key: K) => void
  align?: 'left' | 'right'
}) {
  const active = current === sortKey
  return (
    <th
      onClick={() => onClick(sortKey)}
      className={`px-4 py-2.5 text-xs font-medium text-walnut cursor-pointer select-none hover:text-espresso transition-colors ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && <span className="text-[10px]">{dir === 'asc' ? '▲' : '▼'}</span>}
      </span>
    </th>
  )
}

// ─── Event Instances Table ────────────────────────────────────────────────────

type InstanceSortKey = 'date' | 'totalCheckins' | 'uniqueAttendees'

function InstanceTable({ instances }: { instances: InstanceStat[] }) {
  const [tagFilter, setTagFilter] = useState<EventTag | 'all'>('all')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<InstanceSortKey>('date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [showAll, setShowAll] = useState(false)

  function toggleSort(key: InstanceSortKey) {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const filtered = useMemo(() => {
    let rows = instances
    if (tagFilter !== 'all') rows = rows.filter(i => i.tag === tagFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      rows = rows.filter(
        i =>
          i.seriesName.toLowerCase().includes(q) ||
          (i.instructorName ?? '').toLowerCase().includes(q)
      )
    }
    const sorted = [...rows].sort((a, b) => {
      let cmp = 0
      if (sortKey === 'date') cmp = a.date.localeCompare(b.date)
      else cmp = a[sortKey] - b[sortKey]
      return sortDir === 'asc' ? cmp : -cmp
    })
    return sorted
  }, [instances, tagFilter, search, sortKey, sortDir])

  const visible = showAll ? filtered : filtered.slice(0, 20)

  return (
    <section>
      <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
        <h2 className="text-lg font-semibold text-espresso">
          Events
          <span className="ml-2 text-sm font-normal text-walnut">({filtered.length})</span>
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="text"
            placeholder="Search series or instructor…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="text-xs bg-cream border border-walnut/20 rounded-full px-3 py-1.5 text-espresso placeholder:text-walnut/50 focus:outline-none focus:border-terracotta/50 w-48"
          />
          <TagChip label="All" active={tagFilter === 'all'} onClick={() => setTagFilter('all')} />
          {ALL_TAGS.map(tag => (
            <TagChip
              key={tag}
              label={TAG_LABEL[tag]}
              active={tagFilter === tag}
              onClick={() => setTagFilter(tag)}
            />
          ))}
        </div>
      </div>

      <div className="bg-parchment rounded-2xl overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="border-b border-cream/80">
              <Th label="Date" sortKey="date" current={sortKey} dir={sortDir} onClick={toggleSort} />
              <th className="text-left px-4 py-2.5 text-xs font-medium text-walnut">Series</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-walnut">Tag</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-walnut">Instructor</th>
              <Th label="Check-ins" sortKey="totalCheckins" current={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
              <Th label="Unique" sortKey="uniqueAttendees" current={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-8 text-walnut text-sm">
                  No events match this filter.
                </td>
              </tr>
            ) : (
              visible.map(i => (
                <tr key={i.id} className="border-b border-cream/60 last:border-0 hover:bg-cream/40 transition-colors">
                  <td className="px-4 py-2.5 text-walnut whitespace-nowrap">
                    {new Date(i.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </td>
                  <td className="px-4 py-2.5 font-medium text-espresso">{i.seriesName}</td>
                  <td className="px-4 py-2.5">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${TAG_STYLES[i.tag]}`}>
                      {i.tag}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-walnut">{i.instructorName ?? '—'}</td>
                  <td
                    className={`px-4 py-2.5 text-right ${
                      i.totalCheckins === 0 ? 'text-walnut/40' : 'text-walnut'
                    }`}
                  >
                    {i.totalCheckins}
                  </td>
                  <td className="px-4 py-2.5 text-right text-walnut">{i.uniqueAttendees}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {!showAll && filtered.length > 20 && (
        <button
          onClick={() => setShowAll(true)}
          className="mt-3 text-xs font-medium text-walnut hover:text-espresso transition-colors"
        >
          Show all {filtered.length} events →
        </button>
      )}
    </section>
  )
}

// ─── Shared sub-components ─────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: string
  sub?: string
  accent?: boolean
}) {
  return (
    <div className={`rounded-2xl px-4 py-3.5 ${accent ? 'bg-espresso text-cream' : 'bg-parchment'}`}>
      <p className={`text-xs font-medium mb-1 ${accent ? 'text-cream/60' : 'text-walnut'}`}>{label}</p>
      <p className={`text-xl font-bold leading-tight ${accent ? 'text-cream' : 'text-espresso'}`}>{value}</p>
      {sub && <p className={`text-[11px] mt-0.5 ${accent ? 'text-cream/50' : 'text-walnut/60'}`}>{sub}</p>}
    </div>
  )
}

function ChartCard({
  title,
  controls,
  children,
  className = '',
}: {
  title: string
  controls?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={`bg-parchment rounded-2xl p-4 ${className}`}>
      <div className="flex items-center justify-between gap-3 mb-2">
        <h3 className="text-sm font-semibold text-espresso">{title}</h3>
        {controls && <div className="flex items-center gap-1 shrink-0">{controls}</div>}
      </div>
      {children}
    </div>
  )
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-[240px] text-sm text-walnut/60">
      {message}
    </div>
  )
}

function TagChip({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`text-xs font-medium px-3 py-1.5 rounded-full transition-colors ${
        active ? 'bg-terracotta text-cream' : 'bg-cream text-walnut hover:bg-walnut/10'
      }`}
    >
      {label}
    </button>
  )
}

function SyncButton({
  label,
  syncing,
  onClick,
  result,
}: {
  label: string
  syncing: boolean
  onClick: () => void
  result: string | null
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onClick}
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
            {label}
          </>
        )}
      </button>
      {result && <span className="text-xs text-walnut">{result}</span>}
    </div>
  )
}

function AIBadge({ recommendation }: { recommendation: SeriesRecommendation }) {
  const isContinue = recommendation.badge === 'Continue'
  return (
    <div
      className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${
        isContinue ? 'bg-gold/30 text-espresso' : 'bg-terracotta/15 text-terracotta'
      }`}
    >
      <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
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
