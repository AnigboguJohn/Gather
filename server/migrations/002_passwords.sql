-- Email + password sign-in. Accounts are created only after the email is proven with a one-time code.
-- Stored as scrypt "salt:hash" (see lib/codes.ts). NULL for older passwordless accounts and invited team
-- members until they finish sign-up with their email, which sets one.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
