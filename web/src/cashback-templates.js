// cashback-templates.js
// EDITABLE starting points for UAE cards. Rates change often (e.g. ADCB 365 changed
// rates on 1 Jul 2026), so every template is marked needsVerify:true and is meant to be
// confirmed against your own card's current terms inside the app.
//
// Each rule: { category, rate (percent), cap (max cashback per cycle in card currency, 0 = no cap) }
// `base` = rate applied to any spend whose category has no specific rule.
// `minSpend` = minimum total cycle spend before cashback is earned (0 = none).

export const CATEGORIES = [
  "Groceries", "Dining", "Travel", "Fuel", "Shopping",
  "Online", "Bills & Utilities", "Education", "Entertainment",
  "International", "Other",
];

// rate is %, cap is max cashback for that category per statement cycle (0 = uncapped)
export const TEMPLATES = {
  "FAB Cashback": {
    currency: "AED", base: 1, minSpend: 3000, needsVerify: true,
    rules: [
      { category: "Groceries", rate: 5, cap: 200 },
      { category: "Dining", rate: 5, cap: 200 },
      { category: "Shopping", rate: 5, cap: 200 },
      { category: "International", rate: 3, cap: 0 },
    ],
  },
  "FAB Travel": {
    currency: "AED", base: 1, minSpend: 0, needsVerify: true,
    rules: [
      { category: "Travel", rate: 12, cap: 1800 }, // points-value approx; verify
    ],
  },
  "ADCB 365 Cashback": {
    currency: "AED", base: 1, minSpend: 2500, needsVerify: true,
    rules: [
      { category: "Dining", rate: 6, cap: 1000 },
      { category: "Groceries", rate: 3, cap: 1000 },  // dropped from 5% on 1 Jul 2026
      { category: "Fuel", rate: 5, cap: 1000 },
      { category: "Bills & Utilities", rate: 5, cap: 1000 },
      { category: "Entertainment", rate: 5, cap: 1000 }, // digital subs
    ],
  },
  "ADCB Traveller": {
    currency: "AED", base: 1.5, minSpend: 5000, needsVerify: true,
    rules: [
      { category: "Travel", rate: 10, cap: 1500 },
      { category: "Entertainment", rate: 50, cap: 1500 }, // movie tickets
    ],
  },
  "Mawarid World": {
    currency: "AED", base: 1, minSpend: 0, needsVerify: true, rules: [],
  },
  "Mawarid World Elite": {
    currency: "AED", base: 1.5, minSpend: 0, needsVerify: true, rules: [],
  },
  "Dubai First Cashback": {
    currency: "AED", base: 1, minSpend: 0, needsVerify: true,
    rules: [
      { category: "Groceries", rate: 3, cap: 0 },
      { category: "Dining", rate: 3, cap: 0 },
    ],
  },
  "HSBC Live+": {
    currency: "AED", base: 1, minSpend: 0, needsVerify: true,
    rules: [
      { category: "Dining", rate: 8, cap: 200 },
      { category: "Entertainment", rate: 8, cap: 200 },
      { category: "Groceries", rate: 2, cap: 200 },
    ],
  },
  "CBD Visa Infinite": {
    currency: "AED", base: 1.5, minSpend: 0, needsVerify: true, rules: [],
  },
  "RAKBANK World": {
    currency: "AED", base: 1, minSpend: 0, needsVerify: true,
    rules: [
      { category: "International", rate: 2, cap: 0 },
    ],
  },
  "Emirates Islamic Amazon": {
    currency: "AED", base: 1, minSpend: 0, needsVerify: true,
    rules: [
      { category: "Online", rate: 3, cap: 0 }, // amazon.ae; verify
    ],
  },
  "Custom (blank)": {
    currency: "AED", base: 1, minSpend: 0, needsVerify: false, rules: [],
  },
};

// Compute cashback for a set of per-category spends against a card's rules.
// spendByCat: { Groceries: 1200, Dining: 400, ... }
export function computeCashback(card, spendByCat) {
  const rules = card.cashback_rules || { base: 1, minSpend: 0, rules: [] };
  const total = Object.values(spendByCat).reduce((a, b) => a + (Number(b) || 0), 0);

  if (rules.minSpend && total < rules.minSpend) {
    return { total: 0, byCategory: {}, blockedByMinSpend: true, totalSpend: total };
  }

  const ruleMap = {};
  (rules.rules || []).forEach((r) => { ruleMap[r.category] = r; });

  const byCategory = {};
  let cashTotal = 0;
  for (const cat of Object.keys(spendByCat)) {
    const spent = Number(spendByCat[cat]) || 0;
    if (spent <= 0) continue;
    const rule = ruleMap[cat];
    const rate = rule ? rule.rate : (rules.base || 0);
    let cb = (spent * rate) / 100;
    if (rule && rule.cap > 0) cb = Math.min(cb, rule.cap);
    byCategory[cat] = cb;
    cashTotal += cb;
  }
  return { total: cashTotal, byCategory, blockedByMinSpend: false, totalSpend: total };
}
