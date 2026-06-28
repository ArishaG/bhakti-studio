export type EventTag = 'soulfest' | 'outreach' | 'classes' | 'other'

// Arketa/Eventbrite have no concept of our event_tag taxonomy, so every
// series name seen so far has been classified by hand below. Anything new
// defaults to "other" so an admin can re-tag it from the Events page rather
// than the sync silently mis-categorizing it as soulfest/classes/outreach.
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

export const CANONICAL_SOULFEST_NAME = 'Kirtan Soulfest | Guided Music Meditation'

// Special-edition Soulfest classes (holiday/anniversary/location variants)
// fold into one canonical series rather than each becoming its own
// one-instance series — they're the same recurring program.
export function canonicalSeriesName(name: string): string {
  const trimmed = name.trim()
  return trimmed.toLowerCase().includes('soulfest') ? CANONICAL_SOULFEST_NAME : trimmed
}

export function classifySeries(name: string): EventTag {
  const key = name.trim().toLowerCase()
  if (key.includes('soulfest')) return 'soulfest'
  return EXPLICIT_TAGS[key] ?? 'other'
}
