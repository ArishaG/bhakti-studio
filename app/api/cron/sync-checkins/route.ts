import { createAdminClient } from '@/lib/supabase/admin'
import { syncArketa } from '@/lib/syncArketa'
import { syncEventbrite } from '@/lib/syncEventbrite'

// ─── Route handler ────────────────────────────────────────────────────────────
// Periodic backstop for check-in/paid status, since Arketa has no webhooks at
// all and Eventbrite's webhook only covers what it's subscribed to. Scoped to
// the last few days through all future events (not the full 3-month history)
// to keep each run light. Triggered by Vercel Cron (see vercel.json); Vercel
// injects the Authorization header automatically when CRON_SECRET is set.

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  const supabase = createAdminClient()

  const [arketaResult, eventbriteResult] = await Promise.all([
    process.env.ARKETA_API_KEY
      ? syncArketa(supabase, { sinceDays: 3 })
      : Promise.resolve(null),
    process.env.EVENTBRITE_API_KEY
      ? syncEventbrite(supabase, { sinceDays: 3 })
      : Promise.resolve(null),
  ])

  return Response.json({ arketa: arketaResult, eventbrite: eventbriteResult })
}
