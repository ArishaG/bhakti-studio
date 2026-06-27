'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

// ─── Types ────────────────────────────────────────────────────────────────────

type EventTag = 'soulfest' | 'outreach' | 'classes' | 'other'

type NextEvent = {
  id: string
  date: string
  instructor_name: string | null
  series_id: string
  series: { name: string; tag: EventTag }
}

type CalEvent = {
  id: string
  date: string
  instructor_name: string | null
  series: { name: string; tag: EventTag }
}

type FlagWithPerson = {
  id: string
  reason: string | null
  created_at: string
  person: {
    id: string
    name: string
    email: string | null
    event_count: number
    is_active: boolean
    last_seen_at: string | null
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TAG_STYLES: Record<EventTag, string> = {
  soulfest: 'bg-gold/30 text-espresso',
  outreach: 'bg-terracotta/20 text-terracotta',
  classes: 'bg-walnut/20 text-walnut',
  other: 'bg-parchment text-walnut',
}

const TAG_DOT: Record<EventTag, string> = {
  soulfest: 'bg-gold',
  outreach: 'bg-terracotta',
  classes: 'bg-walnut',
  other: 'bg-walnut/40',
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const DAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toDateKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function buildCalendarCells(year: number, month: number): (Date | null)[] {
  const first = new Date(year, month, 1)
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const cells: (Date | null)[] = Array(first.getDay()).fill(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d))
  return cells
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function HomePage() {
  const supabase = createClient()
  const today = new Date()

  // Stat bar
  const [activeCount, setActiveCount] = useState<number | null>(null)
  const [nextEvent, setNextEvent] = useState<NextEvent | null>(null)
  const [estimatedAttendance, setEstimatedAttendance] = useState<number | null>(null)
  const [pastEventCount, setPastEventCount] = useState(0)

  // Calendar
  const [calYear, setCalYear] = useState(today.getFullYear())
  const [calMonth, setCalMonth] = useState(today.getMonth())
  const [calEvents, setCalEvents] = useState<CalEvent[]>([])
  const [calLoading, setCalLoading] = useState(true)

  // Follow-up flags
  const [flags, setFlags] = useState<FlagWithPerson[]>([])
  const [flagsLoading, setFlagsLoading] = useState(true)
  const [markingId, setMarkingId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshResult, setRefreshResult] = useState<string | null>(null)

  useEffect(() => {
    loadStats()
    loadFlags()
  }, [])

  useEffect(() => {
    loadCalendar(calYear, calMonth)
  }, [calYear, calMonth])

  // ── Data loaders ────────────────────────────────────────────────────────────

  async function loadStats() {
    const [{ count }, { data: nextEvt }] = await Promise.all([
      supabase
        .from('people')
        .select('id', { count: 'exact', head: true })
        .eq('is_active', true),
      supabase
        .from('event_instances')
        .select('id, date, instructor_name, series_id, series:event_series(name, tag)')
        .gt('date', new Date().toISOString())
        .order('date')
        .limit(1)
        .single(),
    ])

    setActiveCount(count ?? 0)

    if (nextEvt) {
      setNextEvent(nextEvt as unknown as NextEvent)
      await loadEstimatedAttendance((nextEvt as unknown as NextEvent).series_id)
    }
  }

  async function loadEstimatedAttendance(seriesId: string) {
    const { data: pastInstances } = await supabase
      .from('event_instances')
      .select('id')
      .eq('series_id', seriesId)
      .lt('date', new Date().toISOString())

    if (!pastInstances?.length) return

    const ids = pastInstances.map(i => i.id)
    const { data: atts } = await supabase
      .from('attendances')
      .select('event_instance_id')
      .in('event_instance_id', ids)

    if (!atts?.length) return

    // Count attendances per instance then average
    const countByInstance: Record<string, number> = {}
    for (const id of ids) countByInstance[id] = 0
    for (const a of atts) countByInstance[a.event_instance_id]++

    const counts = Object.values(countByInstance).filter(c => c > 0)
    if (!counts.length) return

    const avg = counts.reduce((s, c) => s + c, 0) / counts.length
    setEstimatedAttendance(Math.round(avg))
    setPastEventCount(counts.length)
  }

  async function loadCalendar(year: number, month: number) {
    setCalLoading(true)
    const start = new Date(year, month, 1)
    const end = new Date(year, month + 1, 1)
    const { data } = await supabase
      .from('event_instances')
      .select('id, date, instructor_name, series:event_series(name, tag)')
      .gte('date', start.toISOString())
      .lt('date', end.toISOString())
      .order('date')
    setCalEvents((data as unknown as CalEvent[]) ?? [])
    setCalLoading(false)
  }

  async function loadFlags() {
    setFlagsLoading(true)
    const { data } = await supabase
      .from('follow_up_flags')
      .select(
        'id, reason, created_at, person:people(id, name, email, event_count, is_active, last_seen_at)'
      )
      .eq('resolved', false)
      .order('created_at', { ascending: false })
    setFlags((data as unknown as FlagWithPerson[]) ?? [])
    setFlagsLoading(false)
  }

  async function refreshFollowUpFlags() {
    setRefreshing(true)
    setRefreshResult(null)
    try {
      const res = await fetch('/api/follow-up/generate', { method: 'POST' })
      if (res.ok) {
        const { created } = await res.json()
        setRefreshResult(
          created === 0
            ? 'All caught up — no new flags.'
            : `${created} new flag${created === 1 ? '' : 's'} created.`
        )
        await loadFlags()
      } else {
        setRefreshResult('Something went wrong. Try again.')
      }
    } catch {
      setRefreshResult('Something went wrong. Try again.')
    }
    setRefreshing(false)
  }

  async function markContacted(flagId: string) {
    setMarkingId(flagId)
    await supabase.from('follow_up_flags').update({ resolved: true }).eq('id', flagId)
    setFlags(prev => prev.filter(f => f.id !== flagId))
    setMarkingId(null)
  }

  // Deduplicate flags by person (show only most recent per person)
  const uniquePersonFlags = useMemo(() => {
    const seen = new Set<string>()
    return flags.filter(f => {
      if (seen.has(f.person.id)) return false
      seen.add(f.person.id)
      return true
    })
  }, [flags])

  // Group calendar events by date key
  const eventsByDate = useMemo(() => {
    const map: Record<string, CalEvent[]> = {}
    for (const evt of calEvents) {
      const key = evt.date.slice(0, 10)
      if (!map[key]) map[key] = []
      map[key].push(evt)
    }
    return map
  }, [calEvents])

  const calendarCells = useMemo(
    () => buildCalendarCells(calYear, calMonth),
    [calYear, calMonth]
  )
  const todayKey = toDateKey(today)

  // ── Nav helpers ─────────────────────────────────────────────────────────────

  function prevMonth() {
    if (calMonth === 0) { setCalYear(y => y - 1); setCalMonth(11) }
    else setCalMonth(m => m - 1)
  }
  function nextMonth() {
    if (calMonth === 11) { setCalYear(y => y + 1); setCalMonth(0) }
    else setCalMonth(m => m + 1)
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-cream pt-16">
      <div className="max-w-6xl mx-auto px-4 pt-6 pb-16 space-y-8">

        {/* ── Stat Bar ── */}
        <section>
          <h1 className="text-2xl font-bold text-espresso mb-4">Dashboard</h1>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatCard
              label="Active Members"
              value={activeCount !== null ? activeCount.toString() : '—'}
              sub="with is_active = true"
              accent
            />
            <StatCard
              label="Next Event"
              value={nextEvent ? nextEvent.series.name : 'None scheduled'}
              sub={
                nextEvent
                  ? new Date(nextEvent.date).toLocaleDateString('en-US', {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })
                  : ''
              }
            />
            <StatCard
              label="Est. Attendance"
              value={estimatedAttendance !== null ? `~${estimatedAttendance}` : nextEvent ? '—' : 'No event'}
              sub={
                estimatedAttendance !== null && pastEventCount > 0
                  ? `avg of ${pastEventCount} past ${pastEventCount === 1 ? 'event' : 'events'}`
                  : nextEvent
                  ? 'no past data'
                  : ''
              }
            />
          </div>
        </section>

        {/* ── Calendar ── */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-espresso">
              {MONTH_NAMES[calMonth]} {calYear}
            </h2>
            <div className="flex items-center gap-1">
              <button
                onClick={prevMonth}
                className="p-1.5 rounded-lg text-walnut hover:bg-parchment transition-colors"
                aria-label="Previous month"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <button
                onClick={() => { setCalYear(today.getFullYear()); setCalMonth(today.getMonth()) }}
                className="text-xs font-medium px-2.5 py-1 rounded-lg text-walnut hover:bg-parchment transition-colors"
              >
                Today
              </button>
              <button
                onClick={nextMonth}
                className="p-1.5 rounded-lg text-walnut hover:bg-parchment transition-colors"
                aria-label="Next month"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>

          <div className="bg-parchment rounded-2xl overflow-hidden">
            {/* Day headers */}
            <div className="grid grid-cols-7 border-b border-cream">
              {DAY_NAMES.map(d => (
                <div key={d} className="py-2 text-center text-xs font-medium text-walnut">
                  {d}
                </div>
              ))}
            </div>

            {/* Cells */}
            {calLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="w-6 h-6 border-2 border-terracotta border-t-transparent rounded-full animate-spin" />
              </div>
            ) : (
              <div className="grid grid-cols-7">
                {calendarCells.map((day, i) => {
                  if (!day) {
                    return <div key={`empty-${i}`} className="border-b border-r border-cream/60 min-h-[9rem]" />
                  }
                  const key = toDateKey(day)
                  const dayEvents = eventsByDate[key] ?? []
                  const isToday = key === todayKey
                  const isPast = day < today && !isToday

                  return (
                    <div
                      key={key}
                      className={`border-b border-r border-cream/60 min-h-[9rem] p-2 ${
                        isPast ? 'opacity-50' : ''
                      }`}
                    >
                      <span
                        className={`text-xs font-medium block mb-1.5 w-5 h-5 flex items-center justify-center rounded-full ${
                          isToday
                            ? 'bg-terracotta text-cream'
                            : 'text-walnut'
                        }`}
                      >
                        {day.getDate()}
                      </span>
                      <div className="space-y-1">
                        {dayEvents.slice(0, 3).map(evt => (
                          <CalEventPill key={evt.id} evt={evt} />
                        ))}
                        {dayEvents.length > 3 && (
                          <p className="text-[10px] text-walnut/60 pl-0.5">
                            +{dayEvents.length - 3} more
                          </p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </section>

        {/* ── Follow-Up Row ── */}
        <section>
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-lg font-semibold text-espresso">
              Needs Follow-Up
              {uniquePersonFlags.length > 0 && (
                <span className="ml-2 text-sm font-normal text-walnut">
                  ({uniquePersonFlags.length})
                </span>
              )}
            </h2>
            <Link
              href="/profiles"
              className="text-sm text-walnut hover:text-espresso transition-colors"
            >
              View all →
            </Link>
          </div>

          {/* Refresh button + result */}
          <div className="flex items-center gap-3 mb-3">
            <button
              onClick={refreshFollowUpFlags}
              disabled={refreshing}
              className="flex items-center gap-1.5 text-xs font-medium bg-parchment hover:bg-walnut/20 disabled:opacity-50 text-walnut px-3 py-1.5 rounded-full transition-colors"
            >
              {refreshing ? (
                <>
                  <div className="w-3 h-3 border border-walnut/60 border-t-transparent rounded-full animate-spin" />
                  Running rules…
                </>
              ) : (
                <>
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Refresh Follow-Up List
                </>
              )}
            </button>
            {refreshResult && (
              <span className="text-xs text-walnut">{refreshResult}</span>
            )}
          </div>

          {flagsLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-6 h-6 border-2 border-terracotta border-t-transparent rounded-full animate-spin" />
            </div>
          ) : uniquePersonFlags.length === 0 ? (
            <div className="bg-parchment rounded-2xl px-5 py-8 text-center">
              <p className="text-walnut text-sm">No unresolved follow-up flags.</p>
            </div>
          ) : (
            <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2">
              {uniquePersonFlags.map(flag => (
                <FollowUpCard
                  key={flag.id}
                  flag={flag}
                  marking={markingId === flag.id}
                  onMarkContacted={() => markContacted(flag.id)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: string
  sub: string
  accent?: boolean
}) {
  return (
    <div
      className={`rounded-2xl px-5 py-4 ${
        accent ? 'bg-espresso text-cream' : 'bg-parchment'
      }`}
    >
      <p className={`text-xs font-medium mb-1 ${accent ? 'text-cream/60' : 'text-walnut'}`}>
        {label}
      </p>
      <p
        className={`text-2xl font-bold leading-tight truncate ${
          accent ? 'text-cream' : 'text-espresso'
        }`}
      >
        {value}
      </p>
      {sub && (
        <p className={`text-xs mt-0.5 truncate ${accent ? 'text-cream/50' : 'text-walnut/60'}`}>
          {sub}
        </p>
      )}
    </div>
  )
}

function CalEventPill({ evt }: { evt: CalEvent }) {
  const tag = evt.series.tag as EventTag
  return (
    <Link
      href={`/check-in?event=${evt.id}`}
      className={`block rounded px-1.5 py-1 hover:brightness-95 transition-[filter] ${TAG_STYLES[tag] ?? TAG_STYLES.other}`}
    >
      <div className="flex items-start gap-1">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1 ${TAG_DOT[tag] ?? TAG_DOT.other}`} />
        <span className="text-[11px] font-medium leading-snug break-words">
          {evt.series.name}
          {evt.instructor_name && (
            <span className="opacity-60"> · {evt.instructor_name.split(' ')[0]}</span>
          )}
        </span>
      </div>
    </Link>
  )
}

function FollowUpCard({
  flag,
  marking,
  onMarkContacted,
}: {
  flag: FlagWithPerson
  marking: boolean
  onMarkContacted: () => void
}) {
  const { person } = flag
  return (
    <div className="shrink-0 w-52 bg-parchment rounded-2xl p-4 flex flex-col gap-3">
      <div className="flex-1">
        <div className="flex items-start justify-between gap-2 mb-1">
          <p className="text-sm font-semibold text-espresso leading-tight">{person.name}</p>
          <span
            className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
              person.is_active ? 'bg-gold/40 text-espresso' : 'bg-walnut/20 text-walnut'
            }`}
          >
            {person.is_active ? 'Active' : 'Inactive'}
          </span>
        </div>
        {person.last_seen_at && (
          <p className="text-xs text-walnut/60 mb-2">
            Last seen{' '}
            {new Date(person.last_seen_at).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            })}
          </p>
        )}
        {flag.reason && (
          <p className="text-xs text-walnut leading-snug line-clamp-2">{flag.reason}</p>
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={onMarkContacted}
          disabled={marking}
          className="flex-1 bg-terracotta hover:bg-rust disabled:opacity-50 text-cream text-xs font-semibold py-2 rounded-xl transition-colors"
        >
          {marking ? '…' : 'Mark Contacted'}
        </button>
        <Link
          href="/profiles"
          className="flex items-center justify-center bg-cream hover:bg-parchment text-walnut px-2.5 py-2 rounded-xl transition-colors"
          aria-label="View profile"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>
      </div>
    </div>
  )
}
