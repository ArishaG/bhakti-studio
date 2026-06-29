'use client'

import { Suspense, useState, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

// ─── Types ────────────────────────────────────────────────────────────────────

type EventTag = 'soulfest' | 'outreach' | 'classes' | 'other'
type AttendanceSource = 'eventbrite' | 'arketa' | 'manual'

type EventWithSeries = {
  id: string
  date: string
  series_id: string
  instructor_name: string | null
  series: { name: string; tag: EventTag }
}

type SeriesGroup = {
  id: string
  name: string
  tag: EventTag
  events: EventWithSeries[]
}

type AttendeeRecord = {
  id: string
  person_id: string
  source: AttendanceSource
  checked_in: boolean
  paid: boolean | null
  ticket_type: string | null
  person: {
    id: string
    name: string
    email: string | null
    phone: string | null
    event_count: number
  }
}

type PersonRecord = {
  id: string
  name: string
  email: string | null
  phone: string | null
  event_count: number
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TAG_STYLES: Record<EventTag, string> = {
  soulfest: 'bg-gold/30 text-espresso',
  outreach: 'bg-terracotta text-cream',
  classes: 'bg-walnut text-cream',
  other: 'bg-parchment text-walnut',
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function CheckInPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-cream pt-16" />}>
      <CheckInPageInner />
    </Suspense>
  )
}

function CheckInPageInner() {
  const supabase = createClient()
  const searchParams = useSearchParams()

  const [view, setView] = useState<'events' | 'attendees'>('events')
  const [events, setEvents] = useState<EventWithSeries[]>([])
  const [selectedEvent, setSelectedEvent] = useState<EventWithSeries | null>(null)
  const [attendees, setAttendees] = useState<AttendeeRecord[]>([])
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set())
  const [reminder, setReminder] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [search, setSearch] = useState('')
  const [eventSearch, setEventSearch] = useState('')
  const [sourceFilter, setSourceFilter] = useState<'all' | 'eventbrite' | 'arketa'>('all')
  const [globalMatches, setGlobalMatches] = useState<PersonRecord[]>([])
  const [searchingGlobal, setSearchingGlobal] = useState(false)
  const [quickAddingIds, setQuickAddingIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [showAddModal, setShowAddModal] = useState(false)
  const [expandedSeries, setExpandedSeries] = useState<Set<string>>(new Set())
  const deepLinkHandled = useRef(false)
  const globalSearchSeq = useRef(0)

  useEffect(() => {
    loadEvents()
  }, [])

  // Deep link from the dashboard calendar: ?event=<id> jumps straight to that
  // event's attendee view once the full event list has loaded.
  useEffect(() => {
    if (deepLinkHandled.current || events.length === 0) return
    const eventId = searchParams.get('event')
    if (!eventId) return
    const found = events.find(e => e.id === eventId)
    if (found) {
      deepLinkHandled.current = true
      selectEvent(found)
    }
  }, [events, searchParams])

  async function loadEvents() {
    setLoading(true)
    const { data } = await supabase
      .from('event_instances')
      .select('*, series:event_series(name, tag)')
      .order('date', { ascending: false })

    setEvents((data as EventWithSeries[]) ?? [])
    setLoading(false)
  }

  function toggleSeries(seriesId: string) {
    setExpandedSeries(prev => {
      const next = new Set(prev)
      next.has(seriesId) ? next.delete(seriesId) : next.add(seriesId)
      return next
    })
  }

  const todayEvents = useMemo(() => {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    end.setDate(end.getDate() + 1)
    return events
      .filter(e => {
        const d = new Date(e.date)
        return d >= start && d < end
      })
      .sort((a, b) => a.date.localeCompare(b.date))
  }, [events])

  const seriesGroups = useMemo<SeriesGroup[]>(() => {
    const map = new Map<string, SeriesGroup>()
    for (const e of events) {
      if (!map.has(e.series_id)) {
        map.set(e.series_id, { id: e.series_id, name: e.series.name, tag: e.series.tag, events: [] })
      }
      map.get(e.series_id)!.events.push(e)
    }
    return [...map.values()].sort((a, b) => b.events.length - a.events.length)
  }, [events])

  const matchedEvents = useMemo(() => {
    const q = eventSearch.trim().toLowerCase()
    if (!q) return null
    return events.filter(
      e =>
        e.series.name.toLowerCase().includes(q) ||
        e.instructor_name?.toLowerCase().includes(q) ||
        e.series.tag.toLowerCase().includes(q)
    )
  }, [events, eventSearch])

  async function loadAttendees(event: EventWithSeries) {
    setLoading(true)
    const { data } = await supabase
      .from('attendances')
      .select('*, person:people(id, name, email, phone, event_count)')
      .eq('event_instance_id', event.id)

    const records = ((data as AttendeeRecord[]) ?? []).sort((a, b) =>
      a.person.name.localeCompare(b.person.name)
    )
    setAttendees(records)
    setLoading(false)
  }

  function selectEvent(event: EventWithSeries) {
    setSelectedEvent(event)
    setSearch('')
    setSourceFilter('all')
    setGlobalMatches([])
    setView('attendees')
    loadAttendees(event)
  }

  // Beyond filtering the already-registered attendees below, also looks up
  // matches across every Bhakti Studio person record so someone who isn't
  // registered for this event can still be found and added on the spot.
  // Debounced so it doesn't fire a query on every keystroke, and guarded by
  // a sequence number so a slow, stale response can't overwrite a newer one.
  useEffect(() => {
    const q = search.trim()
    if (!q || !selectedEvent) {
      setGlobalMatches([])
      setSearchingGlobal(false)
      return
    }

    const seq = ++globalSearchSeq.current
    setSearchingGlobal(true)
    const timer = setTimeout(async () => {
      // Two separate ilike queries rather than a single .or(...) — values
      // with commas/parens (e.g. "Smith, John") would otherwise be parsed
      // as PostgREST filter syntax instead of literal search text.
      const escaped = q.replace(/[%_\\]/g, m => `\\${m}`)
      const cols = 'id, name, email, phone, event_count'
      const [byName, byEmail] = await Promise.all([
        supabase.from('people').select(cols).ilike('name', `%${escaped}%`).limit(8),
        supabase.from('people').select(cols).ilike('email', `%${escaped}%`).limit(8),
      ])

      if (seq !== globalSearchSeq.current) return

      const registeredIds = new Set(attendees.map(a => a.person_id))
      const merged = new Map<string, PersonRecord>()
      for (const p of [...(byName.data ?? []), ...(byEmail.data ?? [])] as PersonRecord[]) {
        if (!registeredIds.has(p.id)) merged.set(p.id, p)
      }
      setGlobalMatches([...merged.values()].slice(0, 8))
      setSearchingGlobal(false)
    }, 300)

    return () => clearTimeout(timer)
  }, [search, selectedEvent, attendees])

  async function refreshFromSources() {
    if (!selectedEvent) return
    setRefreshing(true)
    const body = JSON.stringify({ eventInstanceId: selectedEvent.id })
    await Promise.all([
      fetch('/api/sync/arketa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).catch(() => null),
      fetch('/api/sync/eventbrite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).catch(() => null),
    ])
    await loadAttendees(selectedEvent)
    setRefreshing(false)
  }

  // Toggle check-in state for a pre-registered attendee. Eventbrite
  // attendees push both checking in and un-checking via the
  // eventbrite-checkin-bot service, since it can click either "Check in" or
  // "Undo check-in" on the row. Arketa attendees only push on check-in —
  // un-checking on Arketa has no documented endpoint and stays local-only.
  // Both pushes are best-effort — a reminder shows only if the push failed.
  async function handleToggleCheckIn(attendee: AttendeeRecord, checkedIn: boolean) {
    setTogglingIds(prev => new Set([...prev, attendee.id]))
    setAttendees(prev =>
      prev.map(a => (a.id === attendee.id ? { ...a, checked_in: checkedIn } : a))
    )

    try {
      const res = await fetch('/api/checkin/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attendanceId: attendee.id, checkedIn }),
      })
      if (!res.ok) {
        // The request itself failed (expired session, server error, etc.) —
        // nothing was saved, not even locally, so the optimistic update above
        // is wrong and needs to be undone, and this needs its own message
        // since it's a different failure than a sync push not landing.
        setAttendees(prev =>
          prev.map(a => (a.id === attendee.id ? { ...a, checked_in: !checkedIn } : a))
        )
        setReminder(`Couldn't save ${checkedIn ? 'check-in' : 'uncheck'} for ${attendee.person.name} — try again`)
        setTimeout(() => setReminder(null), 6000)
        return
      }

      const result = await res.json()
      if (attendee.source === 'eventbrite' && !result.eventbritePushed) {
        const action = checkedIn ? 'check them in' : 'undo their check-in'
        setReminder(`${checkedIn ? 'Checked in' : 'Unchecked'} locally, but couldn't sync to Eventbrite for ${attendee.person.name} — ${action} there manually`)
        setTimeout(() => setReminder(null), 6000)
      } else if (attendee.source === 'arketa' && checkedIn && !result.arketaPushed) {
        setReminder(`Checked in locally, but couldn't sync to Arketa for ${attendee.person.name}`)
        setTimeout(() => setReminder(null), 6000)
      }
    } catch {
      // Network failure — same situation as a non-ok response: nothing was
      // saved, so revert the optimistic update and surface it.
      setAttendees(prev =>
        prev.map(a => (a.id === attendee.id ? { ...a, checked_in: !checkedIn } : a))
      )
      setReminder(`Couldn't save ${checkedIn ? 'check-in' : 'uncheck'} for ${attendee.person.name} — check your connection and try again`)
      setTimeout(() => setReminder(null), 6000)
    } finally {
      setTogglingIds(prev => {
        const next = new Set(prev)
        next.delete(attendee.id)
        return next
      })
    }
  }

  // Add a walk-in not on any pre-registered list
  async function handleAddPerson(
    name: string,
    email: string,
    phone: string
  ): Promise<{ isDuplicate: boolean }> {
    if (!selectedEvent) return { isDuplicate: false }

    if (email) {
      const { data: existing } = await supabase
        .from('people')
        .select('id, event_count')
        .eq('email', email)
        .maybeSingle()

      if (existing) {
        const { data: existingAttendance } = await supabase
          .from('attendances')
          .select('id, source')
          .eq('person_id', existing.id)
          .eq('event_instance_id', selectedEvent.id)
          .maybeSingle()

        if (existingAttendance) {
          // Different source already on record — create a new person + flag
          const { data: newPerson } = await supabase
            .from('people')
            .insert({ name, email, phone: phone || null })
            .select('id')
            .single()

          if (newPerson) {
            await supabase.from('attendances').insert({
              person_id: newPerson.id,
              event_instance_id: selectedEvent.id,
              source: 'manual',
              checked_in: true,
            })
            await supabase.from('duplicate_flags').insert({
              person_id_a: existing.id,
              person_id_b: newPerson.id,
            })
          }
          await loadAttendees(selectedEvent)
          return { isDuplicate: true }
        }

        // Existing person, no attendance yet — just check them in
        await supabase.from('attendances').insert({
          person_id: existing.id,
          event_instance_id: selectedEvent.id,
          source: 'manual',
          checked_in: true,
        })
        // Trigger handles event_count + last_seen_at; we handle is_active
        const newCount = (existing.event_count ?? 0) + 1
        if (newCount >= 3) {
          await supabase
            .from('people')
            .update({ is_active: true })
            .eq('id', existing.id)
        }
        await loadAttendees(selectedEvent)
        return { isDuplicate: false }
      }
    }

    // Brand-new person
    const { data: newPerson } = await supabase
      .from('people')
      .insert({ name, email: email || null, phone: phone || null })
      .select('id')
      .single()

    if (newPerson) {
      await supabase.from('attendances').insert({
        person_id: newPerson.id,
        event_instance_id: selectedEvent.id,
        source: 'manual',
        checked_in: true,
      })
      // Trigger fires and sets event_count=1, so no is_active check needed yet
    }

    await loadAttendees(selectedEvent)
    return { isDuplicate: false }
  }

  // Adds an existing Bhakti Studio person (found via the global search
  // below) to this event. They weren't registered through any source, so
  // checking them in here is the only record of their attendance.
  async function handleQuickAdd(person: PersonRecord) {
    if (!selectedEvent) return
    setQuickAddingIds(prev => new Set([...prev, person.id]))

    const { error } = await supabase.from('attendances').insert({
      person_id: person.id,
      event_instance_id: selectedEvent.id,
      source: 'manual',
      checked_in: true,
    })

    if (error) {
      setReminder(`Couldn't add ${person.name} — try again`)
      setTimeout(() => setReminder(null), 6000)
      setQuickAddingIds(prev => {
        const next = new Set(prev)
        next.delete(person.id)
        return next
      })
      return
    }

    // Trigger handles event_count + last_seen_at; we handle is_active
    const newCount = (person.event_count ?? 0) + 1
    if (newCount >= 3) {
      await supabase.from('people').update({ is_active: true }).eq('id', person.id)
    }

    setGlobalMatches(prev => prev.filter(p => p.id !== person.id))
    await loadAttendees(selectedEvent)
    setQuickAddingIds(prev => {
      const next = new Set(prev)
      next.delete(person.id)
      return next
    })
  }

  const filtered = useMemo(() => {
    let list = attendees
    if (sourceFilter !== 'all') list = list.filter(a => a.source === sourceFilter)
    if (!search.trim()) return list
    const q = search.toLowerCase()
    return list.filter(
      a =>
        a.person?.name?.toLowerCase().includes(q) ||
        a.person?.email?.toLowerCase().includes(q)
    )
  }, [attendees, search, sourceFilter])

  // ─── Event List View ──────────────────────────────────────────────────────

  if (view === 'events') {
    return (
      <div className="min-h-screen bg-cream pt-16">
        <div className="max-w-2xl mx-auto px-4 pt-6 pb-4">
          <h1 className="text-2xl font-bold text-espresso">Check-In</h1>
          <p className="text-walnut text-sm mt-1">
            {new Date().toLocaleDateString('en-US', {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
            })}
          </p>
          <input
            type="search"
            value={eventSearch}
            onChange={e => setEventSearch(e.target.value)}
            placeholder="Search events by name or instructor…"
            className="w-full mt-4 px-4 py-3 rounded-xl bg-parchment border border-parchment text-espresso placeholder-walnut/50 focus:outline-none focus:ring-2 focus:ring-terracotta text-base"
          />
        </div>

        {loading ? (
          <Spinner />
        ) : events.length === 0 ? (
          <div className="px-4 py-16 text-center">
            <p className="text-walnut text-lg">No events found.</p>
          </div>
        ) : matchedEvents ? (
          <div className="max-w-2xl mx-auto px-4 pb-10">
            {matchedEvents.length === 0 ? (
              <p className="text-walnut text-sm bg-parchment rounded-2xl px-4 py-4">
                No events match &ldquo;{eventSearch.trim()}&rdquo;.
              </p>
            ) : (
              <ul className="space-y-3">
                {matchedEvents.map(event => (
                  <li key={event.id}>
                    <EventCard event={event} onClick={() => selectEvent(event)} showDate />
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="max-w-2xl mx-auto px-4 pb-10 space-y-8">
            {/* Today */}
            <section>
              <h2 className="text-base font-semibold text-espresso mb-3">
                Today {todayEvents.length > 0 && <span className="font-normal text-walnut">({todayEvents.length})</span>}
              </h2>
              {todayEvents.length === 0 ? (
                <p className="text-walnut text-sm bg-parchment rounded-2xl px-4 py-4">
                  No events scheduled for today.
                </p>
              ) : (
                <ul className="space-y-3">
                  {todayEvents.map(event => (
                    <li key={event.id}>
                      <EventCard event={event} onClick={() => selectEvent(event)} />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* All events, grouped by series */}
            <section>
              <h2 className="text-base font-semibold text-espresso mb-3">All Events</h2>
              <ul className="space-y-2">
                {seriesGroups.map(group => {
                  const isOpen = expandedSeries.has(group.id)
                  return (
                    <li key={group.id} className="bg-parchment rounded-2xl overflow-hidden">
                      <button
                        onClick={() => toggleSeries(group.id)}
                        className="w-full flex items-center justify-between gap-3 px-4 py-3.5 text-left"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <svg
                            className={`w-4 h-4 text-walnut shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                          <span className="font-semibold text-espresso truncate">{group.name}</span>
                          <span
                            className={`shrink-0 text-xs font-semibold px-2.5 py-0.5 rounded-full capitalize ${
                              TAG_STYLES[group.tag] ?? TAG_STYLES.other
                            }`}
                          >
                            {group.tag}
                          </span>
                        </div>
                        <span className="shrink-0 text-sm text-walnut">{group.events.length}</span>
                      </button>
                      {isOpen && (
                        <ul className="px-3 pb-3 space-y-2">
                          {group.events.map(event => (
                            <li key={event.id}>
                              <EventCard event={event} onClick={() => selectEvent(event)} compact />
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          </div>
        )}
      </div>
    )
  }

  // ─── Attendees View ───────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-cream flex flex-col pt-16">
      {/* Sticky header + search */}
      <div className="sticky top-16 z-10 bg-cream border-b border-parchment px-4 pt-4 pb-3">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center gap-3 mb-3">
            <button
              onClick={() => setView('events')}
              className="p-1 -ml-1 text-walnut hover:text-espresso transition-colors"
              aria-label="Back to events"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-bold text-espresso truncate">
                {selectedEvent?.series.name}
              </h2>
              <p className="text-walnut text-xs">
                {selectedEvent &&
                  new Date(selectedEvent.date).toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                {' · '}
                {attendees.length} registered · {attendees.filter(a => a.checked_in).length} checked in
              </p>
            </div>
            <button
              onClick={refreshFromSources}
              disabled={refreshing}
              className="shrink-0 p-2 text-walnut hover:text-espresso disabled:opacity-50 transition-colors"
              aria-label="Refresh from Arketa/Eventbrite"
            >
              <svg
                className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search registered attendees or all records…"
            className="w-full px-4 py-3 rounded-xl bg-parchment border border-parchment text-espresso placeholder-walnut/50 focus:outline-none focus:ring-2 focus:ring-terracotta text-base"
          />
          <div className="flex gap-2 mt-3">
            {(['all', 'eventbrite', 'arketa'] as const).map(opt => (
              <button
                key={opt}
                onClick={() => setSourceFilter(opt)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold capitalize transition-colors ${
                  sourceFilter === opt
                    ? 'bg-terracotta text-cream'
                    : 'bg-parchment text-walnut hover:text-espresso'
                }`}
              >
                {opt === 'all' ? 'All sources' : opt}
              </button>
            ))}
          </div>
        </div>
      </div>

      {reminder && (
        <div className="sticky top-[10rem] z-10 max-w-2xl mx-auto w-full px-4">
          <div className="bg-gold/30 text-espresso text-sm font-medium rounded-xl px-4 py-2.5 mt-2 shadow">
            {reminder}
          </div>
        </div>
      )}

      {/* Attendee list */}
      <div className="flex-1 px-4 pt-3 pb-28 overflow-y-auto">
        <div className="max-w-2xl mx-auto space-y-6">
        {loading ? (
          <Spinner />
        ) : (
          <>
            {/* Registered attendees always come first */}
            {filtered.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-walnut">
                  {search ? 'No registered attendees match.' : 'No attendees yet.'}
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {filtered.map(attendee => {
                  const isIn = attendee.checked_in
                  const isToggling = togglingIds.has(attendee.id)
                  return (
                    <li
                      key={attendee.id}
                      className={`flex items-center gap-3 rounded-2xl p-4 transition-colors ${
                        isIn ? 'bg-gold/20' : 'bg-parchment'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-lg font-semibold text-espresso leading-tight truncate">
                          {attendee.person?.name}
                        </p>
                        {attendee.person?.email && (
                          <p className="text-sm text-walnut truncate mt-0.5">
                            {attendee.person.email}
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-walnut/50 capitalize">
                            {attendee.source}
                          </span>
                          {attendee.paid !== null && (
                            <span
                              className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                                attendee.paid
                                  ? 'bg-gold/30 text-espresso'
                                  : 'bg-terracotta/15 text-terracotta'
                              }`}
                            >
                              {attendee.paid ? 'Paid' : 'Unpaid'}
                            </span>
                          )}
                          {attendee.ticket_type && (
                            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-walnut/10 text-walnut">
                              {attendee.ticket_type}
                            </span>
                          )}
                        </div>
                      </div>
                      {isIn ? (
                        <button
                          onClick={() => handleToggleCheckIn(attendee, false)}
                          disabled={isToggling}
                          className="flex items-center gap-1.5 bg-gold/30 hover:bg-gold/50 disabled:opacity-50 text-espresso text-sm font-semibold px-4 py-2.5 rounded-xl shrink-0 transition-colors"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                          </svg>
                          In
                        </button>
                      ) : (
                        <button
                          onClick={() => handleToggleCheckIn(attendee, true)}
                          disabled={isToggling}
                          className="shrink-0 bg-terracotta hover:bg-rust active:scale-95 disabled:opacity-50 text-cream text-sm font-semibold px-5 py-2.5 rounded-xl transition-transform"
                        >
                          Check In
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}

            {/* People not registered for this event, found across all Bhakti
                Studio records — added on top so they show up second, after
                anyone who actually registered. */}
            {search.trim() && (
              <div>
                <h3 className="text-sm font-semibold text-walnut mb-2">
                  Add from Bhakti Studio records
                </h3>
                {searchingGlobal ? (
                  <p className="text-walnut text-sm px-1">Searching…</p>
                ) : globalMatches.length === 0 ? (
                  <p className="text-walnut text-sm px-1">No other matching records.</p>
                ) : (
                  <ul className="space-y-2">
                    {globalMatches.map(person => {
                      const isAdding = quickAddingIds.has(person.id)
                      return (
                        <li
                          key={person.id}
                          className="flex items-center gap-3 rounded-2xl p-4 bg-cream border border-parchment"
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-lg font-semibold text-espresso leading-tight truncate">
                              {person.name}
                            </p>
                            {person.email && (
                              <p className="text-sm text-walnut truncate mt-0.5">{person.email}</p>
                            )}
                            <p className="text-xs text-walnut/50 mt-0.5">Not registered for this event</p>
                          </div>
                          <button
                            onClick={() => handleQuickAdd(person)}
                            disabled={isAdding}
                            className="shrink-0 bg-terracotta hover:bg-rust active:scale-95 disabled:opacity-50 text-cream text-sm font-semibold px-4 py-2.5 rounded-xl transition-transform"
                          >
                            {isAdding ? 'Adding…' : 'Add & Check In'}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
        </div>
      </div>

      {/* Floating add button */}
      <div className="fixed bottom-6 right-4 z-20">
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 bg-terracotta hover:bg-rust active:scale-95 text-cream font-semibold px-5 py-3.5 rounded-2xl shadow-lg transition-transform text-base"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Person
        </button>
      </div>

      {showAddModal && (
        <AddPersonModal
          onClose={() => setShowAddModal(false)}
          onAdd={handleAddPerson}
        />
      )}
    </div>
  )
}

// ─── Add Person Modal ─────────────────────────────────────────────────────────

function AddPersonModal({
  onClose,
  onAdd,
}: {
  onClose: () => void
  onAdd: (name: string, email: string, phone: string) => Promise<{ isDuplicate: boolean }>
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [loading, setLoading] = useState(false)
  const [isDuplicate, setIsDuplicate] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setLoading(true)
    const result = await onAdd(name.trim(), email.trim(), phone.trim())
    setLoading(false)
    if (result.isDuplicate) {
      setIsDuplicate(true)
    } else {
      onClose()
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end sm:items-center justify-center bg-espresso/60">
      <div className="w-full sm:max-w-md bg-cream rounded-t-3xl sm:rounded-3xl px-6 pt-6 pb-8 shadow-2xl">
        {isDuplicate ? (
          <div className="text-center py-4">
            <div className="w-14 h-14 rounded-full bg-gold/30 flex items-center justify-center mx-auto mb-4">
              <svg className="w-7 h-7 text-walnut" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h3 className="text-xl font-bold text-espresso mb-2">Possible Duplicate</h3>
            <p className="text-walnut text-sm leading-relaxed mb-6">
              This email is already registered for this event from a different source.
              The person was checked in and a flag was created for admin review.
            </p>
            <button
              onClick={onClose}
              className="w-full bg-terracotta text-cream font-semibold py-4 rounded-xl text-base"
            >
              OK, Got It
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold text-espresso">Add Person</h3>
              <button
                onClick={onClose}
                className="text-walnut hover:text-espresso p-1 transition-colors"
                aria-label="Close"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <Field label="Name" required>
                <input
                  ref={nameRef}
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  required
                  placeholder="Full name"
                  className={inputCls}
                />
              </Field>

              <Field label="Email" hint="optional">
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="email@example.com"
                  className={inputCls}
                />
              </Field>

              <Field label="Phone" hint="optional">
                <input
                  type="tel"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  placeholder="+1 (555) 000-0000"
                  className={inputCls}
                />
              </Field>

              <button
                type="submit"
                disabled={loading || !name.trim()}
                className="w-full mt-2 bg-terracotta hover:bg-rust disabled:opacity-50 text-cream font-semibold py-4 rounded-xl text-base transition-colors"
              >
                {loading ? 'Checking in…' : 'Add & Check In'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

const inputCls =
  'w-full px-4 py-3.5 rounded-xl bg-parchment border border-parchment text-espresso placeholder-walnut/50 focus:outline-none focus:ring-2 focus:ring-terracotta text-base'

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string
  hint?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-espresso mb-1.5">
        {label}{' '}
        {required ? (
          <span className="text-terracotta">*</span>
        ) : (
          <span className="text-walnut font-normal">({hint})</span>
        )}
      </label>
      {children}
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

function EventCard({
  event,
  onClick,
  compact,
  showDate,
}: {
  event: EventWithSeries
  onClick: () => void
  compact?: boolean
  showDate?: boolean
}) {
  const dateLabel = new Date(event.date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
  const timeLabel = new Date(event.date).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-2xl shadow-sm active:scale-[0.98] transition-transform ${
        compact ? 'bg-cream p-4' : 'bg-parchment p-5'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {!compact && (
            <h2 className="text-xl font-semibold text-espresso">{event.series.name}</h2>
          )}
          {event.instructor_name && (
            <p className="text-walnut text-sm mt-0.5">with {event.instructor_name}</p>
          )}
          <p className="text-walnut text-sm mt-1">
            {compact || showDate ? `${dateLabel} · ${timeLabel}` : timeLabel}
          </p>
        </div>
        {!compact && (
          <span
            className={`shrink-0 text-xs font-semibold px-3 py-1 rounded-full capitalize ${
              TAG_STYLES[event.series.tag] ?? TAG_STYLES.other
            }`}
          >
            {event.series.tag}
          </span>
        )}
      </div>
    </button>
  )
}
