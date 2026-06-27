import { createClient } from '@/lib/supabase/server'
import { syncEventbrite } from '@/lib/syncEventbrite'

export async function POST() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  if (!process.env.EVENTBRITE_API_KEY || !process.env.EVENTBRITE_ORG_ID) {
    return Response.json({ error: 'Eventbrite is not configured' }, { status: 500 })
  }

  const result = await syncEventbrite(supabase)
  return Response.json(result)
}
