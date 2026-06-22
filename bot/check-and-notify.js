// check-and-notify.js
// Runs once a day (via GitHub Actions at 11 AM). Loads every card, decides which
// reminders to send, and sends them to Telegram with Done / Snooze buttons.

import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_KEY, TELEGRAM_TOKEN } = process.env;

if (!SUPABASE_URL || !SUPABASE_KEY || !TELEGRAM_TOKEN) {
  console.error("Missing env vars. Need SUPABASE_URL, SUPABASE_KEY, TELEGRAM_TOKEN.");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);
const TG = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const today = new Date();
const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());

// next occurrence of a day-of-month, from today forward
function nextDate(day) {
  const d = new Date(today.getFullYear(), today.getMonth(), day);
  if (d < startOfToday) d.setMonth(d.getMonth() + 1);
  return d;
}
function daysUntil(date) {
  return Math.round((date - startOfToday) / 86400000);
}
const SYM = { AED: "AED ", INR: "₹", USD: "$", EUR: "€", GBP: "£", SAR: "SAR " };
const money = (n, cur = "AED") => (SYM[cur] || "AED ") + Math.round(Number(n) || 0).toLocaleString("en-US");
const stmtLabel = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

async function send(chatId, text, cardId, kind) {
  const reply_markup = {
    inline_keyboard: [[
      { text: "✅ Done", callback_data: `done:${kind}:${cardId}` },
      { text: "⏰ Snooze", callback_data: `snooze:${kind}:${cardId}` },
    ]],
  };
  const res = await fetch(`${TG}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, reply_markup }),
  });
  if (!res.ok) console.error("Telegram error:", await res.text());
}

async function main() {
  const { data: cards, error } = await db.from("cards").select("*");
  if (error) { console.error(error); process.exit(1); }

  const thisMonth = today.getMonth();

  for (const c of cards) {
    const cur = c.currency || "AED";

    // Reset payment/usage approval flags when a new month begins.
    if (c.last_cycle_month !== thisMonth) {
      await db.from("cards").update({
        payment_done: false, usage_done: false, last_cycle_month: thisMonth,
      }).eq("id", c.id);
      c.payment_done = false;
      c.usage_done = false;
    }

    // Statement rollover: once per cycle, on/after the statement day, reset the
    // per-cycle spend & payment counters. The outstanding BALANCE is left as-is,
    // so any unpaid amount revolves into the next cycle.
    const stmtPassed = today.getDate() >= c.statement_day;
    if (stmtPassed && c.last_statement_month !== thisMonth) {
      await db.from("cards").update({
        cycle_spend: 0, cycle_paid: 0, last_statement_month: thisMonth,
      }).eq("id", c.id);
      c.cycle_spend = 0;
      c.cycle_paid = 0;
    }

    const pay = nextDate(c.payment_day);
    const stmt = nextDate(c.statement_day);
    const dPay = daysUntil(pay);
    const dStmt = daysUntil(stmt);

    // 1) Payment reminder: 3 days before, daily until approved — only if money is owed.
    if (!c.payment_done && dPay >= 0 && dPay <= 3 && Number(c.balance) > 0) {
      const when = dPay === 0 ? "today" : `in ${dPay} day${dPay === 1 ? "" : "s"}`;
      await send(
        c.telegram_chat_id,
        `🔔 ${c.name}\nPayment due ${when} (${stmtLabel(pay)}).\n` +
        `Balance owed: ${money(c.balance, cur)}.`,
        c.id, "payment"
      );
    }

    // 2) Spend-goal reminder: 15 days before statement, if goal not yet hit.
    const remaining = Math.max(0, Number(c.monthly_target) - Number(c.cycle_spend));
    if (!c.usage_done && dStmt >= 0 && dStmt <= 15 && remaining > 0) {
      await send(
        c.telegram_chat_id,
        `💳 ${c.name}\n${dStmt} day${dStmt === 1 ? "" : "s"} to statement. ` +
        `Spend ${money(remaining, cur)} more to hit your ${money(c.monthly_target, cur)} goal ` +
        `(${money(c.cycle_spend, cur)} so far this cycle).`,
        c.id, "usage"
      );
    }
  }

  console.log(`Checked ${cards.length} cards at ${today.toISOString()}`);
}

main();
