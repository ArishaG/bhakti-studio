import { createClient } from '@supabase/supabase-js'

// Bypasses RLS — only for server-only routes with no user session to attach
// to (webhooks, cron jobs). Never expose this client to the browser.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}
