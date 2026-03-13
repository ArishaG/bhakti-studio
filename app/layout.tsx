import type { Metadata } from 'next'
import './globals.css'
import Nav from '@/components/Nav'

export const metadata: Metadata = {
  title: 'Bhakti Studio',
  description: 'Studio management platform',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-cream text-espresso antialiased">
        <Nav />
        {children}
      </body>
    </html>
  )
}
