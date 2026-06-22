import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase.js";

/* ---------- currency ---------- */
const CURRENCIES = {
  AED: { symbol: "AED", locale: "en-AE" },
  INR: { symbol: "₹", locale: "en-IN" },
  USD: { symbol: "$", locale: "en-US" },
  EUR: { symbol: "€", locale: "en-IE" },
  GBP: { symbol: "£", locale: "en-GB" },
  SAR: { symbol: "SAR", locale: "en-SA" },
};
function money(n, cur = "AED") {
  const c = CURRENCIES[cur] || CURRENCIES.AED;
  const v = Math.round(Number(n) || 0).toLocaleString(c.locale);
  return c.symbol.length > 1 ? `${c.symbol} ${v}` : `${c.symbol}${v}`;
}

/* ---------- bank colors (text name only, no logos) ---------- */
const BANK_COLORS = {
  fab: "#0d3b66", adcb: "#8a1538", emirates: "#d71920", enbd: "#d71920",
  mashreq: "#f5821f", rakbank: "#e30613", dib: "#006a4e", adib: "#00529b",
  hdfc: "#004b8d", axis: "#97144d", sbi: "#22409a", icici: "#ae282e",
  amex: "#2e77bb", hsbc: "#db0011", citi: "#003b70",
};
function bankColor(name = "") {
  const n = name.toLowerCase();
  for (const k in BANK_COLORS) if (n.includes(k)) return BANK_COLORS[k];
  // stable fallback color from the name
  let h = 0; for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) % 360;
  return `hsl(${h}, 42%, 32%)`;
}

/* ---------- dates ---------- */
const today = new Date();
const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
function nextDate(day) {
  const d = new Date(today.getFullYear(), today.getMonth(), day);
  if (d < startOfToday) d.setMonth(d.getMonth() + 1);
  return d;
}
const daysUntil = (date) => Math.round((date - startOfToday) / 86400000);
const fmtDate = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/* ---------- number formatting for inputs ---------- */
const groupNum = (s) => {
  const digits = String(s).replace(/[^\d]/g, "");
  if (!digits) return "";
  return Number(digits).toLocaleString("en-US");
};
const parseNum = (s) => Number(String(s).replace(/[^\d]/g, "")) || 0;

const blank = {
  name: "", currency: "AED", credit_limit: 100000, monthly_target: 5000,
  balance: 0, cycle_spend: 0, cycle_paid: 0,
  statement_day: 5, payment_day: 25, telegram_chat_id: "",
};

export default function App() {
  const [owner, setOwner] = useState(localStorage.getItem("cc_owner") || "");
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null);

  async function load() {
    if (!owner) { setCards([]); return; }
    setLoading(true);
    const { data } = await supabase.from("cards").select("*").eq("owner", owner).order("created_at");
    setCards(data || []);
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [owner]);

  function saveOwner(v) { setOwner(v); localStorage.setItem("cc_owner", v); }

  async function upsert(card) {
    const payload = { ...card, owner };
    if (card.id) await supabase.from("cards").update(payload).eq("id", card.id);
    else await supabase.from("cards").insert(payload);
    setEditing(null); load();
  }
  async function remove(id) { await supabase.from("cards").delete().eq("id", id); load(); }

  async function addSpend(card, amount) {
    const v = parseNum(amount); if (v <= 0) return;
    await supabase.from("cards").update({
      cycle_spend: Number(card.cycle_spend) + v,
      balance: Number(card.balance) + v,
    }).eq("id", card.id);
    load();
  }
  async function addPayment(card, amount) {
    const v = parseNum(amount); if (v <= 0) return;
    await supabase.from("cards").update({
      cycle_paid: Number(card.cycle_paid) + v,
      balance: Math.max(0, Number(card.balance) - v),
    }).eq("id", card.id);
    load();
  }

  const alerts = useMemo(() => {
    const out = [];
    for (const c of cards) {
      const pay = nextDate(c.payment_day), dPay = daysUntil(pay);
      if (dPay >= 0 && dPay <= 3 && Number(c.balance) > 0)
        out.push(`${c.name}: payment due in ${dPay} day${dPay === 1 ? "" : "s"} (${fmtDate(pay)}) — ${money(c.balance, c.currency)} owed.`);
      const stmt = nextDate(c.statement_day), dStmt = daysUntil(stmt);
      const remaining = Math.max(0, Number(c.monthly_target) - Number(c.cycle_spend));
      if (dStmt >= 0 && dStmt <= 15 && remaining > 0)
        out.push(`${c.name}: ${dStmt} days to statement, ${money(remaining, c.currency)} left to hit your spend goal.`);
    }
    return out;
  }, [cards]);

  return (
    <div className="wrap">
      <header className="top">
        <div>
          <h1>Card reminder</h1>
          <p>Revolving balance, monthly spend goals, and Telegram reminders.</p>
        </div>
        <button className="btn primary" onClick={() => setEditing({ card: { ...blank } })}>+ Add card</button>
      </header>

      <div className="owner-bar">
        <input placeholder="Your name or email" value={owner} onChange={(e) => saveOwner(e.target.value)} />
        <button className="btn ghost" onClick={load}>Refresh</button>
      </div>

      {alerts.length > 0 && (
        <div className="banner">
          <h3>Active reminders</h3>
          {alerts.map((a, i) => <p key={i}>{a}</p>)}
        </div>
      )}

      {!owner ? (
        <div className="empty">Enter your name or email above to load your cards.</div>
      ) : loading ? (
        <div className="empty">Loading…</div>
      ) : cards.length === 0 ? (
        <div className="empty">No cards yet. Tap <strong>Add card</strong>.</div>
      ) : (
        <div className="grid">
          {cards.map((c) => (
            <CardView key={c.id} c={c}
              onEdit={() => setEditing({ card: c })}
              onDelete={() => remove(c.id)}
              onSpend={(a) => addSpend(c, a)}
              onPay={(a) => addPayment(c, a)} />
          ))}
        </div>
      )}

      {editing && <Editor initial={editing.card} onCancel={() => setEditing(null)} onSave={upsert} />}
    </div>
  );
}

function CardView({ c, onEdit, onDelete, onSpend, onPay }) {
  const [spend, setSpend] = useState("");
  const [pay, setPay] = useState("");
  const cur = c.currency || "AED";
  const color = bankColor(c.name);
  const stmt = nextDate(c.statement_day), payD = nextDate(c.payment_day);
  const dPay = daysUntil(payD);
  const available = Math.max(0, Number(c.credit_limit) - Number(c.balance));
  const usePct = c.monthly_target > 0 ? Math.min(100, Math.round((c.cycle_spend / c.monthly_target) * 100)) : 0;
  const balPct = c.credit_limit > 0 ? Math.min(100, Math.round((c.balance / c.credit_limit) * 100)) : 0;

  return (
    <div className="card">
      <div className="cardtop" style={{ background: color }}>
        <span className="bankname">{c.name || "Card"}</span>
        <span className="curtag">{cur}</span>
        <button className="del" onClick={onDelete} aria-label="Delete">✕</button>
      </div>

      <div className="cardbody">
        <div className="balrow" onClick={onEdit}>
          <div>
            <p className="k">Balance owed</p>
            <p className="bigv">{money(c.balance, cur)}</p>
          </div>
          <div style={{ textAlign: "right" }}>
            <p className="k">Available</p>
            <p className="v">{money(available, cur)}</p>
          </div>
        </div>

        <div className="dates">
          <div className="tile"><p className="k">Statement</p><p className="v">{fmtDate(stmt)}</p></div>
          <div className="tile"><p className="k">Payment due</p><p className={"v" + (dPay <= 3 ? " due" : "")}>{fmtDate(payD)} ({dPay}d)</p></div>
        </div>

        <div className="bar-row">
          <div className="lbl"><span>Spend goal this cycle</span><span>{money(c.cycle_spend, cur)} / {money(c.monthly_target, cur)}</span></div>
          <div className="bar"><span style={{ width: usePct + "%" }} /></div>
        </div>
        <div className="bar-row">
          <div className="lbl"><span>Balance vs limit</span><span>{balPct}%</span></div>
          <div className="bar"><span className={balPct > 80 ? "hot" : ""} style={{ width: balPct + "%" }} /></div>
        </div>

        <div className="logrow">
          <input inputMode="numeric" placeholder="Spend" value={spend}
            onChange={(e) => setSpend(groupNum(e.target.value))} />
          <button className="btn" onClick={() => { onSpend(spend); setSpend(""); }}>+ Spend</button>
        </div>
        <div className="logrow">
          <input inputMode="numeric" placeholder="Payment" value={pay}
            onChange={(e) => setPay(groupNum(e.target.value))} />
          <button className="btn pay" onClick={() => { onPay(pay); setPay(""); }}>− Pay</button>
        </div>
      </div>
    </div>
  );
}

function Editor({ initial, onCancel, onSave }) {
  const [f, setF] = useState({
    ...initial,
    credit_limit: groupNum(initial.credit_limit),
    monthly_target: groupNum(initial.monthly_target),
    balance: groupNum(initial.balance),
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const clampDay = (v) => Math.min(28, Math.max(1, Number(String(v).replace(/[^\d]/g, "")) || 1));

  function save() {
    onSave({
      ...f,
      credit_limit: parseNum(f.credit_limit),
      monthly_target: parseNum(f.monthly_target),
      balance: parseNum(f.balance),
    });
  }

  return (
    <div className="modal-bg" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{f.id ? "Edit card" : "Add card"}</h2>

        <div className="row2">
          <div className="field" style={{ gridColumn: "span 2" }}>
            <label>Card name (include bank, e.g. FAB Cashback)</label>
            <input value={f.name} placeholder="e.g. ADCB Touchpoints" onChange={(e) => set("name", e.target.value)} />
          </div>
        </div>
        <div className="row2">
          <div className="field">
            <label>Currency</label>
            <select value={f.currency} onChange={(e) => set("currency", e.target.value)}>
              {Object.keys(CURRENCIES).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Credit limit</label>
            <input inputMode="numeric" value={f.credit_limit} onChange={(e) => set("credit_limit", groupNum(e.target.value))} />
          </div>
        </div>
        <div className="row2">
          <div className="field">
            <label>Monthly spend goal</label>
            <input inputMode="numeric" value={f.monthly_target} onChange={(e) => set("monthly_target", groupNum(e.target.value))} />
          </div>
          <div className="field">
            <label>Current balance owed</label>
            <input inputMode="numeric" value={f.balance} onChange={(e) => set("balance", groupNum(e.target.value))} />
          </div>
        </div>
        <div className="row2">
          <div className="field">
            <label>Statement day (1–28)</label>
            <input inputMode="numeric" value={f.statement_day} onChange={(e) => set("statement_day", clampDay(e.target.value))} />
          </div>
          <div className="field">
            <label>Payment due day (1–28)</label>
            <input inputMode="numeric" value={f.payment_day} onChange={(e) => set("payment_day", clampDay(e.target.value))} />
          </div>
        </div>
        <div className="field">
          <label>Telegram chat ID (for reminders)</label>
          <input value={f.telegram_chat_id || ""} placeholder="optional" onChange={(e) => set("telegram_chat_id", e.target.value)} />
        </div>

        <div className="actions">
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={save}>Save card</button>
        </div>
      </div>
    </div>
  );
}
