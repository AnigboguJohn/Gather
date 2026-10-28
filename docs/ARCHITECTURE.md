# Gather architecture (as built)

This is the code version of the "Gather: System Design" doc. It runs on one machine with Docker Compose
and splits cleanly into separate services later.

```
 Browser (React)  ──HTTPS/JSON──▶  app (Node, Express)            ──▶ PostgreSQL
   │   │                           ├─ core-api   (accounts, meetings, invites, billing, history)
   │   └──WebSocket (Socket.IO)──▶ ├─ signal     (hands, permissions, reactions, chat, polls, breakouts, 5-hour clock)
   │                               ├─ scheduler  (24 h and 15 min reminders, every minute)
   │                               ├─ notify     (WhatsApp Cloud API / wa.me links, email, SMS)
   │                               └─ summary job (after each meeting)          ──▶ ai (Python, FastAPI)
   │                                                                                 ├─ speech-to-text (Groq Whisper)
   └──WebRTC (audio, video, screen)──▶ LiveKit SFU ◀── server-side permission API    ├─ translation + summaries (Groq → Gemini)
                                                                                     └─ answers for "Ask your meetings"
```

## Where each design idea lives

| Design | Code |
|---|---|
| Meet now / Schedule, weekly series, time zones | `server/src/modules/meetings.routes.ts`, `server/src/lib/time.ts` |
| WhatsApp first, email second (with .ics), SMS | `server/src/lib/notify.ts`, `server/src/lib/messages.ts`, `server/src/lib/ics.ts` |
| Reminders 24 h and 15 min before | `server/src/modules/scheduler.ts` (`reminders_sent` makes it idempotent) |
| Guests join without an account; contact collected | `server/src/modules/join.routes.ts`, `web/src/pages/Join.tsx` |
| Camera free, mic locked until a raised hand is approved | `server/src/modules/rooms.ts` (`permsOf`, `hand.allow`) + `server/src/lib/livekit.ts` (LiveKit `canPublishSources`) |
| Screen sharing and presenting (approval, one presenter, pause/switch, 5 fps sharp text, 15 fps video mode) | `rooms.ts` (`share.*`), `web/src/room/useCall.ts` (`startShare`), `web/src/room/Room.tsx` (presenter view) |
| 7 reactions, chat, polls, moderation, co-hosts, waiting room, lock | `rooms.ts`, `web/src/room/Panels.tsx` |
| Breakout rooms | `rooms.ts` (`breakout.*` → new LiveKit room + token per person) |
| Free plan: meetings up to 5 hours (warnings at 15 and 5 min) | `rooms.ts` (`scheduleClock`), `server/src/lib/plans.ts`, `sessions.ends_at` |
| Data saver (~50 MB/h) and data meter | `web/src/room/useCall.ts` (simulcast, DTX, RED, selective video), `web/src/room/dataMeter.ts` |
| Live translated captions | `web/src/room/captions.ts` → `POST /api/rooms/captions` → `ai /transcribe` + `/translate` |
| Voice translation | `CaptionVoice` in `captions.ts` (device text-to-speech in the listener's language) |
| Summary + action items in each language, sent to attendees | `server/src/modules/summary.ts`, `ai/app/logic.py` |
| Attendance list + CSV | `meetings.routes.ts` |
| Payments (Paystack, Flutterwave, demo) | `server/src/modules/billing.routes.ts` |
| Calendar feed + Google Calendar sync | `server/src/modules/calendar.ts`, `extras.routes.ts` |
| Recordings | `web/src/room/recorder.ts` (host browser records the tab) → `POST /api/rooms/recordings` |
| Ask your meetings | `extras.routes.ts` (Postgres full-text search) → `ai /answer` |
| End-to-end encryption | `web/src/lib/e2ee.ts` (key in the link's `#k=` fragment, never sent to the server) + LiveKit E2EE worker |
| Phone dial-in | `server/src/modules/dialin.ts` (see DIAL_IN.md) |

## Simplifications for a single machine (and how to scale out)

- **One Node process** holds core-api, signal, scheduler and notify as modules. To scale: run signal
  separately and move its in-memory room state and rate limits to Redis (Socket.IO Redis adapter).
- **No NATS** yet: the summary job is called directly when a meeting ends. Swap the call in
  `endMeeting()` for a queue publish when you run several servers.
- **Search uses Postgres full-text search** instead of pgvector embeddings (no embedding API needed).
- **Recordings** are made in the host's browser. For large deployments use LiveKit Egress to S3.

## Security notes

- Sign-in codes and passcodes are stored only as HMAC/scrypt hashes; codes expire in 10 minutes and lock after 5 tries.
- Every query is scoped by `org_id`; members see only their own meetings, admins see the workspace.
- Room tickets (JWT) authorise sockets, captions and uploads; LiveKit enforces publish permissions server-side.
- Payment webhooks are verified (Paystack HMAC-SHA512, Flutterwave secret hash) and amounts are re-checked.
- CSV exports are protected against formula injection.
