-- Run this once in the Supabase SQL Editor.
-- Captures the Eventbrite ticket type an attendee registered with (e.g.
-- "Membership Ticket", "Community Supported Ticket"), shown alongside the
-- existing Paid/Unpaid tag on the check-in page. Null for Arketa/manual
-- attendances, which have no equivalent concept.

alter table attendances add column if not exists ticket_type text;
