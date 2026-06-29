'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'

const links = [
  { href: '/', label: 'Home' },
  { href: '/profiles', label: 'Profiles' },
  { href: '/insights', label: 'Insights' },
  { href: '/check-in', label: 'Check-In' },
  { href: '/review', label: 'Review' },
]

export default function Nav() {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()

  if (pathname === '/login') return null

  async function signOut() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-espresso shadow-md">
      <nav className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
        <Link href="/" className="text-cream font-bold text-lg tracking-wide">
          Bhakti Studio
        </Link>

        {/* Desktop links */}
        <div className="hidden md:flex items-center gap-8">
          {links.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className={`text-sm font-medium transition-colors ${
                pathname === href
                  ? 'text-gold'
                  : 'text-cream/70 hover:text-cream'
              }`}
            >
              {label}
            </Link>
          ))}
          <button
            onClick={signOut}
            className="text-sm font-medium text-cream/50 hover:text-cream/80 transition-colors"
          >
            Sign out
          </button>
        </div>

        {/* Mobile hamburger */}
        <button
          className="md:hidden text-cream p-1"
          onClick={() => setOpen(!open)}
          aria-label="Toggle menu"
        >
          {open ? (
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          )}
        </button>
      </nav>

      {/* Mobile dropdown */}
      {open && (
        <div className="md:hidden bg-walnut border-t border-cream/10 px-4 py-3 flex flex-col gap-1">
          {links.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setOpen(false)}
              className={`text-sm font-medium py-2 px-2 rounded transition-colors ${
                pathname === href
                  ? 'text-gold'
                  : 'text-cream/70 hover:text-cream'
              }`}
            >
              {label}
            </Link>
          ))}
          <button
            onClick={signOut}
            className="text-left text-sm font-medium py-2 px-2 text-cream/50 hover:text-cream/80 transition-colors"
          >
            Sign out
          </button>
        </div>
      )}
    </header>
  )
}
