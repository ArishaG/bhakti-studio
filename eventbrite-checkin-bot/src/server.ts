import express, { type NextFunction, type Request, type Response } from 'express'
import { performEventbriteCheckIn, getLastFailureDebug } from './checkin.js'

const app = express()
app.use(express.json())

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.headers.authorization !== `Bearer ${process.env.CHECKIN_BOT_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}

app.get('/health', (_req, res) => res.json({ ok: true }))

app.post('/check-in', requireAuth, async (req, res) => {
  const { eventbriteEventId, attendeeEmail, attendeeName } = req.body ?? {}
  if (!eventbriteEventId || !attendeeName) {
    res.status(400).json({ ok: false, error: 'eventbriteEventId and attendeeName are required' })
    return
  }
  const result = await performEventbriteCheckIn({
    eventbriteEventId,
    attendeeEmail: attendeeEmail ?? null,
    attendeeName,
  })
  res.json(result)
})

// Debug-only: inspect what the bot last saw when a check-in failed, so
// selectors in checkin.ts can be corrected without needing a live browser.
app.get('/debug/last-failure-screenshot', requireAuth, (_req, res) => {
  const { screenshot } = getLastFailureDebug()
  if (!screenshot) {
    res.status(404).end()
    return
  }
  res.setHeader('Content-Type', 'image/png')
  res.send(screenshot)
})

app.get('/debug/last-failure-html', requireAuth, (_req, res) => {
  const { html } = getLastFailureDebug()
  if (!html) {
    res.status(404).end()
    return
  }
  res.setHeader('Content-Type', 'text/html')
  res.send(html)
})

const port = Number(process.env.PORT ?? 8080)
app.listen(port, () => console.log(`eventbrite-checkin-bot listening on :${port}`))
