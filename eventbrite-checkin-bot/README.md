# eventbrite-checkin-bot

Eventbrite's public API has no write endpoint for attendee check-in status —
it can only be set through Eventbrite's own organizer web UI. This is a small
always-on service that drives a real (headed, inside Xvfb) browser against
that UI, so the main Bhakti Studio app can push a check-in there too.

It runs as its own deployment, separate from the Next.js app on Vercel,
because it needs a persistent, stable environment: a real logged-in session
held in one place, on one stable IP, rather than a fresh serverless
invocation each time.

**Heads up:** automating Eventbrite's site this way isn't sanctioned by
their Terms of Service (which prohibit bot/automated access generally) —
this was a deliberate, accepted trade-off, not an oversight. See the chat
that produced this for the reasoning.

## How it works

- `src/browser.ts` launches one persistent Chromium context for the life of
  the process, loading `storage-state.json` (cookies + local storage) from
  `DATA_DIR` if present.
- `src/checkin.ts` navigates to the event's organizer page, opens Check-In,
  searches for the attendee, and clicks them in.
- `src/server.ts` exposes `POST /check-in` (bearer-auth'd) for the main app
  to call, plus `/debug/*` routes for inspecting failures.
- `src/login.ts` is run **locally**, not in the container — it opens a real
  visible browser so a human logs in normally (2FA included), then saves
  the session to `storage-state.json`.

## First-time setup

```bash
npm install
npx playwright install chromium
npm run login
```

A browser window opens to Eventbrite's sign-in page. Log in as the
organizer account, wait until you can see the Organizer dashboard, then
press Enter in the terminal. This writes `storage-state.json` — **do not
commit this file**, it's a live session.

## Deploying (Fly.io)

```bash
fly launch --no-deploy   # creates the app from fly.toml, skip the first deploy
fly volumes create checkin_data --size 1 --region sjc
fly secrets set CHECKIN_BOT_SECRET="$(openssl rand -hex 32)"
fly deploy
```

Then place the logged-in session onto the volume directly — it's a few MB
(cookies + all of Eventbrite's localStorage), too big to pass through an
env var/secret:

```bash
fly ssh sftp put storage-state.json /data/storage-state.json
fly machine restart <machine-id>   # so it picks up the file on next request
```

After that the bot persists its own refreshed cookies back to the volume on
every successful check-in, so you generally only need to redo `npm run
login` + re-upload if Eventbrite invalidates the session outright.

Any other VM/container host works the same way — Fly is just a convenient
default. The only requirements are: one always-on container, a persistent
volume (or any way to keep `storage-state.json` across restarts), and a
stable outbound IP.

In the main app, set:

```
EVENTBRITE_CHECKIN_BOT_URL=https://eventbrite-checkin-bot.fly.dev
EVENTBRITE_CHECKIN_BOT_SECRET=<same value as CHECKIN_BOT_SECRET>
```

## Debugging a failed check-in

`checkin.ts` was confirmed against a real screenshot of the Check-in page
and a real Check-in URL: it navigates straight to
`eventbrite.com/checkin?eid=<id>`, which is a `<table>` with an "Enter name
or email" search box. Each row's Status cell shows "Check in" text until
checked, then only a green checkmark icon (no text) — the code only ever
clicks the "Check in" text, never the checkmark, since clicking the
checkmark un-checks them. If `/check-in` still fails:

```bash
curl -H "Authorization: Bearer $CHECKIN_BOT_SECRET" \
  https://eventbrite-checkin-bot.fly.dev/debug/last-failure-screenshot -o failure.png

curl -H "Authorization: Bearer $CHECKIN_BOT_SECRET" \
  https://eventbrite-checkin-bot.fly.dev/debug/last-failure-html -o failure.html
```

These show exactly what the bot saw at the point it gave up — that's
normally enough to fix the one or two selectors that don't match the real
page, in `performEventbriteCheckIn` in `src/checkin.ts`.
