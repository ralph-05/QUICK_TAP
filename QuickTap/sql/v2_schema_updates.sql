-- 1. Add tracking columns to sales table (Required for Monitoring/Analytics)
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS cashier_id TEXT,
  ADD COLUMN IF NOT EXISTS cashier_name TEXT,
  ADD COLUMN IF NOT EXISTS cashier_remarks TEXT,
  ADD COLUMN IF NOT EXISTS discount NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'walk-in';

-- 2. Add kitchen status columns
ALTER TABLE pending_orders
  ADD COLUMN IF NOT EXISTS currently_preparing BOOLEAN DEFAULT FALSE;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS currently_preparing BOOLEAN DEFAULT FALSE;

-- 3. Create customer_notifications table (Required for the Bell alert)
CREATE TABLE IF NOT EXISTS customer_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id TEXT,
  order_id TEXT,
  source_table TEXT,
  remaining_amount NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'unread', 
  message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_customer_notifications_customer ON customer_notifications (customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales (date);
CREATE INDEX IF NOT EXISTS idx_sales_cashier_id ON sales (cashier_id);