-- Reviews of Gather itself, from hosts and guests (one each, asked after their first meeting).
-- A person is recognised by their account, email or phone number (stored in international digits, 2348031234567),
-- so a guest who joins again with the same email or WhatsApp number is never asked twice.
CREATE TABLE IF NOT EXISTS reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid REFERENCES sessions(id) ON DELETE SET NULL,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  role        text NOT NULL DEFAULT 'guest',          -- host | cohost | guest
  name        text NOT NULL,
  email       text,
  phone       text,
  rating      smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  tags        text[] NOT NULL DEFAULT '{}',           -- "What did you like the most?" / "What went wrong?"
  comment     text,
  anonymous   boolean NOT NULL DEFAULT false,
  hidden      boolean NOT NULL DEFAULT false,         -- hidden by a platform admin (spam, abuse)
  via         text NOT NULL DEFAULT 'call',           -- call | link (from the WhatsApp/email reminder)
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS reviews_user_unique ON reviews (user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reviews_email_unique ON reviews (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reviews_phone_unique ON reviews (phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS reviews_public_idx ON reviews (created_at DESC) WHERE NOT hidden;

-- Who has been asked. The first meeting creates the row; people who skip (or close the tab) get the
-- review link by WhatsApp/email once (sent_at), and the link's token lets them review without signing in.
CREATE TABLE IF NOT EXISTS review_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token       text NOT NULL UNIQUE,
  session_id  uuid REFERENCES sessions(id) ON DELETE SET NULL,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'guest',
  name        text NOT NULL,
  email       text,
  phone       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  skipped_at  timestamptz,
  sent_at     timestamptz,
  sent_status text
);
CREATE UNIQUE INDEX IF NOT EXISTS review_requests_user_unique ON review_requests (user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS review_requests_email_unique ON review_requests (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS review_requests_phone_unique ON review_requests (phone) WHERE phone IS NOT NULL;
