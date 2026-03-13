import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/lib/supabase/server'

export type SeriesInput = {
  id: string
  name: string
  tag: string
  totalAttendances: number
  uniqueAttendees: number
  returnRate: number
  conversionRate: number | null
  monthsOfData: number
}

export type SeriesRecommendation = {
  seriesId: string
  badge: 'Continue' | 'Reconsider'
  reason: string
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  const { series }: { series: SeriesInput[] } = await request.json()
  if (!series?.length) return Response.json({ recommendations: [] })

  const anthropic = new Anthropic()

  const seriesList = series
    .map(
      (s, i) =>
        `${i + 1}. id="${s.id}" name="${s.name}" tag=${s.tag}
   total_attendances=${s.totalAttendances} unique_attendees=${s.uniqueAttendees}
   return_rate=${s.returnRate.toFixed(1)}%${
     s.conversionRate !== null
       ? ` conversion_to_core=${s.conversionRate.toFixed(1)}%`
       : ''
   }
   months_of_data=${s.monthsOfData}`
    )
    .join('\n\n')

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: `You analyze event series performance data for a yoga/wellness studio called Bhakti Studio.
For each series, decide "Continue" (healthy engagement, worth running) or "Reconsider" (weak performance, needs re-evaluation).
Guidelines:
- Return rate ≥ 35% or conversion ≥ 20% → lean Continue
- Return rate < 15% and conversion < 10% → lean Reconsider
- Low attendance counts (< 10 total) → be cautious about conclusions
Respond ONLY with a valid JSON array. No markdown, no explanation, just the array.
Format: [{"seriesId":"<id>","badge":"Continue","reason":"<one concise sentence>"},...]`,
    messages: [
      {
        role: 'user',
        content: `Analyze these event series and return your recommendations as JSON:\n\n${seriesList}`,
      },
    ],
  })

  const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : '[]'

  let recommendations: SeriesRecommendation[] = []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) recommendations = parsed
  } catch {
    // Malformed JSON — return empty, UI will hide badges gracefully
  }

  return Response.json({ recommendations })
}
