'use client'

import { Fragment, useState, useEffect, useMemo, useRef, useCallback } from 'react'
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
  conversionRate: number | null  // outreach→core (used for AI recs)
  hasEnoughData: boolean
  monthsOfData: number
  instanceCount: number          // distinct events with ≥1 check-in
  avgAttendance: number          // totalAttendances / instanceCount
  newAttendeeCount: number       // attendees for whom this was their 1st ever Bhakti event
  newAttendeeConversion: number  // % of those who came to any later Bhakti event
  returningMembers: number       // attendees who already had a prior Bhakti event
}

type InstanceStat = {
  id: string
  date: string
  instructorName: string | null
  seriesName: string
  seriesId: string
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

// Index of the first bucket in each calendar year present in a month-keyed series
function yearTicks(data: { key: string }[]): { index: number; year: string }[] {
  const ticks: { index: number; year: string }[] = []
  let lastYear: string | null = null
  data.forEach((d, i) => {
    const year = d.key.slice(0, 4)
    if (year !== lastYear) {
      ticks.push({ index: i, year })
      lastYear = year
    }
  })
  return ticks
}

// Supabase caps un-paginated selects at 1000 rows; page through with .range()
// so large tables (e.g. attendances) don't silently lose rows from the middle.
const PAGE_SIZE = 1000

async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => Promise<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const rows: T[] = []
  let from = 0
  for (;;) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return rows
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

  // Earliest Bhakti attendance per person across all series (for new vs returning detection)
  const globalFirst = new Map<string, string>()
  const allDatesByPerson = new Map<string, string[]>()
  for (const att of allAttendances) {
    const { person_id, checked_in_at } = att
    if (!globalFirst.has(person_id) || checked_in_at < globalFirst.get(person_id)!) {
      globalFirst.set(person_id, checked_in_at)
    }
    if (!allDatesByPerson.has(person_id)) allDatesByPerson.set(person_id, [])
    allDatesByPerson.get(person_id)!.push(checked_in_at)
  }

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

    // Earliest date each person attended THIS series
    const firstInSeriesByPerson = new Map<string, string>()
    for (const att of atts) {
      const cur = firstInSeriesByPerson.get(att.person_id)
      if (!cur || att.checked_in_at < cur) firstInSeriesByPerson.set(att.person_id, att.checked_in_at)
    }

    let newAttendeeCount = 0
    let newAttendeeConverted = 0
    let returningMembers = 0

    for (const [personId, firstHere] of firstInSeriesByPerson) {
      if (firstHere === globalFirst.get(personId)) {
        // This was their very first Bhakti event globally
        newAttendeeCount++
        const laterEvents = (allDatesByPerson.get(personId) ?? []).some(d => d > firstHere)
        if (laterEvents) newAttendeeConverted++
      } else {
        // They had attended Bhakti events before this series
        returningMembers++
      }
    }

    const instanceCount = new Set(atts.map(a => a.event_instance_id)).size
    const avgAttendance = instanceCount > 0 ? totalAttendances / instanceCount : 0
    const newAttendeeConversion = newAttendeeCount > 0 ? (newAttendeeConverted / newAttendeeCount) * 100 : 0

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
      instanceCount,
      avgAttendance,
      newAttendeeCount,
      newAttendeeConversion,
      returningMembers,
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
      seriesId: inst.series_id,
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

  // Monthly trend: full history, month by month, from the earliest attendance to this month
  const now = new Date()
  const earliestAttendance = allAttendances.reduce<Date | null>((min, att) => {
    const d = new Date(att.checked_in_at)
    return !min || d < min ? d : min
  }, null)
  const monthsOfHistory = earliestAttendance
    ? (now.getFullYear() - earliestAttendance.getFullYear()) * 12 +
      (now.getMonth() - earliestAttendance.getMonth())
    : 0
  const monthBuckets: MonthBucket[] = []
  const bucketIndex = new Map<string, number>()
  for (let i = monthsOfHistory; i >= 0; i--) {
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

  // Growth trend: cumulative unique attendees, aligned to the same consecutive
  // month timeline as monthlyTrend so both charts share one continuous x-axis
  const growthBucketMap = new Map<string, number>()
  for (const [, firstDate] of firstAttendanceByPerson) {
    const key = monthKey(firstDate)
    growthBucketMap.set(key, (growthBucketMap.get(key) ?? 0) + 1)
  }
  let cumulative = 0
  const growthTrend: GrowthPoint[] = monthBuckets.map(b => {
    const newAttendees = growthBucketMap.get(b.key) ?? 0
    cumulative += newAttendees
    return { key: b.key, label: b.label, newAttendees, cumulative }
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
  const [growthRange, setGrowthRange] = useState<[number, number] | null>(null)
  const [monthlyRange, setMonthlyRange] = useState<[number, number] | null>(null)
  const [showAllSeries, setShowAllSeries] = useState(false)
  const [showOrganizer, setShowOrganizer] = useState(false)

  useEffect(() => {
    loadData()
  }, [])

  // Default both range sliders to the trailing 12 months once data arrives
  useEffect(() => {
    if (!studioStats) return
    if (growthRange === null) {
      const len = studioStats.growthTrend.length
      setGrowthRange([Math.max(0, len - 12), Math.max(0, len - 1)])
    }
    if (monthlyRange === null) {
      const len = studioStats.monthlyTrend.length
      setMonthlyRange([Math.max(0, len - 12), Math.max(0, len - 1)])
    }
  }, [studioStats, growthRange, monthlyRange])

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

  async function loadData(silent = false) {
    if (!silent) setLoading(true)
    const [{ data: series }, rawAttendances, rawInstances, { count: totalPeople }, { count: activeMembers }] =
      await Promise.all([
        supabase.from('event_series').select('id, name, tag, description, is_archived').order('name'),
        fetchAllRows<RawAttendance>((from, to) =>
          supabase
            .from('attendances')
            .select(
              'person_id, checked_in_at, event_instance_id, event_instances ( date, instructor_name, series_id, event_series ( name, tag ) )'
            )
            .order('checked_in_at', { ascending: true })
            .range(from, to) as unknown as Promise<{ data: RawAttendance[] | null; error: { message: string } | null }>
        ),
        fetchAllRows<RawInstance>((from, to) =>
          supabase
            .from('event_instances')
            .select('id, date, instructor_name, series_id, event_series ( name, tag )')
            .order('date', { ascending: false })
            .range(from, to) as unknown as Promise<{ data: RawInstance[] | null; error: { message: string } | null }>
        ),
        supabase.from('people').select('id', { count: 'exact', head: true }),
        supabase.from('people').select('id', { count: 'exact', head: true }).eq('is_active', true),
      ])

    const rawSeries = (series as RawSeries[]) ?? []

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
    if (!studioStats || !growthRange) return []
    const [start, end] = growthRange
    return studioStats.growthTrend.slice(start, end + 1)
  }, [studioStats, growthRange])

  const filteredMonthlyData = useMemo(() => {
    if (!studioStats || !monthlyRange) return []
    const [start, end] = monthlyRange
    return studioStats.monthlyTrend.slice(start, end + 1)
  }, [studioStats, monthlyRange])

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
              <ChartCard
                title="Monthly Attendance"
                className="lg:col-span-2"
                controls={
                  monthlyRange && (
                    <RangeSlider data={studioStats.monthlyTrend} value={monthlyRange} onChange={setMonthlyRange} />
                  )
                }
              >
                <ResponsiveContainer width="100%" height={260}>
                  <ComposedChart data={filteredMonthlyData}>
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
                  growthRange && (
                    <RangeSlider data={studioStats.growthTrend} value={growthRange} onChange={setGrowthRange} />
                  )
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
              const activeSeries = seriesStats
                .filter(s => !s.isArchived && s.totalAttendances > 0)
                .sort((a, b) => b.totalAttendances - a.totalAttendances)
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

            {/* ── Event Instances / Organizer ── */}
            {showOrganizer ? (
              <SeriesOrganizer
                instances={instanceStats}
                allSeries={seriesStats}
                onClose={() => setShowOrganizer(false)}
                onRefresh={() => loadData(true)}
              />
            ) : (
              <InstanceTable instances={instanceStats} onOrganize={() => setShowOrganizer(true)} />
            )}
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

type SeriesSortKey = 'name' | 'totalAttendances' | 'uniqueAttendees' | 'returnRate' | 'conversionRate' | 'instanceCount' | 'avgAttendance' | 'returningMembers' | 'newAttendeeConversion'

// Category grouping rules — order matters (first match wins)
const GROUP_RULES: { id: string; label: string; matches: (n: string) => boolean }[] = [
  { id: 'harmonium',         label: 'Harmonium Classes',     matches: n => /harmonium/i.test(n) },
  { id: 'kirtan',            label: 'Kirtan Events',         matches: n => /kirtan/i.test(n) },
  { id: 'outdoor-yoga',      label: 'Outdoor Yoga',          matches: n => /outdoor yoga/i.test(n) },
  { id: 'self-care-lab',     label: 'Self Care Lab',         matches: n => /self care lab/i.test(n) },
  { id: 'bhakti-open-mic',   label: 'Bhakti Open Mic',       matches: n => /open mic/i.test(n) },
  { id: 'bhakti-book-club',  label: 'Bhakti Book Club',      matches: n => /book club/i.test(n) },
  { id: 'reflection-room',   label: 'Reflection Room',       matches: n => /reflection room/i.test(n) },
  { id: 'astrology',         label: 'Astrology',             matches: n => /astrology|zodiac/i.test(n) },
  { id: 'gong-sound',        label: 'Gong Sound Immersion',  matches: n => /gong sound/i.test(n) },
  { id: 'cinema',            label: 'Cinema Nights',         matches: n => /cinema night|community movie/i.test(n) },
  { id: 'values-lab',        label: 'The Values Lab',        matches: n => /values lab/i.test(n) },
  { id: 'bhakti-talks',      label: 'Bhakti Talks',          matches: n => /bhakti talks/i.test(n) },
  { id: 'ayurvedic-cooking', label: 'Ayurvedic Cooking',     matches: n => /ayurved/i.test(n) },
  { id: 'soul-talks',        label: 'Soul Talks',            matches: n => /^soul talks/i.test(n) },
  { id: 'yoga-beyond-mat',   label: 'Yoga Beyond the Mat',   matches: n => /beyond the mat/i.test(n) },
  { id: 'yoga',              label: 'Yoga',                  matches: n => /\byoga\b/i.test(n) },
]

type SeriesGroup = {
  id: string
  label: string
  tag: EventTag
  members: SeriesStat[]     // sorted by totalAttendances desc
  totalAttendances: number
  uniqueAttendees: number
  returnRate: number        // weighted avg by uniqueAttendees
  conversionRate: number | null
  instanceCount: number
  avgAttendance: number
  newAttendeeCount: number
  newAttendeeConversion: number
  returningMembers: number
}

type TableRow =
  | { kind: 'group';  data: SeriesGroup }
  | { kind: 'series'; data: SeriesStat }

function buildRows(stats: SeriesStat[], sortKey: SeriesSortKey, sortDir: SortDir): TableRow[] {
  const buckets = new Map<string, SeriesStat[]>(GROUP_RULES.map(r => [r.id, []]))
  const ungrouped: SeriesStat[] = []

  for (const s of stats) {
    const rule = GROUP_RULES.find(r => r.matches(s.name))
    if (rule) buckets.get(rule.id)!.push(s)
    else ungrouped.push(s)
  }

  const groupRows: TableRow[] = []
  for (const rule of GROUP_RULES) {
    const members = buckets.get(rule.id)!
    if (members.length === 0) continue
    if (members.length === 1) { ungrouped.push(members[0]); continue }

    const totalAttendances = members.reduce((s, m) => s + m.totalAttendances, 0)
    const uniqueAttendees  = members.reduce((s, m) => s + m.uniqueAttendees, 0)
    const returnRate       = uniqueAttendees > 0
      ? members.reduce((s, m) => s + m.returnRate * m.uniqueAttendees, 0) / uniqueAttendees
      : 0
    const convMembers  = members.filter(m => m.conversionRate !== null)
    const convWeight   = convMembers.reduce((s, m) => s + m.uniqueAttendees, 0)
    const conversionRate = convMembers.length > 0 && convWeight > 0
      ? convMembers.reduce((s, m) => s + m.conversionRate! * m.uniqueAttendees, 0) / convWeight
      : null

    const instanceCount = members.reduce((s, m) => s + m.instanceCount, 0)
    const avgAttendance = instanceCount > 0 ? totalAttendances / instanceCount : 0
    const newAttendeeCount = members.reduce((s, m) => s + m.newAttendeeCount, 0)
    const newAttendeeConversion = newAttendeeCount > 0
      ? members.reduce((s, m) => s + m.newAttendeeConversion * m.newAttendeeCount, 0) / newAttendeeCount
      : 0
    const returningMembers = members.reduce((s, m) => s + m.returningMembers, 0)

    const tagCount = new Map<EventTag, number>()
    members.forEach(m => tagCount.set(m.tag, (tagCount.get(m.tag) ?? 0) + m.totalAttendances))
    const tag = [...tagCount.entries()].sort((a, b) => b[1] - a[1])[0][0]

    groupRows.push({
      kind: 'group',
      data: {
        id: rule.id, label: rule.label, tag, members: [...members].sort((a, b) => b.totalAttendances - a.totalAttendances),
        totalAttendances, uniqueAttendees, returnRate, conversionRate,
        instanceCount, avgAttendance, newAttendeeCount, newAttendeeConversion, returningMembers,
      },
    })
  }

  const all: TableRow[] = [
    ...groupRows,
    ...ungrouped.map(s => ({ kind: 'series' as const, data: s })),
  ]

  return all.sort((a, b) => {
    if (sortKey === 'name') {
      const aName = a.kind === 'group' ? a.data.label : a.data.name
      const bName = b.kind === 'group' ? b.data.label : b.data.name
      const cmp = aName.localeCompare(bName)
      return sortDir === 'asc' ? cmp : -cmp
    }
    const av = sortKey === 'conversionRate' ? (a.data.conversionRate ?? -1) : (a.data[sortKey] as number)
    const bv = sortKey === 'conversionRate' ? (b.data.conversionRate ?? -1) : (b.data[sortKey] as number)
    return sortDir === 'asc' ? av - bv : bv - av
  })
}

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

  // Grouped view when no tag filter; flat view when filtering by tag
  const rows = useMemo(() => {
    let filtered = stats.filter(s => (showArchived ? true : !s.isArchived) && s.instanceCount >= 2)
    if (tagFilter !== 'all') {
      filtered = filtered.filter(s => s.tag === tagFilter)
      // Flat sort for tag-filtered view
      return filtered.sort((a, b) => {
        if (sortKey === 'name') {
          const cmp = a.name.localeCompare(b.name)
          return sortDir === 'asc' ? cmp : -cmp
        }
        const av = sortKey === 'conversionRate' ? (a.conversionRate ?? -1) : (a[sortKey] as number)
        const bv = sortKey === 'conversionRate' ? (b.conversionRate ?? -1) : (b[sortKey] as number)
        return sortDir === 'asc' ? av - bv : bv - av
      }).map(s => ({ kind: 'series' as const, data: s }))
    }
    return buildRows(filtered, sortKey, sortDir)
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
        <table className="w-full text-sm min-w-[900px]">
          <thead className="sticky top-16 z-10 bg-parchment">
            <tr className="border-b border-cream/80">
              <Th label="Series" sortKey="name" current={sortKey} dir={sortDir} onClick={toggleSort} />
              <th className="text-left px-4 py-2.5 text-xs font-medium text-walnut">Tag</th>
              <Th label="Events" sortKey="instanceCount" current={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
              <Th label="Avg Att." sortKey="avgAttendance" current={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
              <Th label="Check-ins" sortKey="totalAttendances" current={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
              <Th label="Unique" sortKey="uniqueAttendees" current={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
              <Th label="Returning" sortKey="returningMembers" current={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
              <Th label="Return %" sortKey="returnRate" current={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
              <Th label="Conversion %" sortKey="newAttendeeConversion" current={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
              <th className="text-left px-4 py-2.5 text-xs font-medium text-walnut">AI</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="text-center py-8 text-walnut text-sm">
                  No series match this filter.
                </td>
              </tr>
            ) : (
              rows.map(row => {
                if (row.kind === 'group') {
                  const g = row.data
                  const isOpen = expandedId === g.id
                  return (
                    <Fragment key={`group-${g.id}`}>
                      {/* ── Group header row ── */}
                      <tr
                        onClick={() => setExpandedId(isOpen ? null : g.id)}
                        className="border-b border-cream/60 cursor-pointer hover:bg-cream/40 transition-colors bg-walnut/5"
                      >
                        <td className="px-4 py-2.5 font-semibold text-espresso">
                          <span className="inline-flex items-center gap-2">
                            <span className="text-[10px] text-walnut/50">{isOpen ? '▼' : '▶'}</span>
                            {g.label}
                            <span className="text-xs font-normal text-walnut/40">{g.members.length} series</span>
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${TAG_STYLES[g.tag]}`}>
                            {g.tag}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right font-semibold text-walnut">{g.instanceCount}</td>
                        <td className="px-4 py-2.5 text-right font-semibold text-walnut">{g.avgAttendance.toFixed(1)}</td>
                        <td className="px-4 py-2.5 text-right font-semibold text-walnut">{g.totalAttendances}</td>
                        <td className="px-4 py-2.5 text-right font-semibold text-walnut">{g.uniqueAttendees}</td>
                        <td className="px-4 py-2.5 text-right font-semibold text-walnut">{g.returningMembers}</td>
                        <td className={`px-4 py-2.5 text-right font-semibold ${g.returnRate >= 35 ? 'text-terracotta' : 'text-walnut'}`}>
                          {g.uniqueAttendees > 0 ? `${g.returnRate.toFixed(0)}%` : '—'}
                        </td>
                        <td className={`px-4 py-2.5 text-right font-semibold ${g.newAttendeeConversion >= 20 ? 'text-terracotta' : 'text-walnut/60'}`}>
                          {g.newAttendeeCount > 0 ? `${g.newAttendeeConversion.toFixed(0)}%` : '—'}
                        </td>
                        <td className="px-4 py-2.5" />
                      </tr>
                      {/* ── Expanded member rows ── */}
                      {isOpen && g.members.map((s, i) => {
                        const rec = recBySeriesId.get(s.id) ?? null
                        return (
                          <tr key={s.id} className={`border-b border-cream/40 last:border-0 bg-cream/25 ${s.isArchived ? 'opacity-60' : ''}`}>
                            <td className="pl-10 pr-4 py-2 text-espresso">
                              <span className="inline-flex items-center gap-2">
                                <span className="text-[10px] font-bold text-walnut/30 w-4 shrink-0 text-right">#{i + 1}</span>
                                <span className="text-sm">{s.name}</span>
                              </span>
                            </td>
                            <td className="px-4 py-2">
                              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${TAG_STYLES[s.tag]}`}>
                                {s.tag}
                              </span>
                            </td>
                            <td className="px-4 py-2 text-right text-sm text-walnut">{s.instanceCount}</td>
                            <td className="px-4 py-2 text-right text-sm text-walnut">{s.avgAttendance.toFixed(1)}</td>
                            <td className="px-4 py-2 text-right text-sm text-walnut">{s.totalAttendances}</td>
                            <td className="px-4 py-2 text-right text-sm text-walnut">{s.uniqueAttendees}</td>
                            <td className="px-4 py-2 text-right text-sm text-walnut">{s.returningMembers}</td>
                            <td className={`px-4 py-2 text-right text-sm font-medium ${s.returnRate >= 35 ? 'text-terracotta' : 'text-walnut'}`}>
                              {s.uniqueAttendees > 0 ? `${s.returnRate.toFixed(0)}%` : '—'}
                            </td>
                            <td className={`px-4 py-2 text-right text-sm font-medium ${s.newAttendeeConversion >= 20 ? 'text-terracotta' : 'text-walnut/60'}`}>
                              {s.newAttendeeCount > 0 ? `${s.newAttendeeConversion.toFixed(0)}%` : '—'}
                            </td>
                            <td className="px-4 py-2">
                              {s.hasEnoughData && !s.isArchived && (
                                recLoading
                                  ? <div className="w-3 h-3 border border-walnut/40 border-t-transparent rounded-full animate-spin" />
                                  : rec ? <AIBadge recommendation={rec} /> : <span className="text-xs text-walnut/40">—</span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </Fragment>
                  )
                }

                // ── Individual (ungrouped) series row ──
                const s = row.data
                const rec = recBySeriesId.get(s.id) ?? null
                const isOpen = expandedId === s.id
                return (
                  <Fragment key={s.id}>
                    <tr
                      onClick={() => setExpandedId(isOpen ? null : s.id)}
                      className={`border-b border-cream/60 last:border-0 cursor-pointer hover:bg-cream/40 transition-colors ${s.isArchived ? 'opacity-60' : ''}`}
                    >
                      <td className="px-4 py-2.5 font-medium text-espresso">{s.name}</td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${TAG_STYLES[s.tag]}`}>
                          {s.tag}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-walnut">{s.instanceCount}</td>
                      <td className="px-4 py-2.5 text-right text-walnut">{s.avgAttendance.toFixed(1)}</td>
                      <td className="px-4 py-2.5 text-right text-walnut">{s.totalAttendances}</td>
                      <td className="px-4 py-2.5 text-right text-walnut">{s.uniqueAttendees}</td>
                      <td className="px-4 py-2.5 text-right text-walnut">{s.returningMembers}</td>
                      <td className={`px-4 py-2.5 text-right font-medium ${s.returnRate >= 35 ? 'text-terracotta' : 'text-walnut'}`}>
                        {s.uniqueAttendees > 0 ? `${s.returnRate.toFixed(0)}%` : '—'}
                      </td>
                      <td className={`px-4 py-2.5 text-right font-medium ${s.newAttendeeConversion >= 20 ? 'text-terracotta' : 'text-walnut/60'}`}>
                        {s.newAttendeeCount > 0 ? `${s.newAttendeeConversion.toFixed(0)}%` : '—'}
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
                        <td colSpan={10} className="px-4 py-3 text-xs text-walnut leading-relaxed">
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

function InstanceTable({ instances, onOrganize }: { instances: InstanceStat[]; onOrganize?: () => void }) {
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
          {onOrganize && (
            <button
              onClick={onOrganize}
              className="text-xs font-medium px-3 py-1.5 rounded-full bg-espresso text-cream hover:bg-walnut transition-colors"
            >
              Organize
            </button>
          )}
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

// ─── Series Organizer ────────────────────────────────────────────────────────────

type OrgTarget =
  | { kind: 'group'; id: string; label: string; tag: EventTag; assignSeriesId: string; memberIds: string[] }
  | { kind: 'series'; id: string; label: string; tag: EventTag; assignSeriesId: string }

// Stored in `placements` to mean "explicitly in unsorted pool"
const UNSORTED_MARKER = '__unsorted__'
// hoverTargetId value for the left panel
const UNSORTED_DROP_ID = '__unsorted__'

// Defined at module level so React never remounts it on re-render (avoids drag interruption)
function OrgEventRow({
  inst,
  indent = false,
  isDragging,
  isSaving,
  error,
  onDragStart,
  onDragEnd,
}: {
  inst: InstanceStat
  indent?: boolean
  isDragging: boolean
  isSaving: boolean
  error: string | undefined
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`flex items-center gap-2 px-3 py-2 rounded-lg select-none cursor-grab active:cursor-grabbing transition-opacity ${
        indent ? 'ml-4 bg-cream/40 hover:bg-cream/80' : 'hover:bg-cream/60'
      } ${isDragging ? 'opacity-30' : ''}`}
    >
      <span className="text-walnut/25 shrink-0 text-xs">⠿</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium truncate text-espresso">{inst.seriesName}</p>
        <p className="text-[10px] text-walnut/50 truncate">
          {new Date(inst.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          {inst.instructorName ? ` · ${inst.instructorName}` : ''}
          {` · ${inst.totalCheckins} check-in${inst.totalCheckins !== 1 ? 's' : ''}`}
        </p>
        {error && <p className="text-[10px] text-red-500 mt-0.5 truncate">{error}</p>}
      </div>
      {isSaving && <div className="w-2.5 h-2.5 border border-walnut/40 border-t-transparent rounded-full animate-spin shrink-0" />}
    </div>
  )
}

function SeriesOrganizer({
  instances,
  allSeries,
  onClose,
  onRefresh,
}: {
  instances: InstanceStat[]
  allSeries: SeriesStat[]
  onClose: () => void
  onRefresh: () => void
}) {
  const supabase = useMemo(() => createClient(), [])

  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [hoverTargetId, setHoverTargetId] = useState<string | null>(null)
  const [expandedTargetId, setExpandedTargetId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  // placements: instanceId → seriesId (moved there) | UNSORTED_MARKER (pulled to unsorted)
  const [placements, setPlacements] = useState<Map<string, string>>(new Map())
  const [newSeriesName, setNewSeriesName] = useState('')
  const [newSeriesTag, setNewSeriesTag] = useState<EventTag>('other')
  const [creating, setCreating] = useState(false)
  const [saving, setSaving] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Map<string, string>>(new Map())
  const [createdSeries, setCreatedSeries] = useState<Array<{ id: string; name: string; tag: EventTag }>>([])
  const originalSeriesRef = useRef<Map<string, string>>(new Map())

  // Snapshot which series are "sorted" at mount time — never changes during the session.
  // This prevents allSeries changes (e.g. creating a new series that forms a group) from
  // silently moving events out of the unsorted pool without user action.
  const [initialSortedSeriesIds] = useState<Set<string>>(() => {
    const buckets = new Map<string, SeriesStat[]>(GROUP_RULES.map(r => [r.id, []]))
    const ungrouped: SeriesStat[] = []
    for (const s of allSeries.filter(s => !s.isArchived)) {
      const rule = GROUP_RULES.find(r => r.matches(s.name))
      if (rule) buckets.get(rule.id)!.push(s)
      else ungrouped.push(s)
    }
    const sorted = new Set<string>()
    for (const rule of GROUP_RULES) {
      const members = buckets.get(rule.id)!
      if (members.length >= 2) members.forEach(m => sorted.add(m.id))
    }
    for (const s of ungrouped) {
      if (s.instanceCount >= 2) sorted.add(s.id)
    }
    return sorted
  })

  const dropTargets = useMemo(() => {
    const createdIds = new Set(createdSeries.map(s => s.id))
    const buckets = new Map<string, SeriesStat[]>(GROUP_RULES.map(r => [r.id, []]))
    const ungrouped: SeriesStat[] = []

    for (const s of allSeries.filter(s => !s.isArchived)) {
      // Skip user-created series from GROUP_RULE matching — they always appear as plain targets
      if (createdIds.has(s.id)) { ungrouped.push(s); continue }
      const rule = GROUP_RULES.find(r => r.matches(s.name))
      if (rule) buckets.get(rule.id)!.push(s)
      else ungrouped.push(s)
    }

    const targets: OrgTarget[] = []

    for (const rule of GROUP_RULES) {
      const members = buckets.get(rule.id)!
      if (members.length < 2) continue
      const sorted = [...members].sort((a, b) => b.totalAttendances - a.totalAttendances)
      const memberIds = sorted.map(m => m.id)
      const tagTotals = new Map<EventTag, number>()
      members.forEach(m => tagTotals.set(m.tag, (tagTotals.get(m.tag) ?? 0) + m.totalAttendances))
      const tag = [...tagTotals.entries()].sort((a, b) => b[1] - a[1])[0][0]
      targets.push({ kind: 'group', id: rule.id, label: rule.label, tag, assignSeriesId: sorted[0].id, memberIds })
    }

    const seen = new Set<string>()
    for (const s of ungrouped) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      if (s.instanceCount >= 2 || createdIds.has(s.id)) {
        targets.push({ kind: 'series', id: s.id, label: s.name, tag: s.tag, assignSeriesId: s.id })
      }
    }

    // Ensure any created series not yet in allSeries (pre-refresh) still appears
    const addedTargetIds = new Set(targets.map(t => t.id))
    for (const s of createdSeries) {
      if (!addedTargetIds.has(s.id)) {
        const current = allSeries.find(a => a.id === s.id)
        targets.push({ kind: 'series', id: s.id, label: s.name, tag: current?.tag ?? s.tag, assignSeriesId: s.id })
      }
    }

    targets.sort((a, b) => a.label.localeCompare(b.label))
    return targets
  }, [allSeries, createdSeries])

  // Count events visually assigned to each series (for divider badges)
  const countBySeries = useMemo(() => {
    const m = new Map<string, number>()
    for (const inst of instances) {
      const p = placements.get(inst.id)
      if (p === UNSORTED_MARKER) continue
      if (p !== undefined) {
        m.set(p, (m.get(p) ?? 0) + 1)
      } else if (initialSortedSeriesIds.has(inst.seriesId)) {
        m.set(inst.seriesId, (m.get(inst.seriesId) ?? 0) + 1)
      }
    }
    return m
  }, [instances, placements, initialSortedSeriesIds])

  function getTargetCount(target: OrgTarget): number {
    if (target.kind === 'series') return countBySeries.get(target.assignSeriesId) ?? 0
    return target.memberIds.reduce((sum, sid) => sum + (countBySeries.get(sid) ?? 0), 0)
  }

  function getTargetInstances(target: OrgTarget): InstanceStat[] {
    return instances
      .filter(inst => {
        const p = placements.get(inst.id)
        if (p === UNSORTED_MARKER) return false
        if (p !== undefined) {
          if (target.kind === 'series') return p === target.assignSeriesId
          // p can be a member series UUID (old behavior) or the group's rule id (new local-only drag)
          return target.memberIds.includes(p) || p === target.id
        }
        // Natural position: only if sorted at mount time
        if (!initialSortedSeriesIds.has(inst.seriesId)) return false
        return target.kind === 'series'
          ? inst.seriesId === target.assignSeriesId
          : target.memberIds.includes(inst.seriesId)
      })
      .sort((a, b) => b.date.localeCompare(a.date))
  }

  const unsortedInstances = useMemo(() => {
    const q = search.trim().toLowerCase()
    return instances
      .filter(inst => {
        const p = placements.get(inst.id)
        if (p === UNSORTED_MARKER) return true
        if (p !== undefined) return false
        return !initialSortedSeriesIds.has(inst.seriesId)
      })
      .filter(inst =>
        !q ||
        inst.seriesName.toLowerCase().includes(q) ||
        inst.date.includes(q) ||
        (inst.instructorName?.toLowerCase().includes(q) ?? false)
      )
      .sort((a, b) => b.date.localeCompare(a.date))
  }, [instances, initialSortedSeriesIds, placements, search])

  async function moveInstance(instanceId: string, target: OrgTarget) {
    const isGroup = target.kind === 'group'
    // Group targets are local-only: no DB write, so the event's series_id never changes
    // Only individual series targets persist to DB
    const placementKey = isGroup ? target.id : target.assignSeriesId

    if (!isGroup && !originalSeriesRef.current.has(instanceId)) {
      const inst = instances.find(i => i.id === instanceId)
      if (inst) originalSeriesRef.current.set(instanceId, inst.seriesId)
    }

    setPlacements(prev => new Map(prev).set(instanceId, placementKey))
    if (isGroup) return

    setSaving(prev => new Set(prev).add(instanceId))
    setErrors(prev => { const m = new Map(prev); m.delete(instanceId); return m })

    const { error } = await supabase
      .from('event_instances')
      .update({ series_id: target.assignSeriesId })
      .eq('id', instanceId)

    setSaving(prev => { const s = new Set(prev); s.delete(instanceId); return s })
    if (error) {
      setPlacements(prev => { const m = new Map(prev); m.delete(instanceId); return m })
      setErrors(prev => new Map(prev).set(instanceId, error.message))
    } else {
      onRefresh()
    }
  }

  async function revertToUnsorted(instanceId: string) {
    const prevPlacement = placements.get(instanceId)
    // Show in unsorted immediately — no waiting for DB round-trip
    setPlacements(prev => new Map(prev).set(instanceId, UNSORTED_MARKER))

    if (prevPlacement !== undefined && prevPlacement !== UNSORTED_MARKER) {
      // Was explicitly moved to a series → revert DB to original
      const originalSid = originalSeriesRef.current.get(instanceId)
      if (originalSid) {
        originalSeriesRef.current.delete(instanceId)
        setSaving(prev => new Set(prev).add(instanceId))
        const { error } = await supabase
          .from('event_instances')
          .update({ series_id: originalSid })
          .eq('id', instanceId)
        setSaving(prev => { const s = new Set(prev); s.delete(instanceId); return s })
        if (!error) onRefresh()
      }
    }
    // If prevPlacement is undefined (naturally in a group): no DB change, unsorted is local-only
  }

  async function archiveSeries(seriesId: string) {
    // Move all events in this series to unsorted before hiding it
    setPlacements(prev => {
      const m = new Map(prev)
      for (const inst of instances) {
        const p = m.get(inst.id)
        const effectiveSid = (p !== undefined && p !== UNSORTED_MARKER) ? p : inst.seriesId
        if (effectiveSid === seriesId) m.set(inst.id, UNSORTED_MARKER)
      }
      return m
    })
    await supabase.from('event_series').update({ is_archived: true }).eq('id', seriesId)
    onRefresh()
  }

  async function deleteSeries(seriesId: string) {
    const movedHere = [...placements.entries()]
      .filter(([, sid]) => sid === seriesId)
      .map(([instId]) => instId)

    setPlacements(prev => {
      const m = new Map(prev)
      movedHere.forEach(id => m.delete(id))
      return m
    })

    const toRevert = instances.filter(i => movedHere.includes(i.id))
    await Promise.all(toRevert.map(i => {
      const orig = originalSeriesRef.current.get(i.id) ?? i.seriesId
      originalSeriesRef.current.delete(i.id)
      return supabase.from('event_instances').update({ series_id: orig }).eq('id', i.id)
    }))

    await supabase.from('event_series').delete().eq('id', seriesId)
    setCreatedSeries(prev => prev.filter(s => s.id !== seriesId))
    onRefresh()
  }

  async function createSeries() {
    const name = newSeriesName.trim()
    if (!name || creating) return
    setCreating(true)

    const { data, error } = await supabase
      .from('event_series')
      .insert({ name, tag: newSeriesTag, description: null, is_archived: false })
      .select('id, name, tag')
      .single()

    setCreating(false)
    if (error) { alert(`Failed to create series: ${error.message}`); return }
    setCreatedSeries(prev => [...prev, { id: data.id, name: data.name, tag: data.tag as EventTag }])
    setNewSeriesName('')
    onRefresh()
  }

  function startDrag(e: React.DragEvent<HTMLDivElement>, instanceId: string) {
    if (!originalSeriesRef.current.has(instanceId)) {
      const inst = instances.find(i => i.id === instanceId)
      if (inst) originalSeriesRef.current.set(instanceId, inst.seriesId)
    }
    setDraggedId(instanceId)
    e.dataTransfer.setData('text/plain', instanceId)
    e.dataTransfer.effectAllowed = 'move'
  }

  const movedCount = [...placements.values()].filter(v => v !== UNSORTED_MARKER).length
  const createdIds = new Set(createdSeries.map(s => s.id))

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-espresso">Organize Events</h2>
          {movedCount > 0 && (
            <p className="text-xs text-terracotta mt-0.5">{movedCount} event{movedCount !== 1 ? 's' : ''} moved this session</p>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-xs font-medium px-3 py-1.5 rounded-full bg-parchment text-walnut hover:bg-walnut/10 transition-colors"
        >
          ← Back to Events
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Left: Unsorted events — also a drop target for reverting */}
        <div
          className={`lg:col-span-3 bg-parchment rounded-2xl p-4 border-2 transition-colors ${
            hoverTargetId === UNSORTED_DROP_ID ? 'border-walnut/30' : 'border-transparent'
          }`}
          onDragOver={e => { e.preventDefault(); setHoverTargetId(UNSORTED_DROP_ID) }}
          onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setHoverTargetId(null) }}
          onDrop={e => {
            e.preventDefault()
            const instanceId = e.dataTransfer.getData('text/plain')
            if (instanceId) revertToUnsorted(instanceId)
            setHoverTargetId(null)
          }}
        >
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-espresso">
              Unsorted Events
              <span className="ml-2 text-xs font-normal text-walnut">({unsortedInstances.length})</span>
            </p>
            <span className="text-[10px] text-walnut/50">
              {hoverTargetId === UNSORTED_DROP_ID && draggedId ? 'drop to unassign' : 'drag to a series →'}
            </span>
          </div>

          <input
            type="text"
            placeholder="Search by series, date, or instructor…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full text-xs bg-cream border border-walnut/20 rounded-lg px-3 py-2 mb-3 focus:outline-none focus:ring-1 focus:ring-walnut/30"
          />

          <div className="space-y-0.5 max-h-[70vh] overflow-y-auto">
            {unsortedInstances.map(inst => (
              <OrgEventRow
                key={inst.id}
                inst={inst}
                isDragging={draggedId === inst.id}
                isSaving={saving.has(inst.id)}
                error={errors.get(inst.id)}
                onDragStart={e => startDrag(e, inst.id)}
                onDragEnd={() => setDraggedId(null)}
              />
            ))}
            {unsortedInstances.length === 0 && (
              <p className="text-xs text-walnut/40 text-center py-8">
                {search.trim() ? 'No events match.' : '✓ All events are sorted!'}
              </p>
            )}
          </div>
        </div>

        {/* Right: Create series + expandable drop targets */}
        <div className="lg:col-span-2 space-y-3">
          <div className="bg-parchment rounded-2xl p-4">
            <p className="text-sm font-semibold text-espresso mb-3">Create New Series</p>
            <form onSubmit={e => { e.preventDefault(); createSeries() }} className="space-y-2">
              <input
                type="text"
                placeholder="Series name…"
                value={newSeriesName}
                onChange={e => setNewSeriesName(e.target.value)}
                className="w-full text-xs bg-cream border border-walnut/20 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-walnut/30"
              />
              <div className="flex gap-2">
                <select
                  value={newSeriesTag}
                  onChange={e => setNewSeriesTag(e.target.value as EventTag)}
                  className="flex-1 text-xs bg-cream border border-walnut/20 rounded-lg px-3 py-2 focus:outline-none"
                >
                  {ALL_TAGS.map(t => (
                    <option key={t} value={t}>{TAG_LABEL[t]}</option>
                  ))}
                </select>
                <button
                  type="submit"
                  disabled={!newSeriesName.trim() || creating}
                  className="text-xs font-medium px-4 py-2 rounded-lg bg-espresso text-cream disabled:opacity-40 transition-opacity"
                >
                  {creating ? '…' : 'Create'}
                </button>
              </div>
            </form>
          </div>

          <div className="bg-parchment rounded-2xl p-4">
            <p className="text-sm font-semibold text-espresso mb-3">
              Series & Groups
              <span className="ml-2 text-xs font-normal text-walnut">({dropTargets.length})</span>
            </p>
            <div className="space-y-1 max-h-[65vh] overflow-y-auto">
              {dropTargets.map(target => {
                const isOver = hoverTargetId === target.id
                const isExpanded = expandedTargetId === target.id
                const isGroup = target.kind === 'group'
                const isNew = target.kind === 'series' && createdIds.has(target.id)
                const isExistingSeries = target.kind === 'series' && !isNew
                const count = getTargetCount(target)
                const eventsInside = isExpanded ? getTargetInstances(target) : []

                return (
                  <div key={target.id}>
                    <div
                      onClick={() => setExpandedTargetId(isExpanded ? null : target.id)}
                      onDragOver={e => {
                        e.preventDefault()
                        e.stopPropagation()
                        e.dataTransfer.dropEffect = 'move'
                        setHoverTargetId(target.id)
                      }}
                      onDragLeave={e => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node)) setHoverTargetId(null)
                      }}
                      onDrop={e => {
                        e.preventDefault()
                        const instanceId = e.dataTransfer.getData('text/plain')
                        if (instanceId) moveInstance(instanceId, target)
                        setHoverTargetId(null)
                      }}
                      className={`flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer select-none border-2 transition-all ${
                        isOver
                          ? 'border-gold bg-gold/10'
                          : isExpanded
                          ? 'border-walnut/20 bg-cream/50'
                          : 'border-transparent hover:bg-cream/60'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <p className={`truncate ${isGroup ? 'text-xs font-semibold text-espresso' : 'text-xs font-medium text-walnut/80'}`}>
                          <span className="mr-1 text-[9px] text-walnut/30">{isExpanded ? '▼' : '▶'}</span>
                          {target.label}
                          {isGroup && (
                            <span className="ml-1.5 text-[10px] font-normal text-walnut/40">
                              {(target as Extract<OrgTarget, { kind: 'group' }>).memberIds.length} series
                            </span>
                          )}
                        </p>
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full capitalize ${TAG_STYLES[target.tag]}`}>
                          {target.tag}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0 ml-2">
                        {count > 0 && <span className="text-[10px] text-walnut/50">{count}</span>}
                        {isOver && draggedId && <span className="text-[10px] text-gold font-semibold">drop</span>}
                        {isNew && (
                          <button
                            onClick={e => { e.stopPropagation(); deleteSeries(target.id) }}
                            title="Delete this series"
                            className="text-sm leading-none text-walnut/25 hover:text-red-400 transition-colors pl-1"
                          >
                            ×
                          </button>
                        )}
                        {isExistingSeries && (
                          <button
                            onClick={e => { e.stopPropagation(); archiveSeries(target.id) }}
                            title="Hide this series"
                            className="text-xs leading-none text-walnut/20 hover:text-walnut/50 transition-colors pl-1"
                          >
                            −
                          </button>
                        )}
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="mt-1 space-y-0.5">
                        {eventsInside.length === 0 ? (
                          <p className="text-[10px] text-walnut/40 pl-6 py-2">
                            No events yet — drop events here.
                          </p>
                        ) : (
                          eventsInside.map(inst => (
                            <OrgEventRow
                              key={inst.id}
                              inst={inst}
                              indent
                              isDragging={draggedId === inst.id}
                              isSaving={saving.has(inst.id)}
                              error={errors.get(inst.id)}
                              onDragStart={e => startDrag(e, inst.id)}
                              onDragEnd={() => setDraggedId(null)}
                            />
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
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

// Snap a dragged handle to a year boundary when within 1 month of it
const SNAP_THRESHOLD = 1

function RangeSlider({
  data,
  value,
  onChange,
}: {
  data: { key: string; label: string }[]
  value: [number, number]
  onChange: (range: [number, number]) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null)
  const ticks = useMemo(() => yearTicks(data), [data])
  const maxIdx = Math.max(0, data.length - 1)
  const [start, end] = value

  const pct = (idx: number) => (maxIdx === 0 ? 0 : (idx / maxIdx) * 100)

  const indexFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current
      if (!track || maxIdx === 0) return 0
      const rect = track.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      return Math.round(ratio * maxIdx)
    },
    [maxIdx]
  )

  const snapToYear = useCallback(
    (idx: number) => {
      let nearest = idx
      let nearestDist = Infinity
      for (const t of ticks) {
        const dist = Math.abs(t.index - idx)
        if (dist < nearestDist) {
          nearestDist = dist
          nearest = t.index
        }
      }
      return nearestDist <= SNAP_THRESHOLD ? nearest : idx
    },
    [ticks]
  )

  useEffect(() => {
    if (!dragging) return
    function handleMove(e: PointerEvent) {
      const idx = snapToYear(indexFromClientX(e.clientX))
      if (dragging === 'start') onChange([Math.min(idx, end), end])
      else onChange([start, Math.max(idx, start)])
    }
    function handleUp() {
      setDragging(null)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
  }, [dragging, start, end, onChange, indexFromClientX, snapToYear])

  if (maxIdx === 0) return null

  return (
    <div className="w-full sm:w-72 select-none">
      <div className="flex items-center justify-between mb-1 gap-2">
        <span className="text-xs font-medium text-walnut truncate">{data[start]?.label}</span>
        <span className="text-xs text-walnut/40">–</span>
        <span className="text-xs font-medium text-walnut truncate">{data[end]?.label}</span>
      </div>
      <div ref={trackRef} className="relative h-5 flex items-center touch-none">
        <div className="absolute inset-x-0 h-1.5 rounded-full bg-cream" />
        <div
          className="absolute h-1.5 rounded-full bg-gold"
          style={{ left: `${pct(start)}%`, right: `${100 - pct(end)}%` }}
        />
        {ticks.map(t => (
          <div
            key={`tick-${t.year}`}
            className="absolute w-px h-2.5 bg-walnut/30 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ left: `${pct(t.index)}%` }}
          />
        ))}
        <button
          type="button"
          aria-label="Range start"
          onPointerDown={e => {
            e.preventDefault()
            setDragging('start')
          }}
          className="absolute w-3.5 h-3.5 rounded-full bg-espresso border-2 border-cream shadow -translate-x-1/2 cursor-grab active:cursor-grabbing z-10"
          style={{ left: `${pct(start)}%` }}
        />
        <button
          type="button"
          aria-label="Range end"
          onPointerDown={e => {
            e.preventDefault()
            setDragging('end')
          }}
          className="absolute w-3.5 h-3.5 rounded-full bg-espresso border-2 border-cream shadow -translate-x-1/2 cursor-grab active:cursor-grabbing z-10"
          style={{ left: `${pct(end)}%` }}
        />
      </div>
      <div className="relative h-3 mt-0.5">
        {ticks.map(t => (
          <span
            key={`label-${t.year}`}
            className="absolute text-[10px] text-walnut/50 -translate-x-1/2 first:translate-x-0 last:-translate-x-full"
            style={{ left: `${pct(t.index)}%` }}
          >
            {t.year}
          </span>
        ))}
      </div>
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
