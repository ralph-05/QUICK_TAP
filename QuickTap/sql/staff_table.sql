-- Run this in Supabase SQL Editor to create the staff table.
-- After running, use the Staff Login on the home page:
-- - If no staff exist, you will see "First-time setup" to create the system admin.
-- - Otherwise log in with your staff ID number and password.

CREATE TABLE IF NOT EXISTS staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_number TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('system_admin', 'admin', 'cashier', 'kitchen_staff')),
  is_system_admin BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
