// handle-button.js
// Handles taps on the ✅ Done / ⏰ Snooze buttons. Deploy as a serverless function
// (e.g. Vercel /api route) and register it as your Telegram webhook:
//   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://YOUR-APP.vercel.app/api/handle-button
//
// Vercel will run this as /api/handle-button. For other hosts, adapt the handler signature.

import { createClient } from "@supabase/supabase-js";

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}`;

export default async function handler(req, res) {
  try {
    const update = req.body;
    const cb = update.callback_query;
    if (!cb) return res.status(200).json({ ok: true });

    // callback_data is "action:kind:cardId", e.g. "done:payment:uuid"
    const [action, kind, cardId] = cb.data.split(":");

    if (action === "done") {
      const field = kind === "payment" ? "payment_done" : "usage_done";
      await db.from("cards").update({ [field]: true }).eq("id", cardId);
      await answer(cb.id, "Marked done ✅ — I'll stop reminding you this cycle.");
    } else if (action === "snooze") {
      // Snooze = do nothing; tomorrow's 11 AM run will remind again.
      await answer(cb.id, "Okay, I'll remind you again tomorrow ⏰");
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: true }); // always 200 so Telegram doesn't retry-storm
  }
}

async function answer(callbackId, text) {
  await fetch(`${TG}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text, show_alert: false }),
  });
}
