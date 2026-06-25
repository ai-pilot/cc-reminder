// handle-message.js
// Telegram webhook handler. Deploy as a Vercel serverless function at /api/handle-message
// and register it as your bot's webhook:
//   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://YOUR-APP.vercel.app/api/handle-message
//
// Handles:
//  1) Forwarded/pasted bank SMS  -> Gemini parses it -> auto-log if confident, else ask.
//  2) Button taps (✅ confirm / ✏️ change category / ❌ cancel, and undo).
//
// Env vars needed on Vercel: SUPABASE_URL, SUPABASE_KEY, TELEGRAM_TOKEN, GEMINI_API_KEY

import { createClient } from "@supabase/supabase-js";

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}`;
const GEMINI_MODEL = "gemini-3.5-flash"; // update to whatever model your AI Studio key supports

const CATEGORIES = ["Groceries","Dining","Travel","Fuel","Shopping","Online","Bills & Utilities","Education","Entertainment","International","Other"];
const CONFIDENCE_THRESHOLD = 0.7; // auto-log at/above this, ask below

const SYM = { AED:"AED ", INR:"₹", USD:"$", EUR:"€", GBP:"£", SAR:"SAR " };
const money = (n,c="AED") => (SYM[c]||"AED ") + Math.round(Number(n)||0).toLocaleString("en-US");

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

// ---- incoming text (a forwarded SMS, or a command) ----
async function onText(msg) {
  const chatId = String(msg.chat.id);
  const text = msg.text.trim();

  if (text === "/start") {
    return tg("sendMessage", { chat_id: chatId, text:
      "Forward me a bank SMS and I'll log the spend automatically.\n\n" +
      "Your Telegram chat ID is: " + chatId + "\n(enter this on each card in the app so reminders reach you.)" });
  }

  // find this user's cards by their telegram chat id
  const { data: cards } = await db.from("cards").select("*").eq("telegram_chat_id", chatId);
  if (!cards || cards.length === 0) {
    return tg("sendMessage", { chat_id: chatId, text:
      "I don't have any cards linked to this chat yet. In the app, add your Telegram chat ID (" + chatId + ") to a card first." });
  }

  const parsed = await parseSMS(text, cards);
  if (!parsed || !parsed.amount) {
    return tg("sendMessage", { chat_id: chatId, text: "I couldn't read a spend from that. You can also type e.g. \"240 groceries FAB\"." });
  }

  // match card: prefer last4, then bank-name guess from Gemini
  let card = null;
  if (parsed.last4) card = cards.find((c) => c.last4 && c.last4 === parsed.last4);
  if (!card && parsed.cardGuess) card = cards.find((c) => c.name.toLowerCase().includes(parsed.cardGuess.toLowerCase()));

  const confident = parsed.confidence >= CONFIDENCE_THRESHOLD && card && parsed.category;

  if (confident) {
    await logSpend(card, parsed.category, parsed.amount);
    return tg("sendMessage", {
      chat_id: chatId,
      text: `✅ Logged ${money(parsed.amount, card.currency)} at ${parsed.merchant || "merchant"} → ${parsed.category} on ${card.name}.`,
      reply_markup: { inline_keyboard: [[{ text: "↩️ Undo", callback_data: `undo:${card.id}:${Math.round(parsed.amount)}:${parsed.category}` }]] },
    });
  }

  // not confident -> ask. Stash the parse in the buttons.
  const amt = Math.round(parsed.amount);
  if (!card) {
    // ask which card
    return tg("sendMessage", {
      chat_id: chatId,
      text: `${money(amt)} at ${parsed.merchant || "merchant"} — which card?`,
      reply_markup: { inline_keyboard: cards.map((c) => [{ text: c.name, callback_data: `pick:${c.id}:${amt}:${parsed.category || "Other"}` }]) },
    });
  }
  // have card, ask category
  return tg("sendMessage", {
    chat_id: chatId,
    text: `${money(amt, card.currency)} at ${parsed.merchant || "merchant"} on ${card.name} — which category?`,
    reply_markup: { inline_keyboard: chunk(CATEGORIES.map((cat) => ({ text: cat, callback_data: `cat:${card.id}:${amt}:${cat}` })), 2) },
  });
}

// ---- button taps ----
async function onButton(cb) {
  const chatId = String(cb.message.chat.id);
  const [action, cardId, amtStr, category] = cb.data.split(":");
  const amount = Number(amtStr) || 0;
  const { data: cards } = await db.from("cards").select("*").eq("id", cardId);
  const card = cards && cards[0];

  if (action === "undo" && card) {
    await logSpend(card, category, -amount); // reverse
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Reversed." });
    return tg("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: "↩️ Reversed that entry." });
  }
  if ((action === "pick" || action === "cat") && card) {
    await logSpend(card, category, amount);
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Logged." });
    return tg("editMessageText", {
      chat_id: chatId, message_id: cb.message.message_id,
      text: `✅ Logged ${money(amount, card.currency)} → ${category} on ${card.name}.`,
    });
  }
  // existing payment/usage Done/Snooze still handled here
  if (action === "done" && card) {
    const field = category === "payment" ? "payment_done" : "usage_done"; // category slot holds kind here
    await db.from("cards").update({ [field]: true }).eq("id", cardId);
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Marked done ✅" });
    return;
  }
  await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Okay." });
}

// ---- apply a spend to a card (also updates monthly total) ----
async function logSpend(card, category, amount) {
  const monthKey = new Date().toISOString().slice(0, 7); // "2026-06"
  const sameMonth = card.month_spend_key === monthKey;
  const sbc = { ...(card.spend_by_cat || {}) };
  sbc[category] = Math.max(0, (Number(sbc[category]) || 0) + amount);

  await db.from("cards").update({
    spend_by_cat: sbc,
    cycle_spend: Math.max(0, Number(card.cycle_spend) + amount),
    balance: Math.max(0, Number(card.balance) + amount),
    month_spend: Math.max(0, (sameMonth ? Number(card.month_spend) : 0) + amount),
    month_spend_key: monthKey,
  }).eq("id", card.id);
}

// ---- Gemini: extract structured spend from an SMS ----
async function parseSMS(text, cards) {
  const knownLast4 = cards.filter((c) => c.last4).map((c) => c.last4);
  const cardNames = cards.map((c) => c.name);
  const prompt =
    `You extract a credit-card spend from a bank SMS alert. Return ONLY JSON.\n` +
    `Known card last-4 digits: ${JSON.stringify(knownLast4)}.\n` +
    `Known card names: ${JSON.stringify(cardNames)}.\n` +
    `Categories to choose from: ${JSON.stringify(CATEGORIES)}.\n` +
    `From the SMS, identify the amount (number only), the merchant name, the last 4 card ` +
    `digits if present, the best-matching card name from the known list (or null), the most ` +
    `likely category from the list, and a confidence 0..1 for the overall extraction.\n` +
    `SMS: """${text}"""`;

  const schema = {
    type: "object",
    properties: {
      amount: { type: "number" },
      merchant: { type: "string" },
      last4: { type: "string" },
      cardGuess: { type: "string" },
      category: { type: "string", enum: CATEGORIES },
      confidence: { type: "number" },
    },
    required: ["amount", "category", "confidence"],
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
