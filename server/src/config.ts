/**
 * All settings come from environment variables (see .env.example at the repo root).
 * Anything optional (WhatsApp, SMS, payments, calendar, dial-in) switches itself off when its keys are empty,
 * so the app always runs locally with zero paid accounts.
 */
// Load .env into process.env before anything below reads it.
import "./env.js";

// Readers for string / number / boolean settings, each with a default.
const env = (k: string, d = "") => (process.env[k]?.trim() || d).trim(); // empty = not set
const num = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);
const bool = (k: string, d = false) => (process.env[k] ? ["1", "true", "yes"].includes(process.env[k]!.toLowerCase()) : d);

/** Every setting the server uses, read once at startup. Import { config } instead of reading process.env. */
export const config = {
  port: num("PORT", 8080),
  appUrl: env("APP_URL", "http://localhost:8080").replace(/\/$/, ""),
  databaseUrl: env("DATABASE_URL", "postgres://gather:gather@localhost:5432/gather"),
  // Signs session tokens and room tickets. MUST be changed to a long random value in production.
  jwtSecret: env("JWT_SECRET", "dev-only-change-me-please-32-chars-min"),
  // HMAC key for one-time codes (codes are stored hashed with it).
  codeSecret: env("CODE_SECRET", "dev-only-code-secret"),
  devShowCodes: bool("DEV_SHOW_CODES", true), // print sign-in codes in the server log (local testing)
  // Folder of the built React app that the server also serves.
  webDist: env("WEB_DIST", "../web/dist"),
  // Where recordings are stored on disk.
  dataDir: env("DATA_DIR", "./data"),

  // LiveKit media server: browsers use `url`; the server calls `apiUrl` to change permissions, mute, remove.
  livekit: {
    url: env("LIVEKIT_URL", "ws://localhost:7880"), // what browsers connect to
    apiUrl: env("LIVEKIT_API_URL", "http://localhost:7880"), // what the server calls
    apiKey: env("LIVEKIT_API_KEY", "devkey"),
    apiSecret: env("LIVEKIT_API_SECRET", "secret-for-local-dev-only-0123456789"),
    sipTrunkId: env("LIVEKIT_SIP_TRUNK_ID"),
  },
  dialinNumber: env("DIALIN_NUMBER"), // e.g. +234 1 700 0000, shown to guests when set

  aiUrl: env("AI_URL", "http://localhost:8001"),

  // Plans: Free meetings last up to 2 hours (120 minutes).
  freeMeetingMinutes: num("FREE_MEETING_MINUTES", 120),
  paidMeetingMinutes: num("PAID_MEETING_MINUTES", 1440),
  // Warn everyone this many minutes before the plan limit ends the meeting (default 15 and 5).
  warnBeforeMinutes: env("WARN_BEFORE_MINUTES", "15,5").split(",").map(Number).filter((n) => n > 0),
  // After the last person leaves, wait this long before ending the meeting (they may just be reconnecting).
  emptyRoomGraceSeconds: num("EMPTY_ROOM_GRACE_SECONDS", 120),

  // Email. Locally this is Mailpit (test inbox on http://localhost:8025).
  smtp: {
    host: env("SMTP_HOST", "localhost"),
    port: num("SMTP_PORT", 1025),
    user: env("SMTP_USER"),
    pass: env("SMTP_PASS"),
    from: env("MAIL_FROM", "Gather <no-reply@gather.local>"),
  },
  // WhatsApp Cloud API (optional). Empty = hosts get wa.me click-to-send links instead.
  whatsapp: {
    token: env("WHATSAPP_TOKEN"),
    phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"),
    apiVersion: env("WHATSAPP_API_VERSION", "v21.0"),
  },
  sms: {
    // Africa's Talking (works across Nigeria, Kenya, Ghana...). Username "sandbox" uses their free sandbox.
    username: env("AT_USERNAME"),
    apiKey: env("AT_API_KEY"),
    senderId: env("AT_SENDER_ID"),
  },
  // Payment providers (optional). Test keys work.
  paystack: { secretKey: env("PAYSTACK_SECRET_KEY") },
  flutterwave: { secretKey: env("FLW_SECRET_KEY"), webhookHash: env("FLW_WEBHOOK_HASH") },
  demoPayments: bool("DEMO_PAYMENTS", true), // a fake checkout when no payment keys are set
  // Calendar sync OAuth apps (optional).
  google: { clientId: env("GOOGLE_CLIENT_ID"), clientSecret: env("GOOGLE_CLIENT_SECRET") },
  microsoft: { clientId: env("MS_CLIENT_ID"), clientSecret: env("MS_CLIENT_SECRET") },
};

/** Type of the settings object (handy for helpers and tests). */
export type Config = typeof config;
