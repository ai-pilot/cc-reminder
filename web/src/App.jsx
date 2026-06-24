import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase.js";
import { CATEGORIES, TEMPLATES, computeCashback } from "./cashback-templates.js";

/* ---------- currency ---------- */
const CUR = {
  AED: { s: "AED", loc: "en-AE" }, INR: { s: "₹", loc: "en-IN" },
  USD: { s: "$", loc: "en-US" }, EUR: { s: "€", loc: "en-IE" },
  GBP: { s: "£", loc: "en-GB" }, SAR: { s: "SAR", loc: "en-SA" },
};
function money(n, c = "AED") {
  const x = CUR[c] || CUR.AED;
  const v = Math.round(Number(n) || 0).toLocaleString(x.loc);
  return x.s.length > 1 ? `${x.s} ${v}` : `${x.s}${v}`;
}

/* ---------- bank colors (text-only headers) ---------- */
const BANK = {
  fab: ["#0d3b66", "#16527f"], adcb: ["#7a1230", "#9c1a3e"], mawarid: ["#2d2a4a", "#403a66"],
  "dubai first": ["#5a1a1a", "#7a2626"], hsbc: ["#9a0010", "#c00316"], cbd: ["#0a3d2e", "#11543f"],
  rak: ["#7a1e1e", "#a32626"], emirates: ["#1a4a3a", "#1f5e49"], amazon: ["#1c2733", "#2b3a4a"],
};
function gradient(name = "") {
  const n = name.toLowerCase();
  for (const k in BANK) if (n.includes(k)) return BANK[k];
  let h = 0; for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) % 360;
  return [`hsl(${h},35%,24%)`, `hsl(${h},38%,32%)`];
}

/* ---------- dates with month-end fallback (supports 1-31) ---------- */
const today = new Date();
const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
function dateForDay(y, m, day) {
  return new Date(y, m, Math.min(day, daysInMonth(y, m)));
}
function nextDate(day) {
  let d = dateForDay(today.getFullYear(), today.getMonth(), day);
  if (d < startToday) d = dateForDay(today.getFullYear(), today.getMonth() + 1, day);
  return d;
}
const daysUntil = (d) => Math.round((d - startToday) / 86400000);
const fmtDate = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/* ---------- number input helpers ---------- */
const grp = (s) => { const d = String(s).replace(/[^\d]/g, ""); return d ? Number(d).toLocaleString("en-US") : ""; };
const parse = (s) => Number(String(s).replace(/[^\d]/g, "")) || 0;

const blankRules = () => ({ base: 1, minSpend: 0, needsVerify: false, rules: [] });
const blankCard = () => ({
  name: "", currency: "AED", credit_limit: 100000, monthly_target: 5000,
  balance: 0, cycle_spend: 0, cycle_paid: 0, statement_day: 5, payment_day: 25,
  telegram_chat_id: "", cashback_rules: blankRules(), spend_by_cat: {}, history: [],
});

export default function App() {
  const [owner, setOwner] = useState(localStorage.getItem("cc_owner") || "");
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null);
  const [historyFor, setHistoryFor] = useState(null);

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

  async function addSpend(card, cat, amount) {
    const v = parse(amount); if (v <= 0) return;
    const sbc = { ...(card.spend_by_cat || {}) };
    sbc[cat] = (Number(sbc[cat]) || 0) + v;
    await supabase.from("cards").update({
      spend_by_cat: sbc,
      cycle_spend: Number(card.cycle_spend) + v,
      balance: Number(card.balance) + v,
    }).eq("id", card.id);
    load();
  }
  async function addPayment(card, amount) {
    const v = parse(amount); if (v <= 0) return;
    await supabase.from("cards").update({
      cycle_paid: Number(card.cycle_paid) + v,
      balance: Math.max(0, Number(card.balance) - v),
    }).eq("id", card.id);
    load();
  }

  // manual statement close: compute cashback, push to history, reset cycle counters
  async function closeStatement(card) {
    const cb = computeCashback(card, card.spend_by_cat || {});
    const entry = {
      month: new Date().toLocaleDateString("en-GB", { month: "short", year: "2-digit" }),
      totalSpend: cb.totalSpend, totalPaid: Number(card.cycle_paid) || 0,
      cashback: Math.round(cb.total), closedOn: new Date().toISOString().slice(0, 10),
    };
    const history = [entry, ...(card.history || [])].slice(0, 12);
    await supabase.from("cards").update({
      history, spend_by_cat: {}, cycle_spend: 0, cycle_paid: 0,
    }).eq("id", card.id);
    load();
  }

  const totals = useMemo(() => {
    let owed = 0, limit = 0, cashback = 0;
    for (const c of cards) {
      owed += Number(c.balance) || 0;
      limit += Number(c.credit_limit) || 0;
      cashback += computeCashback(c, c.spend_by_cat || {}).total;
    }
    return { owed, limit, cashback, count: cards.length };
  }, [cards]);

  const alerts = useMemo(() => {
    const out = [];
    for (const c of cards) {
      const pay = nextDate(c.payment_day), dPay = daysUntil(pay);
      if (dPay >= 0 && dPay <= 3 && Number(c.balance) > 0)
        out.push(<><b>{c.name}</b>: payment of {money(c.balance, c.currency)} due in {dPay} day{dPay === 1 ? "" : "s"} ({fmtDate(pay)}).</>);
      const stmt = nextDate(c.statement_day), dStmt = daysUntil(stmt);
      const remaining = Math.max(0, Number(c.monthly_target) - Number(c.cycle_spend));
      if (dStmt >= 0 && dStmt <= 15 && remaining > 0)
        out.push(<><b>{c.name}</b>: {dStmt} days to statement, {money(remaining, c.currency)} left to hit your spend goal.</>);
    }
    return out;
  }, [cards]);

  return (
    <div className="wrap">
      <div className="masthead">
        <div>
          <p className="eyebrow">Personal card vault</p>
          <h1 className="title">Card <em>reminder</em></h1>
          <p className="sub">Balances, statement dates, spend goals and cashback — across every card you carry.</p>
        </div>
        <button className="btn primary" onClick={() => setEditing(blankCard())}>+ Add card</button>
      </div>

      <div className="strip">
        <div className="cell"><p className="k">Cards</p><p className="v num">{totals.count}</p></div>
        <div className="cell"><p className="k">Total owed</p><p className="v num">{money(totals.owed)}</p></div>
        <div className="cell"><p className="k">Total limit</p><p className="v num">{money(totals.limit)}</p></div>
        <div className="cell"><p className="k">Cashback this cycle</p><p className="v num green">{money(totals.cashback)}</p></div>
      </div>

      <div className="toolbar">
        <div className="identity">
          <input placeholder="Your name or email" value={owner} onChange={(e) => saveOwner(e.target.value)} />
        </div>
        <button className="btn ghost" onClick={load}>Refresh</button>
      </div>

      {alerts.length > 0 && (
        <div className="banner">
          <h3>Active reminders</h3>
          {alerts.map((a, i) => <p key={i}>{a}</p>)}
        </div>
      )}

      {!owner ? (
        <div className="empty">Enter your name or email above to open your vault.</div>
      ) : loading ? (
        <div className="empty">Loading…</div>
      ) : cards.length === 0 ? (
        <div className="empty">Your vault is empty. Tap <strong>Add card</strong> to add your first one.</div>
      ) : (
        <div className="grid">
          {cards.map((c) => (
            <Vault key={c.id} c={c}
              onEdit={() => setEditing(c)}
              onDelete={() => remove(c.id)}
              onSpend={(cat, a) => addSpend(c, cat, a)}
              onPay={(a) => addPayment(c, a)}
              onClose={() => closeStatement(c)}
              onHistory={() => setHistoryFor(c)} />
          ))}
        </div>
      )}

      {editing && <Editor initial={editing} onCancel={() => setEditing(null)} onSave={upsert} />}
      {historyFor && <History card={historyFor} onClose={() => setHistoryFor(null)} />}
    </div>
  );
}

function Vault({ c, onEdit, onDelete, onSpend, onPay, onClose, onHistory }) {
  const [cat, setCat] = useState(CATEGORIES[0]);
  const [spend, setSpend] = useState("");
  const [pay, setPay] = useState("");
  const cur = c.currency || "AED";
  const [g1, g2] = gradient(c.name);
  const stmt = nextDate(c.statement_day), payD = nextDate(c.payment_day);
  const dPay = daysUntil(payD);
  const available = Math.max(0, Number(c.credit_limit) - Number(c.balance));
  const usePct = c.monthly_target > 0 ? Math.min(100, Math.round((c.cycle_spend / c.monthly_target) * 100)) : 0;
  const balPct = c.credit_limit > 0 ? Math.min(100, Math.round((c.balance / c.credit_limit) * 100)) : 0;
  const cb = computeCashback(c, c.spend_by_cat || {});

  return (
    <div className="vault">
      <div className="face" style={{ background: `linear-gradient(135deg, ${g1}, ${g2})` }}>
        <div className="bankrow">
          <span className="bankname">{c.name || "Untitled card"}</span>
          <span className="chip">{cur}</span>
          <button className="x" onClick={onDelete} aria-label="Delete card">✕</button>
        </div>
        <div className="owed">
          <div>
            <p className="lbl">Balance owed</p>
            <p className="big num">{money(c.balance, cur)}</p>
          </div>
          <div className="avail">
            <div className="num">{money(available, cur)}</div>
            <div style={{ opacity: .7, fontSize: 11 }}>available</div>
          </div>
        </div>
      </div>

      <div className="body">
        <div className="metarow">
          <div className="meta"><p className="k">Statement</p><p className="v num">{fmtDate(stmt)}</p></div>
          <div className="meta"><p className="k">Payment due</p><p className={"v num" + (dPay <= 3 ? " due" : "")}>{fmtDate(payD)} · {dPay}d</p></div>
        </div>

        <div className="cashbox">
          <div className="top">
            <p className="lbl">Expected cashback</p>
            <span className="amt num">{money(cb.total, cur)}</span>
          </div>
          {cb.blockedByMinSpend
            ? <p className="note warn">Spend {money(c.cashback_rules?.minSpend, cur)} min to start earning ({money(cb.totalSpend, cur)} so far).</p>
            : <p className="note">on {money(cb.totalSpend, cur)} logged this cycle{c.cashback_rules?.needsVerify ? " · rates unverified" : ""}</p>}
        </div>

        <div className="barwrap">
          <div className="lbl"><span>Spend goal</span><span className="num">{money(c.cycle_spend, cur)} / {money(c.monthly_target, cur)}</span></div>
          <div className="bar"><span style={{ width: usePct + "%" }} /></div>
        </div>
        <div className="barwrap">
          <div className="lbl"><span>Balance vs limit</span><span className="num">{balPct}%</span></div>
          <div className="bar"><span className={balPct > 80 ? "hot" : ""} style={{ width: balPct + "%" }} /></div>
        </div>

        <div className="logbar">
          <select value={cat} onChange={(e) => setCat(e.target.value)}>
            {CATEGORIES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <input inputMode="numeric" placeholder="Amount" value={spend} onChange={(e) => setSpend(grp(e.target.value))} />
          <button className="btn" onClick={() => { onSpend(cat, spend); setSpend(""); }}>+ Spend</button>
        </div>
        <div className="paybar">
          <input inputMode="numeric" placeholder="Payment made" value={pay} onChange={(e) => setPay(grp(e.target.value))} />
          <button className="btn" onClick={() => { onPay(pay); setPay(""); }}>− Pay</button>
        </div>

        <div className="linkrow">
          <button onClick={onEdit}>Edit & cashback rules</button>
          <button onClick={onHistory}>History</button>
          <button onClick={onClose}>Close statement</button>
        </div>
      </div>
    </div>
  );
}

function Editor({ initial, onCancel, onSave }) {
  const [f, setF] = useState({
    ...initial,
    credit_limit: grp(initial.credit_limit),
    monthly_target: grp(initial.monthly_target),
    balance: grp(initial.balance),
    cashback_rules: initial.cashback_rules || blankRules(),
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const setRules = (r) => setF((p) => ({ ...p, cashback_rules: r }));
  const clampDay = (v) => Math.min(31, Math.max(1, Number(String(v).replace(/[^\d]/g, "")) || 1));

  function applyTemplate(name) {
    const t = TEMPLATES[name];
    if (!t) return;
    set("currency", t.currency);
    if (!f.name) set("name", name);
    setRules({ base: t.base, minSpend: t.minSpend, needsVerify: t.needsVerify, rules: t.rules.map((r) => ({ ...r })) });
  }
  function addRule() {
    const used = f.cashback_rules.rules.map((r) => r.category);
    const next = CATEGORIES.find((c) => !used.includes(c)) || CATEGORIES[0];
    setRules({ ...f.cashback_rules, rules: [...f.cashback_rules.rules, { category: next, rate: 1, cap: 0 }] });
  }
  function updRule(i, k, v) {
    const rules = f.cashback_rules.rules.map((r, idx) => idx === i ? { ...r, [k]: v } : r);
    setRules({ ...f.cashback_rules, rules });
  }
  function delRule(i) {
    setRules({ ...f.cashback_rules, rules: f.cashback_rules.rules.filter((_, idx) => idx !== i) });
  }

  function save() {
    onSave({
      ...f,
      credit_limit: parse(f.credit_limit),
      monthly_target: parse(f.monthly_target),
      balance: parse(f.balance),
      cashback_rules: {
        ...f.cashback_rules,
        base: Number(f.cashback_rules.base) || 0,
        minSpend: Number(f.cashback_rules.minSpend) || 0,
        rules: f.cashback_rules.rules.map((r) => ({ category: r.category, rate: Number(r.rate) || 0, cap: Number(r.cap) || 0 })),
      },
    });
  }

  return (
    <div className="scrim" onClick={onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>{f.id ? "Edit card" : "Add card"}</h2>
        <p className="hint">Pick a template to pre-fill cashback rules, then verify the numbers against your card's terms.</p>

        <div className="field">
          <label>Start from a template</label>
          <select defaultValue="" onChange={(e) => { applyTemplate(e.target.value); e.target.value = ""; }}>
            <option value="" disabled>Choose a UAE card…</option>
            {Object.keys(TEMPLATES).map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        <div className="field">
          <label>Card name (include the bank)</label>
          <input value={f.name} placeholder="e.g. ADCB 365 Cashback" onChange={(e) => set("name", e.target.value)} />
        </div>
        <div className="row2">
          <div className="field">
            <label>Currency</label>
            <select value={f.currency} onChange={(e) => set("currency", e.target.value)}>
              {Object.keys(CUR).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Credit limit</label>
            <input inputMode="numeric" value={f.credit_limit} onChange={(e) => set("credit_limit", grp(e.target.value))} />
          </div>
        </div>
        <div className="row2">
          <div className="field">
            <label>Monthly spend goal</label>
            <input inputMode="numeric" value={f.monthly_target} onChange={(e) => set("monthly_target", grp(e.target.value))} />
          </div>
          <div className="field">
            <label>Current balance owed</label>
            <input inputMode="numeric" value={f.balance} onChange={(e) => set("balance", grp(e.target.value))} />
          </div>
        </div>
        <div className="row2">
          <div className="field">
            <label>Statement day (1–31)</label>
            <input inputMode="numeric" value={f.statement_day} onChange={(e) => set("statement_day", clampDay(e.target.value))} />
          </div>
          <div className="field">
            <label>Payment due day (1–31)</label>
            <input inputMode="numeric" value={f.payment_day} onChange={(e) => set("payment_day", clampDay(e.target.value))} />
          </div>
        </div>
        <div className="field">
          <label>Telegram chat ID (for reminders)</label>
          <input value={f.telegram_chat_id || ""} placeholder="from your bot setup" onChange={(e) => set("telegram_chat_id", e.target.value)} />
        </div>

        <hr style={{ border: "none", borderTop: "1px solid var(--line)", margin: "20px 0 16px" }} />
        <label style={{ fontSize: 13, color: "var(--brass)", letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 12 }}>Cashback rules</label>

        {f.cashback_rules.needsVerify && (
          <div className="verifyflag">⚠ These rates are starting points from public info and may be outdated. Verify against your card's current terms.</div>
        )}

        <div className="row2" style={{ marginBottom: 14 }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Base rate % (all other spend)</label>
            <input inputMode="decimal" value={f.cashback_rules.base} onChange={(e) => setRules({ ...f.cashback_rules, base: e.target.value })} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Min monthly spend to earn</label>
            <input inputMode="numeric" value={f.cashback_rules.minSpend} onChange={(e) => setRules({ ...f.cashback_rules, minSpend: e.target.value })} />
          </div>
        </div>

        {f.cashback_rules.rules.map((r, i) => (
          <div className="rulecard" key={i}>
            <div className="rulehead">
              <select value={r.category} onChange={(e) => updRule(i, "category", e.target.value)} style={{ width: "auto", flex: 1, marginRight: 8 }}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <button className="btn tiny ghost" onClick={() => delRule(i)}>Remove</button>
            </div>
            <div className="rulegrid">
              <div><label>Rate %</label><input inputMode="decimal" value={r.rate} onChange={(e) => updRule(i, "rate", e.target.value)} /></div>
              <div><label>Cap / cycle (0 = none)</label><input inputMode="numeric" value={r.cap} onChange={(e) => updRule(i, "cap", e.target.value)} /></div>
            </div>
          </div>
        ))}
        <button className="btn tiny ghost" onClick={addRule}>+ Add category rule</button>

        <div className="actions">
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={save}>Save card</button>
        </div>
      </div>
    </div>
  );
}

function History({ card, onClose }) {
  const cur = card.currency || "AED";
  const h = card.history || [];
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>{card.name} — history</h2>
        <p className="hint">Last 12 closed statements. Close a statement to add the current cycle here.</p>
        {h.length === 0 ? (
          <div className="empty" style={{ padding: "32px 16px" }}>No closed statements yet.</div>
        ) : h.map((e, i) => (
          <div className="histrow" key={i}>
            <span className="m">{e.month}</span>
            <span className="num">spend {money(e.totalSpend, cur)}</span>
            <span className="num">paid {money(e.totalPaid, cur)}</span>
            <span className="cb num">+{money(e.cashback, cur)}</span>
          </div>
        ))}
        <div className="actions"><button className="btn primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}
