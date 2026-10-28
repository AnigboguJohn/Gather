-- Admin panel, account suspension and one phone number per account.
-- Platform admins sign in at /admin with their own accounts (separate from workspace owners/admins).
CREATE TABLE IF NOT EXISTS platform_admins (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE,
  name           text NOT NULL DEFAULT 'Admin',
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);

-- A suspended person can't sign in or use the app until an admin lifts it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at timestamptz;

-- Phone numbers are stored in international form (+2348031234567) and may belong to one account only.
-- If two accounts already share a number, the oldest keeps it and the others must add their own in Settings.
UPDATE users u SET phone = NULL
WHERE phone IS NOT NULL AND EXISTS (
  SELECT 1 FROM users o WHERE o.phone = u.phone AND (o.created_at, o.id) < (u.created_at, u.id));
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users (phone) WHERE phone IS NOT NULL;
