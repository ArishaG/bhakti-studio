const ARKETA_BASE = `https://us-central1-sutra-prod.cloudfunctions.net/partnerApi/v0/${process.env.ARKETA_PARTNER_ID}`

export type ArketaClass = {
  id: string
  name: string
  deleted: boolean
  canceled: boolean
  start_time: string
  instructor_name: string | null
  total_booked: number
}

export type ArketaReservation = {
  id: string
  client_id: string
  client: {
    first_name: string | null
    last_name: string | null
    email: string | null
    phone: string | null
  }
  status: 'BOOKED' | 'ATTENDED' | 'CANCELLED' | string
  checked_in: boolean
  checked_in_at: string | null
  created_at: string
}

export type ArketaPurchase = {
  client_id: string
  status: string
}

async function arketaGet<T>(pathAndQuery: string): Promise<T> {
  const res = await fetch(`${ARKETA_BASE}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${process.env.ARKETA_API_KEY}` },
  })
  if (!res.ok) throw new Error(`Arketa GET ${pathAndQuery} -> ${res.status}`)
  return res.json()
}

export async function arketaFetchClasses(): Promise<ArketaClass[]> {
  const { items } = await arketaGet<{ items: ArketaClass[] }>('/classes?limit=500')
  return items
}

export async function arketaFetchReservations(classId: string): Promise<ArketaReservation[]> {
  const { items } = await arketaGet<{ items: ArketaReservation[] }>(
    `/classes/${classId}/reservations?limit=200`
  )
  return items
}

// Builds a client_id -> "has an active purchase" map across all clients.
// Arketa has no per-reservation payment field, so an active membership/pack
// is used as the closest available proxy for "paid", per the studio's own
// usage of this same data in their Arketa dashboard.
export async function arketaFetchActivePurchaseClientIds(): Promise<Set<string>> {
  const activeClientIds = new Set<string>()
  let startAfterId: string | undefined
  do {
    const qs = new URLSearchParams({ limit: '200' })
    if (startAfterId) qs.set('startAfterId', startAfterId)
    const data = await arketaGet<{
      items: ArketaPurchase[]
      pagination: { hasMore: boolean; nextStartAfterId?: string }
    }>(`/purchases?${qs}`)
    for (const p of data.items) {
      if (p.status === 'ACTIVE') activeClientIds.add(p.client_id)
    }
    startAfterId = data.pagination.hasMore ? data.pagination.nextStartAfterId : undefined
  } while (startAfterId)
  return activeClientIds
}

// Pushes a check-in to Arketa for a reservation created in our app or
// confirmed at the door. Best-effort: callers should not fail the local
// check-in if this throws, since there's no guarantee the reservation is
// still in a checkable state on Arketa's side.
export async function arketaCheckInReservation(classId: string, reservationId: string): Promise<void> {
  const res = await fetch(
    `${ARKETA_BASE}/classes/${classId}/reservations/${reservationId}/check-in`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.ARKETA_API_KEY}` } }
  )
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Arketa check-in ${classId}/${reservationId} -> ${res.status}: ${body}`)
  }
}
