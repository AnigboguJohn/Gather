-- Gather schema. Every table that holds customer data carries org_id or hangs off a meeting
-- that does, so each company's data stays separate.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS organizations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'individual' CHECK (kind IN ('individual','company')),
  country      text NOT NULL DEFAULT 'NG',
  data_region  text NOT NULL DEFAULT 'af-south-1',
  plan         text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','business')),
  paid_until   timestamptz,                        -- paid plan is active while now() < paid_until
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                text NOT NULL,
  email               text NOT NULL UNIQUE,
  phone               text,
  preferred_language  text NOT NULL DEFAULT 'en',
  role                text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  ics_token           text NOT NULL DEFAULT encode(gen_random_bytes(18), 'hex'),  -- private calendar feed
  google_refresh_token text,
  microsoft_refresh_token text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_org_idx ON users (org_id);

-- One-time codes: host sign-in and (optionally) guest contact verification. Only an HMAC is stored.
CREATE TABLE IF NOT EXISTS login_codes (
  id          bigserial PRIMARY KEY,
  email       text NOT NULL,
  purpose     text NOT NULL DEFAULT 'login',
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_codes_email_idx ON login_codes (email, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS meetings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  host_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug             text NOT NULL UNIQUE,                    -- the short code in the join link
  title            text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('instant','scheduled')),
  start_at         timestamptz NOT NULL,                    -- UTC
  duration_min     int NOT NULL DEFAULT 60,
  time_zone        text NOT NULL DEFAULT 'Africa/Lagos',
  repeat_rule      text NOT NULL DEFAULT 'none' CHECK (repeat_rule IN ('none','weekly')),
  languages        text[] NOT NULL DEFAULT '{en}',
  passcode_hash    text,
  waiting_room     boolean NOT NULL DEFAULT false,
  open_mic         boolean NOT NULL DEFAULT false,
  anyone_can_share boolean NOT NULL DEFAULT false,
  verify_guests    boolean NOT NULL DEFAULT false,         -- guests confirm their email with a code
  e2ee             boolean NOT NULL DEFAULT false,
  dialin_pin       text,
  status           text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','ended','cancelled')),
  calendar_refs    jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meetings_org_start_idx ON meetings (org_id, start_at);
CREATE UNIQUE INDEX IF NOT EXISTS meetings_dialin_idx ON meetings (dialin_pin) WHERE dialin_pin IS NOT NULL;

CREATE TABLE IF NOT EXISTS invitees (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id  uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  name        text,
  email       text,
  phone       text,
  language    text,
  token       text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(12), 'hex'),  -- personal invite link
  rsvp        text NOT NULL DEFAULT 'pending' CHECK (rsvp IN ('pending','yes','no')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invitees_meeting_idx ON invitees (meeting_id);

-- Which reminders went out for which occurrence (weekly series have many occurrences).
CREATE TABLE IF NOT EXISTS reminders_sent (
  meeting_id     uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  occurrence_at  timestamptz NOT NULL,
  kind           text NOT NULL,           -- '24h' | '15m'
  sent_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, occurrence_at, kind)
);

-- One session per time the room is actually used.
CREATE TABLE IF NOT EXISTS sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id    uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  started_at    timestamptz NOT NULL DEFAULT now(),
  ends_at       timestamptz NOT NULL,                  -- start + plan limit (5 hours on Free)
  ended_at      timestamptz,
  end_reason    text,
  summary       jsonb,
  summary_status text NOT NULL DEFAULT 'none'
);
CREATE INDEX IF NOT EXISTS sessions_meeting_idx ON sessions (meeting_id, started_at DESC);

CREATE TABLE IF NOT EXISTS participants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  identity         text NOT NULL,
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  name             text NOT NULL,
  email            text,
  phone            text,
  language         text NOT NULL DEFAULT 'en',
  role             text NOT NULL DEFAULT 'guest',
  consent_summary  boolean NOT NULL DEFAULT true,
  verified         boolean NOT NULL DEFAULT false,
  via              text NOT NULL DEFAULT 'web',       -- web | phone
  joined_at        timestamptz NOT NULL DEFAULT now(),
  left_at          timestamptz,
  UNIQUE (session_id, identity)
);

CREATE TABLE IF NOT EXISTS transcript_lines (
  id                bigserial PRIMARY KEY,
  session_id        uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  speaker_identity  text NOT NULL,
  speaker_name      text NOT NULL,
  lang              text NOT NULL,
  text              text NOT NULL,
  english           text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  tsv               tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(english,'') || ' ' || text)) STORED
);
CREATE INDEX IF NOT EXISTS transcript_session_idx ON transcript_lines (session_id, id);
CREATE INDEX IF NOT EXISTS transcript_tsv_idx ON transcript_lines USING gin (tsv);

CREATE TABLE IF NOT EXISTS chat_messages (
  id               bigserial PRIMARY KEY,
  session_id       uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sender_identity  text NOT NULL,
  sender_name      text NOT NULL,
  text             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS polls (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question    text NOT NULL,
  options     jsonb NOT NULL,
  closed      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id     uuid NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  identity    text NOT NULL,
  option_idx  int NOT NULL,
  PRIMARY KEY (poll_id, identity)
);

CREATE TABLE IF NOT EXISTS recordings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  file_name   text NOT NULL,
  size_bytes  bigint NOT NULL,
  mime        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  provider      text NOT NULL CHECK (provider IN ('paystack','flutterwave','demo')),
  reference     text NOT NULL UNIQUE,
  plan          text NOT NULL,
  months        int NOT NULL DEFAULT 1,
  amount_minor  bigint NOT NULL,          -- kobo / cents
  currency      text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed')),
  raw           jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  paid_at       timestamptz
);

-- Every invite, reminder and summary sent, so hosts can see delivery.
CREATE TABLE IF NOT EXISTS notifications (
  id          bigserial PRIMARY KEY,
  meeting_id  uuid REFERENCES meetings(id) ON DELETE CASCADE,
  channel     text NOT NULL,           -- email | whatsapp | sms
  to_addr     text NOT NULL,
  kind        text NOT NULL,           -- invite | reminder | update | cancel | summary | code
  status      text NOT NULL,           -- sent | failed | skipped
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
