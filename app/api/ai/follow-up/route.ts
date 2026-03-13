import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/lib/supabase/server'

export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  const { personName, attendanceHistory, adminNotes } = await request.json()

  const anthropic = new Anthropic()

  const stream = anthropic.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 256,
    system: `You are a thoughtful assistant for Bhakti Studio, a yoga and movement studio.
Help studio staff write warm, personal follow-up messages to students.
Tone: genuine, caring, brief — never sales-y or pushy.
Write exactly 2–3 sentences. Output only the message text, no preamble or explanation.`,
    messages: [
      {
        role: 'user',
        content: `Student: ${personName}
Recent attendance: ${attendanceHistory}
Staff notes: ${adminNotes || 'None'}

Write a warm follow-up message the staff could send to this student.`,
      },
    ],
  })

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta'
          ) {
            controller.enqueue(encoder.encode(event.delta.text))
          }
        }
      } finally {
        controller.close()
      }
    },
  })

  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
