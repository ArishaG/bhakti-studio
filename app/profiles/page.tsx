'use client'

import { useState, useEffect, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'

// ─── Types ────────────────────────────────────────────────────────────────────

type EventTag = 'soulfest' | 'outreach' | 'classes' | 'other'

type FollowUpFlag = {
  id: string
  reason: string | null
  created_at: string
  assigned_to: string | null
  notes: string | null
  resolved: boolean
}

type AttendanceSummary = {
  id: string
  event_instances: { event_series: { name: string; tag: EventTag } } | null
}

type AttendanceDetail = {
  id: string
  checked_in_at: string
  source: string
  event_instances: {
    date: string
    instructor_name: string | null
    event_series: { name: string; tag: EventTag }
  } | null
}

type Person = {
  id: string
  name: string
  email: string | null
  phone: string | null
  event_count: number
  is_active: boolean
  last_seen_at: string | null
  admin_notes: string | null
  created_at: string
  follow_up_flags: FollowUpFlag[]
  attendances: AttendanceSummary[]
}

type SortMode = 'followUp' | 'mostRegular' | 'leastRegular'
type FilterTag = 'all' | EventTag

// ─── Constants ────────────────────────────────────────────────────────────────

const TAG_STYLES: Record<EventTag, string> = {
  soulfest: 'bg-gold/30 text-espresso',
  outreach: 'bg-terracotta/20 text-terracotta',
  classes: 'bg-walnut/20 text-walnut',
  other: 'bg-parchment text-walnut',
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ProfilesPage() {
  const supabase = createClient()

  const [view, setView] = useState<'list' | 'detail'>('list')
  const [people, setPeople] = useState<Person[]>([])
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortMode>('followUp')
  const [filterTag, setFilterTag] = useState<FilterTag>('all')
  const [loading, setLoading] = useState(true)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)

  // Detail-view state
  const [detailAttendances, setDetailAttendances] = useState<AttendanceDetail[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [adminNotes, setAdminNotes] = useState('')
  const [notesSaving, setNotesSaving] = useState(false)
  const [notesSaved, setNotesSaved] = useState(false)
  const [aiSuggestion, setAiSuggestion] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) setCurrentUserId(user.id)
    })
    loadPeople()
  }, [])

  async function loadPeople() {
    setLoading(true)
    const { data } = await supabase
      .from('people')
      .select(`
        id, name, email, phone, event_count, is_active, last_seen_at, admin_notes, created_at,
        follow_up_flags ( id, reason, created_at, assigned_to, notes, resolved ),
        attendances ( id, event_instances ( event_series ( name, tag ) ) )
      `)
      .order('name')
    setPeople((data as unknown as Person[]) ?? [])
    setLoading(false)
  }

  async function openDetail(person: Person) {
    setSelectedPerson(person)
    setAdminNotes(person.admin_notes ?? '')
    setAiSuggestion('')
    setAiError('')
    setView('detail')
    setDetailLoading(true)
    const { data } = await supabase
      .from('attendances')
      .select(`
        id, checked_in_at, source,
        event_instances ( date, instructor_name, event_series ( name, tag ) )
      `)
      .eq('person_id', person.id)
      .order('checked_in_at', { ascending: false })
    setDetailAttendances((data as unknown as AttendanceDetail[]) ?? [])
    setDetailLoading(false)
  }

  async function saveNotes() {
    if (!selectedPerson) return
    setNotesSaving(true)
    await supabase
      .from('people')
      .update({ admin_notes: adminNotes })
      .eq('id', selectedPerson.id)
    setNotesSaving(false)
    setNotesSaved(true)
    setTimeout(() => setNotesSaved(false), 2000)
    const updated = { ...selectedPerson, admin_notes: adminNotes }
    setSelectedPerson(updated)
    setPeople(prev => prev.map(p => (p.id === updated.id ? updated : p)))
  }

  function updatePersonLocal(updated: Person) {
    setSelectedPerson(updated)
    setPeople(prev => prev.map(p => (p.id === updated.id ? updated : p)))
  }

  async function resolveFlag(flagId: string) {
    await supabase.from('follow_up_flags').update({ resolved: true }).eq('id', flagId)
    if (!selectedPerson) return
    updatePersonLocal({
      ...selectedPerson,
      follow_up_flags: selectedPerson.follow_up_flags.map(f =>
        f.id === flagId ? { ...f, resolved: true } : f
      ),
    })
  }

  async function saveFlagNotes(flagId: string, notes: string) {
    await supabase.from('follow_up_flags').update({ notes }).eq('id', flagId)
    if (!selectedPerson) return
    updatePersonLocal({
      ...selectedPerson,
      follow_up_flags: selectedPerson.follow_up_flags.map(f =>
        f.id === flagId ? { ...f, notes } : f
      ),
    })
  }

  async function assignFlagToMe(flagId: string) {
    if (!currentUserId) return
    await supabase
      .from('follow_up_flags')
      .update({ assigned_to: currentUserId })
      .eq('id', flagId)
    if (!selectedPerson) return
    updatePersonLocal({
      ...selectedPerson,
      follow_up_flags: selectedPerson.follow_up_flags.map(f =>
        f.id === flagId ? { ...f, assigned_to: currentUserId } : f
      ),
    })
  }

  async function generateAISuggestion() {
    if (!selectedPerson) return
    setAiLoading(true)
    setAiSuggestion('')
    setAiError('')

    const history = detailAttendances
      .slice(0, 20)
      .map(
        a =>
          `${a.event_instances?.event_series?.name ?? 'event'} on ${new Date(
            a.checked_in_at
          ).toLocaleDateString()}`
      )
      .join('; ')

    try {
      const res = await fetch('/api/ai/follow-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personName: selectedPerson.name,
          attendanceHistory: history || 'No attendance history yet',
          adminNotes: selectedPerson.admin_notes ?? '',
        }),
      })
      if (!res.ok || !res.body) {
        setAiError('Failed to generate suggestion. Please try again.')
        setAiLoading(false)
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        setAiSuggestion(prev => prev + decoder.decode(value, { stream: true }))
      }
    } catch {
      setAiError('Something went wrong. Please try again.')
    }
    setAiLoading(false)
  }

  // ─── Derived list ─────────────────────────────────────────────────────────

  const displayedPeople = useMemo(() => {
    let result = [...people]

    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter(
        p =>
          p.name.toLowerCase().includes(q) || p.email?.toLowerCase().includes(q)
      )
    }

    if (filterTag !== 'all') {
      result = result.filter(p =>
        p.attendances.some(
          a => a.event_instances?.event_series?.tag === filterTag
        )
      )
    }

    if (sort === 'followUp') {
      result = result.filter(p => p.follow_up_flags.some(f => !f.resolved))
      result.sort((a, b) => {
        const latestFlag = (p: Person) =>
          p.follow_up_flags
            .filter(f => !f.resolved)
            .sort((x, y) => y.created_at.localeCompare(x.created_at))[0]
            ?.created_at ?? ''
        return latestFlag(b).localeCompare(latestFlag(a))
      })
    } else if (sort === 'mostRegular') {
      result.sort((a, b) => b.event_count - a.event_count)
    } else {
      result.sort((a, b) => a.event_count - b.event_count)
    }

    return result
  }, [people, search, sort, filterTag])

  // ─── Detail View ──────────────────────────────────────────────────────────

  if (view === 'detail' && selectedPerson) {
    const unresolvedFlags = selectedPerson.follow_up_flags.filter(f => !f.resolved)
    const resolvedFlags = selectedPerson.follow_up_flags.filter(f => f.resolved)
    const attendedTags = [
      ...new Set(
        selectedPerson.attendances
          .map(a => a.event_instances?.event_series?.tag)
          .filter(Boolean) as EventTag[]
      ),
    ]

    return (
      <div className="min-h-screen bg-cream pt-16">
        {/* Sticky header */}
        <div className="sticky top-16 z-10 bg-cream border-b border-parchment px-4 pt-4 pb-3 flex items-center gap-3">
          <button
            onClick={() => setView('list')}
            className="p-1 -ml-1 text-walnut hover:text-espresso transition-colors"
            aria-label="Back"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-espresso truncate">{selectedPerson.name}</h2>
            {selectedPerson.email && (
              <p className="text-sm text-walnut truncate">{selectedPerson.email}</p>
            )}
          </div>
        </div>

        <div className="max-w-2xl mx-auto px-4 py-6 pb-16 space-y-6">
          {/* Summary card */}
          <div className="bg-parchment rounded-2xl p-5 space-y-3">
            {selectedPerson.phone && (
              <p className="text-sm text-walnut">{selectedPerson.phone}</p>
            )}
            <div className="flex items-center gap-3 flex-wrap">
              <span
                className={`text-xs font-semibold px-3 py-1 rounded-full ${
                  selectedPerson.is_active
                    ? 'bg-gold/40 text-espresso'
                    : 'bg-walnut/20 text-walnut'
                }`}
              >
                {selectedPerson.is_active ? 'Active' : 'Inactive'}
              </span>
              <span className="text-sm text-walnut">{selectedPerson.event_count} events</span>
              {selectedPerson.last_seen_at && (
                <span className="text-sm text-walnut">
                  Last seen{' '}
                  {new Date(selectedPerson.last_seen_at).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </span>
              )}
            </div>
            {attendedTags.length > 0 && (
              <div className="flex gap-1.5 flex-wrap">
                {attendedTags.map(tag => (
                  <span
                    key={tag}
                    className={`text-xs font-medium px-2.5 py-1 rounded-full capitalize ${TAG_STYLES[tag]}`}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Unresolved follow-up flags */}
          {unresolvedFlags.length > 0 && (
            <section>
              <h3 className="text-base font-semibold text-espresso mb-3">Follow-Up Flags</h3>
              <div className="space-y-3">
                {unresolvedFlags.map(flag => (
                  <FlagCard
                    key={flag.id}
                    flag={flag}
                    currentUserId={currentUserId}
                    onResolve={() => resolveFlag(flag.id)}
                    onSaveNotes={notes => saveFlagNotes(flag.id, notes)}
                    onAssignToMe={() => assignFlagToMe(flag.id)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* AI Follow-Up Suggestion */}
          <section>
            <h3 className="text-base font-semibold text-espresso mb-3">Follow-Up Suggestion</h3>
            <div className="bg-parchment rounded-2xl p-5">
              {!aiSuggestion && !aiLoading && !aiError && (
                <p className="text-sm text-walnut mb-4 leading-relaxed">
                  Generate a personalized message based on{' '}
                  {selectedPerson.name.split(' ')[0]}&apos;s attendance history and your notes.
                </p>
              )}
              {aiLoading && (
                <div className="flex items-center gap-2 text-walnut text-sm mb-4">
                  <div className="w-4 h-4 border-2 border-terracotta border-t-transparent rounded-full animate-spin shrink-0" />
                  Generating…
                </div>
              )}
              {aiSuggestion && (
                <div className="bg-cream rounded-xl px-4 py-3.5 mb-4 text-sm text-espresso leading-relaxed whitespace-pre-wrap">
                  {aiSuggestion}
                </div>
              )}
              {aiError && (
                <p className="text-sm text-terracotta mb-4">{aiError}</p>
              )}
              <button
                onClick={generateAISuggestion}
                disabled={aiLoading}
                className="flex items-center gap-2 bg-espresso hover:bg-walnut disabled:opacity-50 text-cream text-sm font-medium px-4 py-2.5 rounded-xl transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                {aiSuggestion ? 'Regenerate' : 'Generate Follow-Up Suggestion'}
              </button>
            </div>
          </section>

          {/* Admin Notes */}
          <section>
            <h3 className="text-base font-semibold text-espresso mb-3">Admin Notes</h3>
            <div className="bg-parchment rounded-2xl p-5">
              <textarea
                value={adminNotes}
                onChange={e => setAdminNotes(e.target.value)}
                placeholder="Internal notes about this person…"
                rows={4}
                className="w-full bg-cream rounded-xl px-4 py-3 text-sm text-espresso placeholder-walnut/50 focus:outline-none focus:ring-2 focus:ring-terracotta resize-none"
              />
              <div className="flex items-center justify-between mt-3">
                <span className={`text-xs transition-opacity ${notesSaved ? 'text-walnut opacity-100' : 'opacity-0'}`}>
                  Saved
                </span>
                <button
                  onClick={saveNotes}
                  disabled={notesSaving}
                  className="bg-terracotta hover:bg-rust disabled:opacity-50 text-cream text-sm font-medium px-4 py-2 rounded-xl transition-colors"
                >
                  {notesSaving ? 'Saving…' : 'Save Notes'}
                </button>
              </div>
            </div>
          </section>

          {/* Attendance History */}
          <section>
            <h3 className="text-base font-semibold text-espresso mb-3">
              Attendance History
              {!detailLoading && (
                <span className="font-normal text-walnut ml-1.5">
                  ({detailAttendances.length})
                </span>
              )}
            </h3>
            {detailLoading ? (
              <Spinner />
            ) : detailAttendances.length === 0 ? (
              <p className="text-sm text-walnut">No attendance records.</p>
            ) : (
              <ul className="space-y-2">
                {detailAttendances.map(a => (
                  <li
                    key={a.id}
                    className="bg-parchment rounded-xl px-4 py-3 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-espresso truncate">
                        {a.event_instances?.event_series?.name ?? 'Unknown Event'}
                        {a.event_instances?.instructor_name && (
                          <span className="font-normal text-walnut">
                            {' '}· {a.event_instances.instructor_name}
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-walnut mt-0.5">
                        {new Date(a.checked_in_at).toLocaleDateString('en-US', {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                        <span className="text-walnut/50 capitalize ml-2">{a.source}</span>
                      </p>
                    </div>
                    {a.event_instances?.event_series?.tag && (
                      <span
                        className={`shrink-0 text-xs font-medium px-2.5 py-1 rounded-full capitalize ${
                          TAG_STYLES[a.event_instances.event_series.tag]
                        }`}
                      >
                        {a.event_instances.event_series.tag}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Resolved flags (collapsed section) */}
          {resolvedFlags.length > 0 && (
            <section>
              <h3 className="text-sm font-medium text-walnut/70 mb-2">
                Resolved Flags ({resolvedFlags.length})
              </h3>
              <ul className="space-y-2">
                {resolvedFlags.map(flag => (
                  <li
                    key={flag.id}
                    className="bg-parchment/60 rounded-xl px-4 py-3 opacity-50"
                  >
                    <p className="text-sm text-walnut line-through">{flag.reason}</p>
                    <p className="text-xs text-walnut/60 mt-0.5">
                      {new Date(flag.created_at).toLocaleDateString()}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    )
  }

  // ─── List View ────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-cream pt-16">
      {/* Sticky search + filters */}
      <div className="sticky top-16 z-10 bg-cream border-b border-parchment px-4 pt-4 pb-3 space-y-3">
        <h1 className="text-2xl font-bold text-espresso">Profiles</h1>
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name or email…"
          className="w-full px-4 py-2.5 rounded-xl bg-parchment border border-parchment text-espresso placeholder-walnut/50 focus:outline-none focus:ring-2 focus:ring-terracotta text-sm"
        />
        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-0.5">
          {(
            [
              { value: 'followUp', label: 'Follow-Up' },
              { value: 'mostRegular', label: 'Most Regular' },
              { value: 'leastRegular', label: 'Least Regular' },
            ] as { value: SortMode; label: string }[]
          ).map(opt => (
            <button
              key={opt.value}
              onClick={() => setSort(opt.value)}
              className={`shrink-0 text-xs font-medium px-3.5 py-1.5 rounded-full transition-colors ${
                sort === opt.value
                  ? 'bg-espresso text-cream'
                  : 'bg-parchment text-walnut hover:bg-walnut/20'
              }`}
            >
              {opt.label}
            </button>
          ))}
          <div className="w-px bg-parchment shrink-0 self-center h-4 mx-0.5" />
          {(['all', 'soulfest', 'outreach', 'classes'] as const).map(tag => (
            <button
              key={tag}
              onClick={() => setFilterTag(tag)}
              className={`shrink-0 text-xs font-medium px-3.5 py-1.5 rounded-full capitalize transition-colors ${
                filterTag === tag
                  ? 'bg-espresso text-cream'
                  : 'bg-parchment text-walnut hover:bg-walnut/20'
              }`}
            >
              {tag === 'all' ? 'All' : tag}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="px-4 pt-3 pb-10">
        {loading ? (
          <Spinner />
        ) : displayedPeople.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-walnut">
              {sort === 'followUp' ? 'No unresolved follow-up flags.' : 'No profiles found.'}
            </p>
          </div>
        ) : (
          <ul className="space-y-3 max-w-2xl mx-auto">
            {displayedPeople.map(person => {
              const tags = [
                ...new Set(
                  person.attendances
                    .map(a => a.event_instances?.event_series?.tag)
                    .filter(Boolean) as EventTag[]
                ),
              ]
              const unresolvedFlags = person.follow_up_flags.filter(f => !f.resolved)

              return (
                <li key={person.id}>
                  <button
                    onClick={() => openDetail(person)}
                    className="w-full text-left bg-parchment rounded-2xl p-5 shadow-sm active:scale-[0.99] transition-transform"
                  >
                    {/* Name + active badge */}
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <h3 className="text-lg font-semibold text-espresso leading-tight">
                        {person.name}
                      </h3>
                      <span
                        className={`shrink-0 text-xs font-semibold px-2.5 py-1 rounded-full ${
                          person.is_active
                            ? 'bg-gold/40 text-espresso'
                            : 'bg-walnut/20 text-walnut'
                        }`}
                      >
                        {person.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </div>

                    {/* Contact */}
                    <div className="text-sm text-walnut space-y-0.5 mb-2">
                      {person.email && <p>{person.email}</p>}
                      {person.phone && <p>{person.phone}</p>}
                    </div>

                    {/* Stats */}
                    <div className="flex items-center gap-3 text-xs text-walnut mb-3 flex-wrap">
                      <span>{person.event_count} events</span>
                      {person.last_seen_at && (
                        <span>
                          Last seen{' '}
                          {new Date(person.last_seen_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })}
                        </span>
                      )}
                    </div>

                    {/* Tags */}
                    {tags.length > 0 && (
                      <div className="flex gap-1.5 flex-wrap mb-3">
                        {tags.map(tag => (
                          <span
                            key={tag}
                            className={`text-xs font-medium px-2.5 py-0.5 rounded-full capitalize ${TAG_STYLES[tag]}`}
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Flags */}
                    {unresolvedFlags.length > 0 && (
                      <div className="border-t border-cream/80 pt-3 space-y-1.5">
                        {unresolvedFlags.map(flag => (
                          <div key={flag.id} className="flex items-start gap-2">
                            <svg
                              className="w-3.5 h-3.5 text-terracotta shrink-0 mt-0.5"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                              />
                            </svg>
                            <div className="min-w-0">
                              <p className="text-xs text-espresso font-medium truncate">
                                {flag.reason}
                              </p>
                              <p className="text-xs text-walnut/60">
                                {flag.assigned_to
                                  ? flag.assigned_to === currentUserId
                                    ? 'Assigned to you'
                                    : 'Assigned'
                                  : 'Unassigned'}{' '}
                                · {new Date(flag.created_at).toLocaleDateString()}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

// ─── Flag Card ────────────────────────────────────────────────────────────────

function FlagCard({
  flag,
  currentUserId,
  onResolve,
  onSaveNotes,
  onAssignToMe,
}: {
  flag: FollowUpFlag
  currentUserId: string | null
  onResolve: () => void
  onSaveNotes: (notes: string) => Promise<void>
  onAssignToMe: () => void
}) {
  const [notesOpen, setNotesOpen] = useState(false)
  const [localNotes, setLocalNotes] = useState(flag.notes ?? '')
  const [saving, setSaving] = useState(false)

  async function handleSaveNotes() {
    setSaving(true)
    await onSaveNotes(localNotes)
    setSaving(false)
    setNotesOpen(false)
  }

  return (
    <div className="bg-parchment rounded-2xl p-4 border border-terracotta/20">
      <div className="flex items-start gap-3 mb-3">
        <svg
          className="w-4 h-4 text-terracotta shrink-0 mt-0.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-espresso">{flag.reason}</p>
          <p className="text-xs text-walnut mt-0.5">
            Flagged {new Date(flag.created_at).toLocaleDateString()} ·{' '}
            {flag.assigned_to
              ? flag.assigned_to === currentUserId
                ? 'Assigned to you'
                : 'Assigned to admin'
              : 'Unassigned'}
          </p>
          {flag.notes && !notesOpen && (
            <p className="text-xs text-walnut italic mt-1 leading-relaxed">{flag.notes}</p>
          )}
        </div>
      </div>

      {notesOpen && (
        <textarea
          value={localNotes}
          onChange={e => setLocalNotes(e.target.value)}
          placeholder="Add notes about this flag…"
          rows={2}
          className="w-full mb-3 bg-cream rounded-xl px-3 py-2.5 text-sm text-espresso placeholder-walnut/50 focus:outline-none focus:ring-2 focus:ring-terracotta resize-none"
        />
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={onResolve}
          className="text-xs font-medium bg-gold/30 hover:bg-gold/50 text-espresso px-3 py-1.5 rounded-lg transition-colors"
        >
          Mark Resolved
        </button>
        <button
          onClick={() => setNotesOpen(o => !o)}
          className="text-xs font-medium bg-cream hover:bg-parchment text-walnut px-3 py-1.5 rounded-lg transition-colors"
        >
          {notesOpen ? 'Cancel' : flag.notes ? 'Edit Notes' : 'Add Notes'}
        </button>
        {notesOpen && (
          <button
            onClick={handleSaveNotes}
            disabled={saving}
            className="text-xs font-medium bg-terracotta hover:bg-rust disabled:opacity-50 text-cream px-3 py-1.5 rounded-lg transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
        {flag.assigned_to !== currentUserId && (
          <button
            onClick={onAssignToMe}
            className="text-xs font-medium text-walnut hover:text-espresso transition-colors px-2 py-1.5"
          >
            Assign to me
          </button>
        )}
      </div>
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
