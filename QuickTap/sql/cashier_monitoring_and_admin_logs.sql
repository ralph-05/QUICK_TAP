-- Run in Supabase SQL Editor for cashier monitoring and admin logs.

-- Add cashier_id to sales (who processed the transaction)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS cashier_id UUID REFERENCES staff(id);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS cashier_name TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS cashier_remarks TEXT;

-- Admin activity logs (visible to all admins)
CREATE TABLE IF NOT EXISTS admin_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES staff(id),
  admin_name TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
