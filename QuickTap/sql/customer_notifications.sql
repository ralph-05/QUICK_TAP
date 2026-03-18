-- Customer notifications for insufficient payment and repayment flow
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

CREATE INDEX IF NOT EXISTS idx_customer_notifications_customer
  ON customer_notifications (customer_id);

CREATE INDEX IF NOT EXISTS idx_customer_notifications_status
  ON customer_notifications (status);
