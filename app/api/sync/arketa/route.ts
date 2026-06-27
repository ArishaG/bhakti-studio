import { createClient } from '@/lib/supabase/server'
import { syncArketa } from '@/lib/syncArketa'

export async function POST() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  if (!process.env.ARKETA_API_KEY || !process.env.ARKETA_PARTNER_ID) {
    return Response.json({ error: 'Arketa is not configured' }, { status: 500 })
  }

  const result = await syncArketa(supabase)
  return Response.json(result)
}
