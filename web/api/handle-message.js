// handle-message.js
// Telegram webhook handler. Deploy as a Vercel serverless function at /api/handle-message
// and register it as your bot's webhook:
//   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://YOUR-APP.vercel.app/api/handle-message
//
// Handles, in one place (a bot can only have ONE webhook):
//  1) Text — Gemini decides if it's an ACTION (log a spend/payment, delete the last one)
//     or a QUESTION ("this month spend till date?", "cashback on ADCB?", "last 5 spends?").
//     Questions are answered straight from a data snapshot we build below.
//  2) Button taps — spend/payment confirmations + the ✅ Done / ⏰ Snooze reminder buttons.
//
// Env vars needed on Vercel: SUPABASE_URL, SUPABASE_KEY, TELEGRAM_TOKEN, GEMINI_API_KEY

import { createClient } from "@supabase/supabase-js";

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}`;
const GEMINI_MODEL = "gemini-2.5-flash"; // update to whatever model your AI Studio key supports

const CATEGORIES = ["Groceries","Dining","Travel","Fuel","Shopping","Online","Bills & Utilities","Education","Entertainment","International","Other"];
const CONFIDENCE_THRESHOLD = 0.7; // auto-log a spend at/above this, otherwise ask

const SYM = { AED:"AED ", INR:"₹", USD:"$", EUR:"€", GBP:"£", SAR:"SAR " };
const money = (n,c="AED") => (SYM[c]||"AED ") + Math.round(Number(n)||0).toLocaleString("en-US");
const num = (x) => Number(x) || 0;

/* ---------- dates (month-end aware, mirrors the web app & cron) ---------- */
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

export default async function handler(req, res) {
  try {
    const u = req.body;
    if (u.callback_query) await onButton(u.callback_query);
    else if (u.message && u.message.text) await onText(u.message);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: true }); // always 200 so Telegram doesn't retry-storm
  }
}

async function tg(method, body) {
  const r = await fetch(`${TG}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) console.error("TG error", method, await r.text());
  return r.json();
}
const tgAnswer = (id, text) => tg("answerCallbackQuery", { callback_query_id: id, text, show_alert: false });
const say = (chatId, text, reply_markup) => tg("sendMessage", { chat_id: chatId, text, reply_markup });

// ──────────────────────────────────────────────────────────────────────────
// incoming text: an action (log/delete) or a question
// ──────────────────────────────────────────────────────────────────────────
async function onText(msg) {
  const chatId = String(msg.chat.id);
  const text = msg.text.trim();

  if (text === "/start") {
    return say(chatId,
      "Forward me a bank SMS and I'll log the spend. You can also tell me things like " +
      "\"paid 500 on ADCB\" or \"delete last payment\", and ask \"this month spend till date?\", " +
      "\"cashback on ADCB Traveller?\", \"last 5 spends?\".\n\n" +
      "Your Telegram chat ID is: " + chatId + "\n(enter this on each card in the app so reminders reach you.)");
  }

  const { data: cards } = await db.from("cards").select("*").eq("telegram_chat_id", chatId);
  if (!cards || cards.length === 0) {
    return say(chatId, "I don't have any cards linked to this chat yet. In the app, add your Telegram chat ID (" + chatId + ") to a card first.");
  }

  // recent ledger for these cards, used both as context for questions and for "last N spends"
  const cardIds = cards.map((c) => c.id);
  const { data: txns } = await db.from("transactions")
    .select("*").in("card_id", cardIds).order("created_at", { ascending: false }).limit(200);

  const snapshot = buildSnapshot(cards, txns || []);
  const result = await askGemini(text, cards, snapshot);
  if (!result) return say(chatId, "Sorry, I had trouble with that. Try again, or forward a bank SMS to log a spend.");

  const act = result.action || { type: "none" };
  switch (act.type) {
    case "log_spend":          return handleLogSpend(chatId, cards, act);
    case "log_payment":        return handleLogPayment(chatId, cards, act);
    case "delete_last_spend":  return handleDeleteLast(chatId, cards, act, "spend");
    case "delete_last_payment":return handleDeleteLast(chatId, cards, act, "payment");
    default: {
      const answer = (result.answer || "").trim();
      return say(chatId, answer ||
        "I'm not sure how to help with that. Forward a bank SMS to log a spend, or ask about your balance, spends this month, or cashback.");
    }
  }
}

function matchCard(cards, guess, last4) {
  if (last4) { const c = cards.find((x) => x.last4 && x.last4 === last4); if (c) return c; }
  if (guess) { const c = cards.find((x) => x.name.toLowerCase().includes(String(guess).toLowerCase())); if (c) return c; }
  if (cards.length === 1) return cards[0];
  return null;
}

async function handleLogSpend(chatId, cards, p) {
  const amt = Math.round(Number(p.amount) || 0);
  if (!amt) return say(chatId, "I couldn't read a spend amount. You can also type e.g. \"240 groceries FAB\".");
  const card = matchCard(cards, p.cardGuess, p.last4);
  const confident = (Number(p.confidence) || 0) >= CONFIDENCE_THRESHOLD && card && p.category;

  if (confident) {
    await recordSpend(card, p.category, amt, p.merchant);
    return say(chatId,
      `✅ Logged ${money(amt, card.currency)} at ${p.merchant || "merchant"} → ${p.category} on ${card.name}.`,
      { inline_keyboard: [[{ text: "↩️ Undo", callback_data: `undo:${card.id}:spend` }]] });
  }
  if (!card) {
    return say(chatId, `${money(amt)} at ${p.merchant || "merchant"} — which card?`,
      { inline_keyboard: cards.map((c) => [{ text: c.name, callback_data: `pick:${c.id}:${amt}:${p.category || "Other"}` }]) });
  }
  return say(chatId, `${money(amt, card.currency)} at ${p.merchant || "merchant"} on ${card.name} — which category?`,
    { inline_keyboard: chunk(CATEGORIES.map((cat) => ({ text: cat, callback_data: `cat:${card.id}:${amt}:${cat}` })), 2) });
}

async function handleLogPayment(chatId, cards, p) {
  const amt = Math.round(Number(p.amount) || 0);
  if (!amt) return say(chatId, "How much was the payment? e.g. \"paid 500 on ADCB\".");
  const card = matchCard(cards, p.cardGuess, null);
  if (!card) {
    return say(chatId, `Payment of ${money(amt)} — which card?`,
      { inline_keyboard: cards.map((c) => [{ text: c.name, callback_data: `paypick:${c.id}:${amt}` }]) });
  }
  const { balance } = await recordPayment(card, amt);
  return say(chatId,
    `✅ Logged payment of ${money(amt, card.currency)} on ${card.name}. Balance now ${money(balance, card.currency)}.`,
    { inline_keyboard: [[{ text: "↩️ Undo", callback_data: `undo:${card.id}:payment` }]] });
}

async function handleDeleteLast(chatId, cards, p, kind) {
  const card = matchCard(cards, p.cardGuess, null);
  if (!card) {
    return say(chatId, `Which card's last ${kind} should I delete?`,
      { inline_keyboard: cards.map((c) => [{ text: c.name, callback_data: `del${kind}:${c.id}` }]) });
  }
  const removed = await deleteLastTxn(card, kind);
  if (!removed) return say(chatId, `No ${kind}s found on ${card.name} to delete.`);
  const label = kind === "spend"
    ? `${money(removed.amount, card.currency)}${removed.category ? " → " + removed.category : ""}`
    : `${money(removed.amount, card.currency)} payment`;
  return say(chatId, `🗑️ Deleted the last ${kind} on ${card.name}: ${label}.`);
}

// ──────────────────────────────────────────────────────────────────────────
// button taps. Branch on the action token first — the formats differ:
//   done|snooze : kind : cardId           (from the daily reminder cron)
//   pick|cat    : cardId : amount : category
//   paypick     : cardId : amount
//   undo        : cardId : (spend|payment)
//   delspend|delpayment : cardId
// ──────────────────────────────────────────────────────────────────────────
async function onButton(cb) {
  const chatId = String(cb.message.chat.id);
  const parts = cb.data.split(":");
  const action = parts[0];

  // reminder buttons: done|snooze : kind : cardId
  if (action === "snooze") return tgAnswer(cb.id, "Okay, I'll remind you again tomorrow ⏰");
  if (action === "done") {
    const kind = parts[1], cardId = parts[2];
    const field = kind === "payment" ? "payment_done" : "usage_done";
    await db.from("cards").update({ [field]: true }).eq("id", cardId);
    return tgAnswer(cb.id, "Marked done ✅ — I'll stop reminding you this cycle.");
  }

  // everything else needs the card (id is always the 2nd field)
  const cardId = parts[1];
  const { data: cards } = await db.from("cards").select("*").eq("id", cardId);
  const card = cards && cards[0];
  if (!card) return tgAnswer(cb.id, "That card is no longer available.");

  if (action === "pick" || action === "cat") {
    const amount = Number(parts[2]) || 0;
    const category = parts[3] || "Other";
    await recordSpend(card, category, amount, null);
    await tgAnswer(cb.id, "Logged.");
    return tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id,
      text: `✅ Logged ${money(amount, card.currency)} → ${category} on ${card.name}.`,
      reply_markup: { inline_keyboard: [[{ text: "↩️ Undo", callback_data: `undo:${card.id}:spend` }]] } });
  }
  if (action === "paypick") {
    const amount = Number(parts[2]) || 0;
    const { balance } = await recordPayment(card, amount);
    await tgAnswer(cb.id, "Payment logged.");
    return tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id,
      text: `✅ Logged payment of ${money(amount, card.currency)} on ${card.name}. Balance now ${money(balance, card.currency)}.` });
  }
  if (action === "undo") {
    const kind = parts[2] === "payment" ? "payment" : "spend";
    const removed = await deleteLastTxn(card, kind);
    await tgAnswer(cb.id, removed ? "Reversed." : "Nothing to undo.");
    return tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id,
      text: removed ? `↩️ Reversed that ${kind}.` : "Nothing to undo." });
  }
  if (action === "delspend" || action === "delpayment") {
    const kind = action === "delspend" ? "spend" : "payment";
    const removed = await deleteLastTxn(card, kind);
    await tgAnswer(cb.id, removed ? "Deleted." : "Nothing to delete.");
    return tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id,
      text: removed ? `🗑️ Deleted the last ${kind} on ${card.name}.` : `No ${kind}s to delete on ${card.name}.` });
  }
  return tgAnswer(cb.id, "Okay.");
}

// ──────────────────────────────────────────────────────────────────────────
// ledger mutations: keep the card aggregates and the transactions table in sync
// ──────────────────────────────────────────────────────────────────────────
async function recordSpend(card, category, amount, merchant) {
  const amt = Math.abs(Math.round(Number(amount) || 0));
  const monthKey = new Date().toISOString().slice(0, 7);
  const sameMonth = card.month_spend_key === monthKey;
  const sbc = { ...(card.spend_by_cat || {}) };
  sbc[category] = Math.max(0, (Number(sbc[category]) || 0) + amt);
  const balance = Math.max(0, num(card.balance) + amt);
  await db.from("cards").update({
    spend_by_cat: sbc,
    cycle_spend: Math.max(0, num(card.cycle_spend) + amt),
    balance,
    month_spend: Math.max(0, (sameMonth ? num(card.month_spend) : 0) + amt),
    month_spend_key: monthKey,
  }).eq("id", card.id);
  await db.from("transactions").insert({
    card_id: card.id, owner: card.owner, type: "spend", category, merchant: merchant || null, amount: amt,
  });
  return { balance };
}

async function recordPayment(card, amount) {
  const amt = Math.abs(Math.round(Number(amount) || 0));
  const balance = Math.max(0, num(card.balance) - amt);
  await db.from("cards").update({
    cycle_paid: Math.max(0, num(card.cycle_paid) + amt),
    balance,
  }).eq("id", card.id);
  await db.from("transactions").insert({
    card_id: card.id, owner: card.owner, type: "payment", amount: amt,
  });
  return { balance };
}

// delete the most recent transaction of a kind and reverse its effect on the card
async function deleteLastTxn(card, kind) {
  const { data: rows } = await db.from("transactions")
    .select("*").eq("card_id", card.id).eq("type", kind)
    .order("created_at", { ascending: false }).limit(1);
  const t = rows && rows[0];
  if (!t) return null;
  await db.from("transactions").delete().eq("id", t.id);
  const amt = Math.abs(Number(t.amount) || 0);

  if (kind === "spend") {
    const monthKey = new Date().toISOString().slice(0, 7);
    const sameMonth = card.month_spend_key === monthKey;
    const sbc = { ...(card.spend_by_cat || {}) };
    if (t.category) sbc[t.category] = Math.max(0, (Number(sbc[t.category]) || 0) - amt);
    await db.from("cards").update({
      spend_by_cat: sbc,
      cycle_spend: Math.max(0, num(card.cycle_spend) - amt),
      balance: Math.max(0, num(card.balance) - amt),
      month_spend: sameMonth ? Math.max(0, num(card.month_spend) - amt) : num(card.month_spend),
    }).eq("id", card.id);
  } else {
    await db.from("cards").update({
      cycle_paid: Math.max(0, num(card.cycle_paid) - amt),
      balance: Math.max(0, num(card.balance) + amt),
    }).eq("id", card.id);
  }
  return t;
}

// ──────────────────────────────────────────────────────────────────────────
// the data snapshot Gemini answers questions from (all figures pre-computed)
// ──────────────────────────────────────────────────────────────────────────
function buildSnapshot(cards, txns) {
  const monthPrefix = new Date().toISOString().slice(0, 7); // "2026-06"
  const byCard = {};
  for (const t of txns) (byCard[t.card_id] ||= []).push(t);

  return cards.map((c) => {
    const cur = c.currency || "AED";
    const list = byCard[c.id] || [];
    const thisMonthSpend = list
      .filter((t) => t.type === "spend" && String(t.created_at).slice(0, 7) === monthPrefix)
      .reduce((a, t) => a + Math.abs(Number(t.amount) || 0), 0);
    const cb = computeCashback(c, c.spend_by_cat || {});
    const pay = nextDate(c.payment_day), stmt = nextDate(c.statement_day);
    return {
      card: c.name,
      currency: cur,
      last4: c.last4 || null,
      creditLimit: num(c.credit_limit),
      balanceOwed: num(c.balance),
      availableCredit: Math.max(0, num(c.credit_limit) - num(c.balance)),
      monthlyGoal: num(c.monthly_target),
      spentThisCycle: num(c.cycle_spend),
      remainingToGoal: Math.max(0, num(c.monthly_target) - num(c.cycle_spend)),
      paidThisCycle: num(c.cycle_paid),
      spentThisCalendarMonth: Math.round(thisMonthSpend),
      spendByCategoryThisCycle: c.spend_by_cat || {},
      cashbackThisCycle: Math.round(cb.total),
      cashbackBlockedByMinSpend: !!cb.blocked,
      statementDate: fmtDate(stmt), daysToStatement: daysUntil(stmt),
      paymentDate: fmtDate(pay), daysToPayment: daysUntil(pay),
      recentTransactions: list.slice(0, 15).map((t) => ({
        when: String(t.created_at).slice(0, 10),
        type: t.type,
        category: t.category || null,
        merchant: t.merchant || null,
        amount: Math.abs(Number(t.amount) || 0),
      })),
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Gemini: classify into an action or answer a question from the snapshot
// ──────────────────────────────────────────────────────────────────────────
async function askGemini(text, cards, snapshot) {
  const knownLast4 = cards.filter((c) => c.last4).map((c) => c.last4);
  const cardNames = cards.map((c) => c.name);
  const todayStr = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  const prompt =
`You are a helpful assistant inside a credit-card tracking Telegram bot.
Today is ${todayStr}.
The user's cards and current figures (already computed for you — do NOT recompute dates or totals):
${JSON.stringify(snapshot, null, 2)}

Known card last-4 digits: ${JSON.stringify(knownLast4)}.
Known card names: ${JSON.stringify(cardNames)}.
Spend categories: ${JSON.stringify(CATEGORIES)}.

Decide what the user's message means and return JSON with "answer" and "action".

Use an ACTION (set action.type, leave answer ""), when the user wants to change data:
- "log_spend": a forwarded bank SMS or a quick entry like "240 groceries FAB". Fill amount, merchant, last4 (if present), cardGuess (closest known card name or ""), category (best from the list), and confidence 0..1.
- "log_payment": the user says they paid/settled a card, e.g. "paid 500 on adcb". Fill amount and cardGuess.
- "delete_last_spend" / "delete_last_payment": the user wants to remove or undo their most recent spend or payment. Fill cardGuess if they named a card.

Otherwise it is a QUESTION: set action.type to "none" and write a short, friendly reply in "answer", using ONLY the data above. Mappings: "this month spend (till date)" = spentThisCalendarMonth; "cashback" = cashbackThisCycle; "balance / owe" = balanceOwed; "available" = availableCredit; "goal left" = remainingToGoal; "last N spends on X" = that card's recentTransactions filtered to type spend. Format money using each card's currency. If the data doesn't contain what's asked, say so briefly.

User message: """${text}"""`;

  const schema = {
    type: "object",
    properties: {
      answer: { type: "string" },
      action: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["none","log_spend","log_payment","delete_last_spend","delete_last_payment"] },
          amount: { type: "number" },
          merchant: { type: "string" },
          last4: { type: "string" },
          cardGuess: { type: "string" },
          category: { type: "string", enum: CATEGORIES },
          confidence: { type: "number" },
        },
        required: ["type"],
      },
    },
    required: ["answer", "action"],
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0 },
    }),
  });
  if (!r.ok) { console.error("Gemini error", await r.text()); return null; }
  const data = await r.json();
  const out = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  try { return JSON.parse(out); } catch { return null; }
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
