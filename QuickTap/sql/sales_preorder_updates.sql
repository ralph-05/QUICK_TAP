-- Add pre-order and insufficient payment columns to sales table for monitoring
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS insufficient_payment BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS total_order_amount NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_due NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS booking_id TEXT;
