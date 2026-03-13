'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const router = useRouter()
  const supabase = createClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      router.push('/')
      router.refresh()
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-cream">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-espresso">Bhakti Studio</h1>
          <p className="text-walnut mt-2 text-sm">Sign in to continue</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-parchment rounded-2xl p-8 shadow-sm space-y-5"
        >
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-espresso mb-1.5">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full px-4 py-2.5 rounded-lg border border-parchment bg-cream text-espresso placeholder-walnut/50 focus:outline-none focus:ring-2 focus:ring-terracotta text-sm"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-espresso mb-1.5">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full px-4 py-2.5 rounded-lg border border-parchment bg-cream text-espresso placeholder-walnut/50 focus:outline-none focus:ring-2 focus:ring-terracotta text-sm"
            />
          </div>

          {error && <p className="text-terracotta text-sm">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-terracotta hover:bg-rust disabled:opacity-60 text-cream font-medium py-2.5 rounded-lg transition-colors text-sm cursor-pointer"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
