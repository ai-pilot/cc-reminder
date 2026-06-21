import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase.js";

const inr = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const today = new Date();
const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());

function nextDate(day) {
  const d = new Date(today.getFullYear(), today.getMonth(), day);
  if (d < startOfToday) d.setMonth(d.getMonth() + 1);
  return d;
}
const daysUntil = (date) => Math.round((date - startOfToday) / 86400000);
const fmtDate = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

const blank = {
  name: "", credit_limit: 100000, monthly_target: 50000, used: 0,
  statement_day: 5, payment_day: 25,
};

export default function App() {
  const [owner, setOwner] = useState(localStorage.getItem("cc_owner") || "");
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null); // {card, index} or {card:null}

  async function load() {
    if (!owner) { setCards([]); return; }
    setLoading(true);
    const { data, error } = await supabase
      .from("cards").select("*").eq("owner", owner).order("created_at");
    if (!error) setCards(data || []);
    setLoading(false);
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [owner]);

  function saveOwner(v) {
    setOwner(v);
    localStorage.setItem("cc_owner", v);
  }

  async function upsert(card) {
    const payload = { ...card, owner };
    if (card.id) {
      await supabase.from("cards").update(payload).eq("id", card.id);
    } else {
      await supabase.from("cards").insert(payload);
    }
    setEditing(null);
    load();
  }

  async function remove(id) {
    await supabase.from("cards").delete().eq("id", id);
    load();
  }

  async function logSpend(card, amount) {
    const v = parseFloat(amount);
    if (isNaN(v) || v <= 0) return;
    await supabase.from("cards").update({ used: Number(card.used) + v }).eq("id", card.id);
    load();
  }

  const alerts = useMemo(() => {
    const out = [];
    for (const c of cards) {
      const pay = nextDate(c.payment_day);
      const dPay = daysUntil(pay);
      if (dPay >= 0 && dPay <= 3)
        out.push(`${c.name}: payment due in ${dPay} day${dPay === 1 ? "" : "s"} (${fmtDate(pay)}).`);
      const stmt = nextDate(c.statement_day);
      const dStmt = daysUntil(stmt);
      const remaining = Math.max(0, Number(c.monthly_target) - Number(c.used));
      if (dStmt >= 0 && dStmt <= 15 && remaining > 0)
        out.push(`${c.name}: ${dStmt} days to statement, ${inr(remaining)} left to hit target.`);
    }
    return out;
  }, [cards]);

  return (
    <div className="wrap">
      <header className="top">
        <div>
          <h1>Card reminder</h1>
          <p>Track payment dates, statement dates, and monthly spend targets. Reminders go to Telegram.</p>
        </div>
        <button className="btn primary" onClick={() => setEditing({ card: { ...blank } })}>
          + Add card
        </button>
      </header>

      <div className="owner-bar">
        <input
          placeholder="Your name or email (so you see only your cards)"
          value={owner}
          onChange={(e) => saveOwner(e.target.value)}
        />
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
        <div className="empty">No cards yet. Tap <strong>Add card</strong> to enter your first one.</div>
      ) : (
        <div className="grid">
          {cards.map((c, i) => (
            <CardView key={c.id} c={c}
              onEdit={() => setEditing({ card: c, index: i })}
              onDelete={() => remove(c.id)}
              onLog={(amt) => logSpend(c, amt)} />
          ))}
        </div>
      )}

      {editing && (
        <Editor
          initial={editing.card}
          onCancel={() => setEditing(null)}
          onSave={upsert}
        />
      )}
    </div>
  );
}

function CardView({ c, onEdit, onDelete, onLog }) {
  const [amt, setAmt] = useState("");
  const pay = nextDate(c.payment_day);
  const stmt = nextDate(c.statement_day);
  const dPay = daysUntil(pay);
  const usePct = c.monthly_target > 0 ? Math.min(100, Math.round((c.used / c.monthly_target) * 100)) : 0;
  const limitPct = c.credit_limit > 0 ? Math.min(100, Math.round((c.used / c.credit_limit) * 100)) : 0;

  return (
    <div className="card">
      <div className="head">
        <div onClick={onEdit} style={{ cursor: "pointer" }}>
          <p className="name">{c.name}</p>
          <p className="sub">Limit {inr(c.credit_limit)} · tap to edit</p>
        </div>
        <button className="btn danger" onClick={onDelete}>Delete</button>
      </div>

      <div className="dates">
        <div className="tile">
          <p className="k">Statement date</p>
          <p className="v">{fmtDate(stmt)}</p>
        </div>
        <div className="tile">
          <p className="k">Payment due</p>
          <p className={"v" + (dPay <= 3 ? " due" : "")}>{fmtDate(pay)} ({dPay}d)</p>
        </div>
      </div>

      <div className="bar-row">
        <div className="lbl"><span>Monthly target</span><span>{inr(c.used)} / {inr(c.monthly_target)}</span></div>
        <div className="bar"><span style={{ width: usePct + "%" }} /></div>
      </div>
      <div className="bar-row">
        <div className="lbl"><span>Against credit limit</span><span>{limitPct}%</span></div>
        <div className="bar"><span className={limitPct > 80 ? "hot" : ""} style={{ width: limitPct + "%" }} /></div>
      </div>

      <div className="logrow">
        <input type="number" placeholder="Add spend" value={amt} onChange={(e) => setAmt(e.target.value)} />
        <button className="btn" onClick={() => { onLog(amt); setAmt(""); }}>Log</button>
      </div>
    </div>
  );
}

function Editor({ initial, onCancel, onSave }) {
  const [f, setF] = useState({ ...initial });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const num = (v) => (v === "" ? 0 : Number(v));
  const clampDay = (v) => Math.min(28, Math.max(1, Number(v) || 1));

  return (
    <div className="modal-bg" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{f.id ? "Edit card" : "Add card"}</h2>

        <div className="field">
          <label>Card name</label>
          <input value={f.name} placeholder="e.g. HDFC Millennia" onChange={(e) => set("name", e.target.value)} />
        </div>
        <div className="field">
          <label>Telegram chat ID</label>
          <input value={f.telegram_chat_id || ""} placeholder="from @BotFather setup" onChange={(e) => set("telegram_chat_id", e.target.value)} />
        </div>
        <div className="row2">
          <div className="field">
            <label>Credit limit (₹)</label>
            <input type="number" value={f.credit_limit} onChange={(e) => set("credit_limit", num(e.target.value))} />
          </div>
          <div className="field">
            <label>Monthly target (₹)</label>
            <input type="number" value={f.monthly_target} onChange={(e) => set("monthly_target", num(e.target.value))} />
          </div>
        </div>
        <div className="row2">
          <div className="field">
            <label>Statement day (1–28)</label>
            <input type="number" value={f.statement_day} onChange={(e) => set("statement_day", clampDay(e.target.value))} />
          </div>
          <div className="field">
            <label>Payment due day (1–28)</label>
            <input type="number" value={f.payment_day} onChange={(e) => set("payment_day", clampDay(e.target.value))} />
          </div>
        </div>

        <div className="actions">
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={() => onSave(f)}>Save card</button>
        </div>
      </div>
    </div>
  );
}
