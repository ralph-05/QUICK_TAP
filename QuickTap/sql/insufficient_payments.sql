-- Add insufficient payment columns so the remaining balance is reliably forwarded to Kitchen
-- Run in Supabase SQL Editor.

ALTER TABLE pending_orders
  ADD COLUMN IF NOT EXISTS insufficient_payment BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS insufficient_amount_needed NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS insufficient_notes TEXT;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS insufficient_payment BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS insufficient_amount_needed NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS insufficient_notes TEXT;

