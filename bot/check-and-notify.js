// check-and-notify.js
// Runs daily (GitHub Actions, 11 AM). Sends payment & spend-goal reminders, and at the
// statement date computes the cycle's cashback, posts it to Telegram, stores it in the
// card's 12-month history, and resets the cycle counters (balance revolves).

import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_KEY, TELEGRAM_TOKEN } = process.env;
if (!SUPABASE_URL || !SUPABASE_KEY || !TELEGRAM_TOKEN) {
  console.error("Missing env vars: SUPABASE_URL, SUPABASE_KEY, TELEGRAM_TOKEN");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);
const TG = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const today = new Date();
const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());

const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
const dateForDay = (y, m, day) => new Date(y, m, Math.min(day, daysInMonth(y, m)));
function nextDate(day) {
  let d = dateForDay(today.getFullYear(), today.getMonth(), day);
  if (d < startToday) d = dateForDay(today.getFullYear(), today.getMonth() + 1, day);
  return d;
}
const daysUntil = (d) => Math.round((d - startToday) / 86400000);
const fmtDate = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

const SYM = { AED: "AED ", INR: "₹", USD: "$", EUR: "€", GBP: "£", SAR: "SAR " };
const money = (n, c = "AED") => (SYM[c] || "AED ") + Math.round(Number(n) || 0).toLocaleString("en-US");

// cashback computation — mirrors the web app's engine
function computeCashback(card, spendByCat) {
  const rules = card.cashback_rules || { base: 1, minSpend: 0, rules: [] };
  const total = Object.values(spendByCat || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  if (rules.minSpend && total < rules.minSpend) return { total: 0, totalSpend: total, blocked: true };
  const map = {}; (rules.rules || []).forEach((r) => (map[r.category] = r));
  let cash = 0;
  for (const cat of Object.keys(spendByCat || {})) {
    const spent = Number(spendByCat[cat]) || 0;
    if (spent <= 0) continue;
    const rule = map[cat];
    const rate = rule ? rule.rate : (rules.base || 0);
    let cb = (spent * rate) / 100;
    if (rule && rule.cap > 0) cb = Math.min(cb, rule.cap);
    cash += cb;
  }
  return { total: cash, totalSpend: total, blocked: false };
}

async function send(chatId, text, cardId, kind) {
  if (!chatId) return;
  const reply_markup = kind ? {
    inline_keyboard: [[
      { text: "✅ Done", callback_data: `done:${kind}:${cardId}` },
      { text: "⏰ Snooze", callback_data: `snooze:${kind}:${cardId}` },
    ]],
  } : undefined;
  const res = await fetch(`${TG}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, reply_markup }),
  });
  if (!res.ok) console.error("Telegram error:", await res.text());
}

async function main() {
  const { data: cards, error } = await db.from("cards").select("*");
  if (error) { console.error(error); process.exit(1); }
  const thisMonth = today.getMonth();
  let sent = 0;

  for (const c of cards) {
    const cur = c.currency || "AED";

    // monthly reset of approval flags
    if (c.last_cycle_month !== thisMonth) {
      await db.from("cards").update({ payment_done: false, usage_done: false, last_cycle_month: thisMonth }).eq("id", c.id);
      c.payment_done = false; c.usage_done = false;
    }

    // statement day reached, once per cycle: compute cashback, store history, reset cycle
    const stmtDay = Math.min(c.statement_day, daysInMonth(today.getFullYear(), today.getMonth()));
    if (today.getDate() === stmtDay && c.last_statement_month !== thisMonth) {
      const cb = computeCashback(c, c.spend_by_cat || {});
      const entry = {
        month: today.toLocaleDateString("en-GB", { month: "short", year: "2-digit" }),
        totalSpend: cb.totalSpend, totalPaid: Number(c.cycle_paid) || 0,
        cashback: Math.round(cb.total), closedOn: today.toISOString().slice(0, 10),
      };
      const history = [entry, ...(c.history || [])].slice(0, 12);
      await db.from("cards").update({
        history, spend_by_cat: {}, cycle_spend: 0, cycle_paid: 0, last_statement_month: thisMonth,
      }).eq("id", c.id);

      const msg = cb.blocked
        ? `🧾 ${c.name} — statement closed.\nSpent ${money(cb.totalSpend, cur)} this cycle, below the minimum to earn cashback.`
        : `🧾 ${c.name} — statement closed.\nCashback earned: ${money(cb.total, cur)} on ${money(cb.totalSpend, cur)} spend.` +
          (c.cashback_rules?.needsVerify ? `\n(rates unverified — confirm with your bank)` : ``);
      await send(c.telegram_chat_id, msg, null, null);
      sent++;
      c.cycle_paid = 0; c.cycle_spend = 0; c.spend_by_cat = {};
    }

    const pay = nextDate(c.payment_day), dPay = daysUntil(pay);

    // payment reminder: from 7 days before the payment date, only if balance owed
    if (!c.payment_done && dPay >= 0 && dPay <= 7 && Number(c.balance) > 0) {
      const when = dPay === 0 ? "today" : `in ${dPay} day${dPay === 1 ? "" : "s"}`;
      await send(c.telegram_chat_id, `🔔 ${c.name}\nPayment due ${when} (${fmtDate(pay)}).\nBalance: ${money(c.balance, cur)}.`, c.id, "payment");
      sent++;
    }

    // spend-goal reminder: every day until the payment date, until the goal is hit
    const remaining = Math.max(0, Number(c.monthly_target) - Number(c.cycle_spend));
    if (!c.usage_done && remaining > 0 && dPay >= 0) {
      const when = dPay === 0 ? "today" : `in ${dPay} day${dPay === 1 ? "" : "s"}`;
      await send(c.telegram_chat_id,
        `💳 ${c.name}\nSpend ${money(remaining, cur)} more to hit your ${money(c.monthly_target, cur)} monthly goal (${money(c.cycle_spend, cur)} so far).\nPayment due ${when} (${fmtDate(pay)}).`,
        c.id, "usage");
      sent++;
    }
  }
  console.log(`Checked ${cards.length} cards, sent ${sent} messages at ${today.toISOString()}`);
}

main();
