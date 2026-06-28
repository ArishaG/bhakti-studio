'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'

// ─── Types ────────────────────────────────────────────────────────────────────

type SoulfestInstance = {
  id: string
  date: string
  series: { name: string }
}

type InstanceStat = SoulfestInstance & {
  totalCheckedIn: number
  reviewed: number
}

type AttendanceRow = {
  id: string
  person_id: string
  checked_in_at: string
  person: {
    id: string
    name: string
    email: string | null
    event_count: number
    last_seen_at: string | null
  } | null
}

type Assessment = {
  id: string
  person_id: string
  event_instance_id: string
  rating: number | null
  notes: string | null
  follow_up_flag_id: string | null
  created_at: string
  updated_at: string
  event_instances: { date: string; event_series: { name: string } } | null
}

type QueuePerson = {
  personId: string
  name: string
  email: string | null
  eventCount: number
  lastSeenAt: string | null
  isNew: boolean
  pastAssessments: Assessment[]
  currentAssessment: Assessment | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ReviewPage() {
  const supabase = createClient()

  const [view, setView] = useState<'pick' | 'swipe'>('pick')
  const [instances, setInstances] = useState<InstanceStat[]>([])
  const [loadingInstances, setLoadingInstances] = useState(true)
  const [pickError, setPickError] = useState('')

  const [selectedInstance, setSelectedInstance] = useState<InstanceStat | null>(null)
  const [queue, setQueue] = useState<QueuePerson[]>([])
  const [loadingQueue, setLoadingQueue] = useState(false)
  const [index, setIndex] = useState(0)
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    loadInstances()
  }, [])

  async function loadInstances() {
    setLoadingInstances(true)
    setPickError('')

    const { data: rawInstances, error } = await supabase
      .from('event_instances')
      .select('id, date, series:event_series!inner(name, tag)')
      .eq('series.tag', 'soulfest')
      .order('date', { ascending: false })

    if (error) {
      setPickError('Could not load Soulfests.')
      setLoadingInstances(false)
      return
    }

    const list = (rawInstances as unknown as SoulfestInstance[]) ?? []
    const ids = list.map(i => i.id)

    if (ids.length === 0) {
      setInstances([])
      setLoadingInstances(false)
      return
    }

    const [{ data: attendances }, { data: assessments }] = await Promise.all([
      supabase
        .from('attendances')
        .select('event_instance_id')
        .eq('checked_in', true)
        .in('event_instance_id', ids),
      supabase.from('member_assessments').select('event_instance_id').in('event_instance_id', ids),
    ])

    const totalByInstance = new Map<string, number>()
    for (const a of attendances ?? []) {
      totalByInstance.set(a.event_instance_id, (totalByInstance.get(a.event_instance_id) ?? 0) + 1)
    }
    const reviewedByInstance = new Map<string, number>()
    for (const a of assessments ?? []) {
      reviewedByInstance.set(a.event_instance_id, (reviewedByInstance.get(a.event_instance_id) ?? 0) + 1)
    }

    setInstances(
      list.map(i => ({
        ...i,
        totalCheckedIn: totalByInstance.get(i.id) ?? 0,
        reviewed: reviewedByInstance.get(i.id) ?? 0,
      }))
    )
    setLoadingInstances(false)
  }

  async function openInstance(instance: InstanceStat) {
    setSelectedInstance(instance)
    setView('swipe')
    setSaveError('')
    setLoadingQueue(true)

    const { data: attendances } = await supabase
      .from('attendances')
      .select('id, person_id, checked_in_at, person:people(id, name, email, event_count, last_seen_at)')
      .eq('event_instance_id', instance.id)
      .eq('checked_in', true)

    const rows = ((attendances as unknown as AttendanceRow[]) ?? []).filter(r => r.person)
    const personIds = rows.map(r => r.person_id)

    if (personIds.length === 0) {
      setQueue([])
      setIndex(0)
      setLoadingQueue(false)
      return
    }

    const [{ data: allAttendances }, { data: allAssessments }] = await Promise.all([
      supabase.from('attendances').select('person_id, checked_in_at').in('person_id', personIds),
      supabase
        .from('member_assessments')
        .select('*, event_instances(date, event_series(name))')
        .in('person_id', personIds),
    ])

    const earliestByPerson = new Map<string, string>()
    for (const a of allAttendances ?? []) {
      const prev = earliestByPerson.get(a.person_id)
      if (!prev || a.checked_in_at < prev) earliestByPerson.set(a.person_id, a.checked_in_at)
    }

    const assessmentsByPerson = new Map<string, Assessment[]>()
    for (const a of (allAssessments as unknown as Assessment[]) ?? []) {
      if (!assessmentsByPerson.has(a.person_id)) assessmentsByPerson.set(a.person_id, [])
      assessmentsByPerson.get(a.person_id)!.push(a)
    }

    const built: QueuePerson[] = rows.map(r => {
      const all = (assessmentsByPerson.get(r.person_id) ?? []).sort((a, b) =>
        (b.event_instances?.date ?? '').localeCompare(a.event_instances?.date ?? '')
      )
      return {
        personId: r.person_id,
        name: r.person!.name,
        email: r.person!.email,
        eventCount: r.person!.event_count,
        lastSeenAt: r.person!.last_seen_at,
        isNew: earliestByPerson.get(r.person_id) === r.checked_in_at,
        pastAssessments: all.filter(a => a.event_instance_id !== instance.id),
        currentAssessment: all.find(a => a.event_instance_id === instance.id) ?? null,
      }
    })

    built.sort((a, b) => {
      if (a.isNew !== b.isNew) return a.isNew ? -1 : 1
      if (b.eventCount !== a.eventCount) return b.eventCount - a.eventCount
      return a.name.localeCompare(b.name)
    })

    setQueue(built)
    setIndex(0)
    setLoadingQueue(false)
  }

  async function commitCard(
    personIndex: number,
    rating: number | null,
    notes: string,
    flagged: boolean
  ) {
    const person = queue[personIndex]
    if (!selectedInstance || !person) return

    const hasContent = rating !== null || notes.trim().length > 0 || flagged
    if (!hasContent && !person.currentAssessment) return

    try {
      let followUpFlagId = person.currentAssessment?.follow_up_flag_id ?? null
      if (flagged && !followUpFlagId) {
        const { data: flag, error: flagErr } = await supabase
          .from('follow_up_flags')
          .insert({
            person_id: person.personId,
            reason: `Soulfest review: rated ${rating ?? 'n/a'}/5 at ${selectedInstance.series.name} (${formatDate(selectedInstance.date)})`,
          })
          .select('id')
          .single()
        if (!flagErr) followUpFlagId = flag?.id ?? null
      }

      const { data: saved, error: saveErr } = await supabase
        .from('member_assessments')
        .upsert(
          {
            person_id: person.personId,
            event_instance_id: selectedInstance.id,
            rating,
            notes: notes.trim() || null,
            follow_up_flag_id: followUpFlagId,
          },
          { onConflict: 'person_id,event_instance_id' }
        )
        .select('*, event_instances(date, event_series(name))')
        .single()

      if (saveErr) throw saveErr

      if (saved) {
        setQueue(prev =>
          prev.map((p, i) => (i === personIndex ? { ...p, currentAssessment: saved as Assessment } : p))
        )
      }
      setInstances(prev =>
        prev.map(i =>
          i.id === selectedInstance.id && !person.currentAssessment
            ? { ...i, reviewed: i.reviewed + 1 }
            : i
        )
      )
    } catch {
      setSaveError(`Couldn't save ${person.name}'s review — go back to their card and try again.`)
      setTimeout(() => setSaveError(''), 5000)
    }
  }

  function backToPicker() {
    setView('pick')
    setSelectedInstance(null)
    setQueue([])
    loadInstances()
  }

  // ─── Picker View ────────────────────────────────────────────────────────────

  if (view === 'pick') {
    return (
      <div className="min-h-screen bg-cream pt-16">
        <div className="max-w-2xl mx-auto px-4 pt-6 pb-16">
          <h1 className="text-2xl font-bold text-espresso mb-1">Review</h1>
          <p className="text-walnut text-sm mb-5">
            Swipe through Soulfest attendees to rate and note how the gathering went for each person.
          </p>

          {loadingInstances ? (
            <Spinner />
          ) : pickError ? (
            <p className="text-terracotta text-sm py-8 text-center">{pickError}</p>
          ) : instances.length === 0 ? (
            <p className="text-walnut text-sm py-8 text-center">No Soulfest events found yet.</p>
          ) : (
            <ul className="space-y-3">
              {instances.map(instance => (
                <li key={instance.id}>
                  <button
                    onClick={() => openInstance(instance)}
                    className="w-full text-left bg-parchment rounded-2xl p-5 shadow-sm active:scale-[0.99] transition-transform flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <h3 className="text-lg font-semibold text-espresso leading-tight truncate">
                        {instance.series.name}
                      </h3>
                      <p className="text-sm text-walnut mt-0.5">{formatDate(instance.date)}</p>
                    </div>
                    <span
                      className={`shrink-0 text-xs font-semibold px-3 py-1.5 rounded-full ${
                        instance.totalCheckedIn > 0 && instance.reviewed >= instance.totalCheckedIn
                          ? 'bg-gold/40 text-espresso'
                          : 'bg-cream text-walnut'
                      }`}
                    >
                      {instance.reviewed} / {instance.totalCheckedIn} reviewed
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    )
  }

  // ─── Swipe View ─────────────────────────────────────────────────────────────

  const newCount = queue.filter(p => p.isNew).length
  const recurringCount = queue.length - newCount
  const current = queue[index] ?? null
  const done = !loadingQueue && queue.length > 0 && index >= queue.length

  return (
    <div className="min-h-screen bg-cream flex flex-col pt-16">
      <div className="sticky top-16 z-10 bg-cream border-b border-parchment px-4 pt-4 pb-3">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <button
            onClick={backToPicker}
            className="p-1 -ml-1 text-walnut hover:text-espresso transition-colors"
            aria-label="Back to Soulfests"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-bold text-espresso truncate">{selectedInstance?.series.name}</h2>
            <p className="text-walnut text-xs">
              {selectedInstance && formatDate(selectedInstance.date)}
              {!loadingQueue && queue.length > 0 && (
                <>
                  {' · '}
                  {newCount} new · {recurringCount} recurring
                </>
              )}
            </p>
          </div>
          {!loadingQueue && queue.length > 0 && !done && (
            <span className="shrink-0 text-sm text-walnut">
              {Math.min(index + 1, queue.length)} / {queue.length}
            </span>
          )}
        </div>
      </div>

      {saveError && (
        <div className="max-w-2xl mx-auto w-full px-4 pt-2">
          <div className="bg-terracotta/15 text-terracotta text-sm font-medium rounded-xl px-4 py-2.5">
            {saveError}
          </div>
        </div>
      )}

      <div className="flex-1 px-4 py-6 max-w-2xl mx-auto w-full flex flex-col">
        {loadingQueue ? (
          <Spinner />
        ) : queue.length === 0 ? (
          <p className="text-walnut text-sm py-16 text-center">No checked-in attendees for this Soulfest.</p>
        ) : done ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center py-16">
            <div className="w-16 h-16 rounded-full bg-gold/30 flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-espresso" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h3 className="text-xl font-bold text-espresso mb-1.5">All done</h3>
            <p className="text-walnut text-sm mb-6">
              Reviewed {queue.length} {queue.length === 1 ? 'person' : 'people'} for{' '}
              {selectedInstance?.series.name} ({selectedInstance && formatDate(selectedInstance.date)}).
            </p>
            <button
              onClick={backToPicker}
              className="bg-terracotta hover:bg-rust text-cream font-semibold px-6 py-3 rounded-xl transition-colors"
            >
              Back to Soulfests
            </button>
          </div>
        ) : (
          current && (
            <ReviewCard
              key={current.personId}
              person={current}
              onCommit={(rating, notes, flagged, direction) => {
                commitCard(index, rating, notes, flagged)
                setIndex(i => (direction === 'next' ? i + 1 : Math.max(0, i - 1)))
              }}
              canGoBack={index > 0}
            />
          )
        )}
      </div>
    </div>
  )
}

// ─── Review Card ──────────────────────────────────────────────────────────────

function ReviewCard({
  person,
  onCommit,
  canGoBack,
}: {
  person: QueuePerson
  onCommit: (rating: number | null, notes: string, flagged: boolean, direction: 'next' | 'prev') => void
  canGoBack: boolean
}) {
  const [rating, setRating] = useState<number | null>(person.currentAssessment?.rating ?? null)
  const [notes, setNotes] = useState(person.currentAssessment?.notes ?? '')
  const [flagged, setFlagged] = useState(!!person.currentAssessment?.follow_up_flag_id)
  const [showAllPast, setShowAllPast] = useState(false)

  const [dragX, setDragX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [flying, setFlying] = useState<'next' | 'prev' | null>(null)
  const startX = useRef(0)
  const cardRef = useRef<HTMLDivElement>(null)

  function selectRating(n: number) {
    setRating(n)
    if (n <= 2) setFlagged(true)
  }

  function onPointerDown(e: React.PointerEvent) {
    if (flying) return
    setDragging(true)
    startX.current = e.clientX
    cardRef.current?.setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragging) return
    setDragX(e.clientX - startX.current)
  }
  function onPointerUp() {
    if (!dragging) return
    setDragging(false)
    const threshold = 110
    if (dragX <= -threshold) fly('next')
    else if (dragX >= threshold && canGoBack) fly('prev')
    else setDragX(0)
  }

  function fly(direction: 'next' | 'prev') {
    setFlying(direction)
    setDragX(direction === 'next' ? -600 : 600)
  }

  function handleTransitionEnd() {
    if (!flying) return
    onCommit(rating, notes, flagged, flying)
  }

  const rotate = dragX / 18
  const nextHint = Math.max(0, Math.min(1, -dragX / 110))
  const backHint = canGoBack ? Math.max(0, Math.min(1, dragX / 110)) : 0

  return (
    <div className="flex-1 flex flex-col">
      <div
        ref={cardRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onTransitionEnd={handleTransitionEnd}
        style={{
          transform: `translateX(${dragX}px) rotate(${rotate}deg)`,
          transition: dragging ? 'none' : 'transform 0.22s ease',
          touchAction: 'pan-y',
        }}
        className="relative select-none bg-parchment rounded-3xl p-6 shadow-md"
      >
        {nextHint > 0 && (
          <span
            style={{ opacity: nextHint }}
            className="absolute top-5 right-5 text-xs font-bold tracking-wide text-terracotta border-2 border-terracotta rounded-lg px-2 py-1 rotate-6"
          >
            NEXT
          </span>
        )}
        {backHint > 0 && (
          <span
            style={{ opacity: backHint }}
            className="absolute top-5 left-5 text-xs font-bold tracking-wide text-walnut border-2 border-walnut rounded-lg px-2 py-1 -rotate-6"
          >
            BACK
          </span>
        )}

        <div className="flex items-start justify-between gap-3 mb-1">
          <h3 className="text-2xl font-bold text-espresso leading-tight">{person.name}</h3>
          {person.isNew && (
            <span className="shrink-0 text-xs font-semibold px-2.5 py-1 rounded-full bg-gold/40 text-espresso">
              New Member
            </span>
          )}
        </div>
        <p className="text-sm text-walnut mb-4">
          {person.eventCount} {person.eventCount === 1 ? 'event' : 'events'} total
          {person.lastSeenAt && <> · last seen {formatDate(person.lastSeenAt)}</>}
        </p>

        {person.pastAssessments.length > 0 && (
          <div className="bg-cream rounded-xl p-3.5 mb-4">
            <p className="text-xs font-semibold text-walnut/70 mb-2 uppercase tracking-wide">
              Past comments
            </p>
            <PastAssessment a={person.pastAssessments[0]} />
            {person.pastAssessments.length > 1 && (
              <>
                {showAllPast &&
                  person.pastAssessments.slice(1).map(a => (
                    <div key={a.id} className="border-t border-parchment mt-2 pt-2">
                      <PastAssessment a={a} />
                    </div>
                  ))}
                <button
                  onClick={() => setShowAllPast(o => !o)}
                  className="text-xs font-medium text-terracotta mt-2"
                >
                  {showAllPast ? 'Show less' : `+${person.pastAssessments.length - 1} earlier`}
                </button>
              </>
            )}
          </div>
        )}

        <div className="mb-4">
          <p className="text-sm font-medium text-espresso mb-2">
            Conduciveness <span className="text-walnut font-normal">(1–5)</span>
          </p>
          <div className="flex items-center gap-2">
            {[1, 2, 3, 4, 5].map(n => (
              <button
                key={n}
                onClick={() => selectRating(n)}
                className={`w-11 h-11 rounded-full font-semibold transition-colors ${
                  rating === n
                    ? 'bg-terracotta text-cream'
                    : 'bg-cream text-walnut hover:bg-walnut/20'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="flex justify-between text-xs text-walnut/60 mt-1 px-0.5">
            <span>Not conducive</span>
            <span>Very conducive</span>
          </div>
        </div>

        <div className="mb-4">
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Notes from this Soulfest…"
            rows={3}
            className="w-full bg-cream rounded-xl px-4 py-3 text-sm text-espresso placeholder-walnut/50 focus:outline-none focus:ring-2 focus:ring-terracotta resize-none"
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-espresso">
          <input
            type="checkbox"
            checked={flagged}
            onChange={e => setFlagged(e.target.checked)}
            className="w-4 h-4 accent-terracotta"
          />
          Flag for follow-up
        </label>
      </div>

      <div className="flex items-center gap-3 mt-4">
        <button
          onClick={() => canGoBack && fly('prev')}
          disabled={!canGoBack || !!flying}
          className="flex-1 bg-parchment hover:bg-walnut/20 disabled:opacity-40 text-walnut font-semibold py-3.5 rounded-xl transition-colors"
        >
          ← Back
        </button>
        <button
          onClick={() => fly('next')}
          disabled={!!flying}
          className="flex-1 bg-terracotta hover:bg-rust disabled:opacity-60 text-cream font-semibold py-3.5 rounded-xl transition-colors"
        >
          Save & Next →
        </button>
      </div>
    </div>
  )
}

function PastAssessment({ a }: { a: Assessment }) {
  return (
    <div className="text-sm">
      <p className="text-espresso">
        <span className="font-semibold">{a.rating ?? '—'}/5</span>
        {' · '}
        <span className="text-walnut">
          {a.event_instances?.event_series?.name ?? 'Soulfest'}
          {a.event_instances?.date && <> ({formatDate(a.event_instances.date)})</>}
        </span>
      </p>
      {a.notes && <p className="text-walnut mt-0.5 leading-relaxed">{a.notes}</p>}
    </div>
  )
}

// ─── Shared ───────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-8 h-8 border-2 border-terracotta border-t-transparent rounded-full animate-spin" />
    </div>
  )
}
