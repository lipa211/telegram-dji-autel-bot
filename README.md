# Telegram DJI / Autel Bot

Next.js Telegram webhook bot with OpenAI and Supabase memory.

## Required environment variables
- `TELEGRAM_BOT_TOKEN`: Telegram bot token
- `TELEGRAM_WEBHOOK_SECRET`: nonempty secret sent by Telegram in `X-Telegram-Bot-Api-Secret-Token`
- `OPENAI_API_KEY`: OpenAI API key
- `SUPABASE_URL`: Supabase project URL
- `SUPABASE_SECRET_KEY`: server-side secret key; do not expose to the browser

## Deploy
1. Install dependencies with `npm ci`, then run `npm run build`.
2. Apply `supabase/migrations/20261118_telegram_processed_updates.sql` in the Supabase SQL editor.
3. Set the environment variables in the deployment platform.
4. Deploy the application.
5. Configure the Telegram webhook via authenticated `POST /api/setup-webhook` with `Authorization: Bearer <TELEGRAM_WEBHOOK_SECRET>`.
6. Verify the webhook URL and pending updates via `GET /api/webhook-info`.

## Webhook safety
- Invalid webhook secret: HTTP 401; missing configured secret: HTTP 503.
- Invalid JSON / missing numeric `update_id`: HTTP 400.
- A duplicated `update_id`: acknowledged without generating a second answer.
- Missing Supabase or insertion failure: HTTP 503 (fail closed), instead of processing without duplicate protection.
- This is **at-most-once claim processing**: an update is recorded *before* the expensive model request. If processing later fails, Telegram retries will be ignored. Guaranteed delivery would require a transactional queue, processing statuses, and a retry worker. Do not confuse deduplication with guaranteed delivery.
- Updates are stored indefinitely until a deliberate retention policy is implemented.
- Telegram messages longer than 4096 characters are shortened with a visible notice rather than failing silently.

## Manual verification checklist
- [ ] Valid signed message generates one answer
- [ ] Resend identical `update_id` and confirm no additional answer
- [ ] Invalid signature returns 401
- [ ] Missing signature returns 401
- [ ] Missing Supabase credentials returns 503
- [ ] Remove permission to insert into `telegram_processed_updates` and confirm 503
- [ ] Send a large answer and confirm it is shortened visibly
- [ ] Fail a diagnostic image upload and confirm the text answer is still delivered
- [ ] Confirm car side (left/right) and known model details are preserved in a multi-turn dialog

Do not deploy to production until database migration and live webhook tests are complete.

## Vehicle-memory regression cases
- Select car 1, save Kia Sportage / KM / 2WD / 2.0 / rear right; verify later question does not ask for those fields again.
- Select car 2, save another vehicle; switch back to car 1 and verify no data from car 2 appears.
- Write "задняя правая", "правая задняя", "сзади справа" and confirm rear-right; "передняя левая", "слева спереди" and confirm front-left.
- Mention two different sides in one message; verify the deterministic parser does not overwrite the saved side.
- Change an explicitly saved value (e.g. 4WD to 2WD) and verify the latest explicit message wins over automatic extraction.
- Ask about a drone while a car is selected; verify car memory is unchanged.
- Ask a diagnostic question with missing generation/drive; verify the useful diagnostic text is retained, with a warning before model-specific disassembly or torque values.
- Verify a user command /set side = ... updates only the selected car, and changing active cars keeps their facts separate.

These are regression scenarios for live validation, not a record of completed end-to-end tests.
