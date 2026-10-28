-- Onboarding: the welcome guide shows once, on a person's first sign-in (new accounts and invited team members).
-- When the column is first added, people who already use Gather (they have a password) are marked as done,
-- so only new accounts see it. Safe to run on every start: the backfill happens only once.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'onboarded_at') THEN
    ALTER TABLE users ADD COLUMN onboarded_at timestamptz;
    UPDATE users SET onboarded_at = now() WHERE password_hash IS NOT NULL;
  END IF;
END $$;
