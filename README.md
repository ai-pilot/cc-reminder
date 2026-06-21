# Card Reminder

An open-source credit-card payment & usage reminder app. Track up to as many cards as you
like, and get **Telegram** reminders:

- **Payment reminder** — pings you 3 days before each card's payment due date.
- **Usage reminder** — pings you 15 days before the statement date if you haven't hit the
  monthly spend target you set for that card.
- **Daily follow-up** — after a due/cutoff date passes, it keeps reminding you every day at
  **11:00 AM** until you tap **✅ Done**.
- **Approve each step** — every reminder has `✅ Done` / `⏰ Snooze` buttons. Nothing is marked
  handled until you approve it.

Self-hosted, free, and shareable: your friends either open your live link or fork and run
their own copy.

---

## What's inside

```
cc-reminder/
├── web/                          React tracker UI (deploy to Vercel/Netlify)
├── bot/                          Telegram reminder + webhook scripts
│   ├── check-and-notify.js       runs daily, sends reminders
│   └── handle-button.js          handles ✅ Done / ⏰ Snooze taps
├── supabase/schema.sql           database tables — paste into Supabase SQL editor
├── .github/workflows/reminder.yml  daily 11 AM cron (GitHub Actions)
├── .env.example                  copy to .env and fill in
├── LICENSE                       MIT
└── README.md
```

---

## Setup — step by step

You'll set up four free things: a database (Supabase), a Telegram bot, a daily scheduler
(GitHub Actions), and a host for the web app (Vercel). Total time ~30–40 minutes.

### Step 1 — Get the code on GitHub

```bash
git clone <this-repo-url> cc-reminder
cd cc-reminder
# or: create a new repo on github.com and push these files
```

### Step 2 — Create the database (Supabase)

1. Go to https://supabase.com → sign in → **New project**. Pick a name and a strong DB
   password. Wait ~2 min for it to spin up.
2. In the project, open **SQL Editor** → **New query**.
3. Open `supabase/schema.sql` from this repo, paste the whole thing, click **Run**.
4. Go to **Project Settings → API**. Copy two values for later:
   - **Project URL** → this is your `SUPABASE_URL`
   - **service_role** secret key → this is your `SUPABASE_KEY`
     (service_role is used only by the bot on the server, never in the browser.)

### Step 3 — Create the Telegram bot

1. In Telegram, search for **@BotFather** → start it → send `/newbot`.
2. Give it a name and a username ending in `bot`. BotFather replies with a **token** that
   looks like `123456:ABC-DEF...`. That's your `TELEGRAM_TOKEN`.
3. **Get your chat_id:** message your new bot anything (e.g. "hi"), then open this URL in a
   browser (paste your token in):
   `https://api.telegram.org/bot<TELEGRAM_TOKEN>/getUpdates`
   Find `"chat":{"id":123456789` — that number is your `chat_id`. You'll enter it in the web
   app when adding cards. Each friend repeats this once with the same bot.

### Step 4 — Configure secrets

Copy `.env.example` to `.env` and fill in the three values from steps 2–3:

```bash
cp .env.example .env
```

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_KEY=your-service-role-key
TELEGRAM_TOKEN=123456:ABC-DEF...
```

Test the reminder script locally:

```bash
cd bot
npm install
node check-and-notify.js
```

If a card qualifies for a reminder, you'll get a Telegram message. (Add a card first via the
web app, or insert a test row in Supabase → Table editor.)

### Step 5 — Schedule the daily 11 AM job (GitHub Actions)

1. On GitHub, open your repo → **Settings → Secrets and variables → Actions → New
   repository secret**. Add three secrets with the same names and values as your `.env`:
   `SUPABASE_URL`, `SUPABASE_KEY`, `TELEGRAM_TOKEN`.
2. The workflow in `.github/workflows/reminder.yml` is already set to run at **11:00 AM IST**
   (`30 5 * * *` in UTC, since IST = UTC+5:30). Change the cron line if you're in a different
   timezone — see the comment in the file.
3. Commit and push. Go to the **Actions** tab → you can click **Run workflow** to test it
   immediately instead of waiting for 11 AM.

### Step 6 — Deploy the web app (Vercel)

1. Go to https://vercel.com → **Add New → Project** → import your GitHub repo.
2. Set the **Root Directory** to `web`.
3. Add two **Environment Variables** (these are the public, browser-safe keys):
   - `VITE_SUPABASE_URL` = your Project URL
   - `VITE_SUPABASE_ANON_KEY` = the **anon public** key from Supabase → Settings → API
     (this one, NOT service_role — anon is safe in the browser)
4. Deploy. You get a live URL like `https://cc-reminder.vercel.app`. Share it with friends.

That's it. Add your cards in the web app, and the bot does the rest every morning.

---

## How the reminders are decided

Each morning the job loads every card and checks, per card:

| Reminder        | Fires when                                                              |
|-----------------|------------------------------------------------------------------------|
| Payment due     | payment date is 0–3 days away                                          |
| Monthly usage   | statement date is 0–15 days away **and** `used < monthly_target`       |
| Daily follow-up | a payment/statement date has passed and the card isn't marked `done`   |

Tapping **✅ Done** in Telegram sets the card's status to done for this cycle, so it stops
reminding. The status resets automatically when the next cycle begins.

---

## Sharing with friends

Two ways:

1. **Use your link.** Friends open your Vercel URL, message the same Telegram bot once to get
   their own `chat_id`, and enter it when adding their cards. Your one daily job reminds
   everyone.
2. **Fork it.** Friends who want full control fork the repo and run their own copy (their own
   Supabase, their own bot). Everything here is MIT licensed.

---

## Notes & limits

- GitHub Actions cron can run a few minutes late under load — 11 AM may mean 11:05. Fine for
  reminders.
- The Supabase free tier pauses after ~1 week of zero activity; the daily job keeps it awake.
- Day values use 1–28 to stay valid in every month.
- This app stores card metadata (names, limits, dates) — **never** card numbers, CVVs, or
  PINs. Don't add those.

## License

MIT — see `LICENSE`.
