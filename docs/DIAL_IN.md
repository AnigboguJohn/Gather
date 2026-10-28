# Phone dial-in (LiveKit SIP)

People with no data can call a phone number, type the meeting PIN and join the audio.

1. **Get a phone number from a SIP provider** that serves your country (Africa's Talking, Twilio, Telnyx…)
   and point its SIP trunk at your LiveKit SIP service.
2. **Run LiveKit SIP** next to LiveKit (`livekit/sip` image; it needs Redis, so LiveKit must use the same Redis).
   See https://docs.livekit.io/sip/
3. **Create an inbound trunk** for your number (once):
   ```bash
   lk sip inbound create --name gather --numbers "+2341XXXXXXX"
   ```
   Copy the trunk ID it prints.
4. **Set in `.env`:**
   ```
   LIVEKIT_SIP_TRUNK_ID=ST_xxxxxxxx
   DIALIN_NUMBER=+234 1 XXX XXXX
   ```
5. Restart Gather. Every meeting already has a 6-digit PIN; Gather now creates a LiveKit dispatch rule per
   meeting (`roomName = meeting code`, `pin = PIN`), shows "No data? Call … PIN …" on invites and the join
   screen, and removes the rule when a meeting is cancelled.

Phone callers appear in the people list as "Phone caller" (via LiveKit webhooks) and in attendance
with "joined via: phone". Hosts can mute or remove them like anyone else.

This path needs a paid phone number, so it was not tested end to end; the PIN generation, rule creation
call and webhook handling are in `server/src/modules/dialin.ts` and `join.routes.ts`.
