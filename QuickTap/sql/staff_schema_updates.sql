-- SQL Migration to add plain_password and enforce uniqueness for username/email
-- Run this in Supabase SQL Editor

ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS plain_password TEXT,
  ADD COLUMN IF NOT EXISTS username TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;

-- Make sure id_number is unique if not already
ALTER TABLE staff 
  ADD CONSTRAINT staff_id_number_unique UNIQUE (id_number);
