"use client";

import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  LineChart, Line, AreaChart, Area, ComposedChart, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from "recharts";
import {
  Plus, TrendingUp, TrendingDown, Wallet, PiggyBank, ArrowUpRight, ArrowDownRight,
  Trash2, X, LayoutDashboard, Receipt, LineChartIcon, Landmark,
  Pencil, ArrowUp, ArrowDown, Tag, CheckCircle2, Target, Menu, Upload, FileText, Sparkles, Send, ArrowRightLeft, Settings, Filter
} from "./icons";
import { extractPages, parseStatement, suggestCategory, buildDiagnostics } from "../lib/statement";

// ---------- Storage (SQLite via API, per utente) ----------
const storage = {
  get: async () => {
    const res = await fetch("/api/state", { cache: "no-store" });
    if (res.status === 401) { window.location.href = "/login"; throw new Error("unauthorized"); }
    if (!res.ok) throw new Error("load failed");
    return res.json();
  },
  set: async (key, value) => {
    const res = await fetch("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
    if (res.status === 401) { window.location.href = "/login"; throw new Error("unauthorized"); }
    if (!res.ok) throw new Error("save failed");
    return res.json();
  },
};

// ---------- Utility ----------
// colore con trasparenza (funziona sia con esadecimali che con le variabili del tema)
const alpha = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

const fmt = (n) =>
  new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n || 0);
const fmtFull = (n) =>
  new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(n || 0);
const monthKey = (d) => d.slice(0, 7);
const isEffettivo = (t) => t.date <= todayISO();
const localISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayISO = () => localISO(new Date());
const uid = () => Math.random().toString(36).slice(2, 10);

const CATS_ENTRATA = ["Stipendio", "Freelance", "Bonus", "Rimborsi", "Altro"];
const CATS_USCITA = ["Casa", "Cibo", "Trasporti", "Svago", "Salute", "Abbonamenti", "Shopping", "Altro"];
const INVEST_TYPES = ["ETF", "Azioni", "Crypto", "Obbligazioni", "Fondo Pensione", "Liquidità investita", "Altro"];

const PALETTE = ["var(--accent)", "var(--pos)", "var(--secondary)", "var(--neg)", "var(--text-muted)", "var(--chart-3)", "var(--chart-4)"];

// Porta uno stato salvato (anche di versioni vecchie o ripristinato da backup) alla forma attuale
function buildLoadedState(parsed) {
  let categories = parsed.categories;
  if (!categories) {
    const custom = parsed.customCategories || { entrata: [], uscita: [] };
    categories = {
      entrata: [...makeDefaultCategories(CATS_ENTRATA), ...makeDefaultCategories(custom.entrata || [])],
      uscita: [...makeDefaultCategories(CATS_USCITA), ...makeDefaultCategories(custom.uscita || [])],
    };
  }
  return migrateState({
    ...DEFAULT_STATE,
    ...parsed,
    accounts: parsed.accounts, // se mancante, i conti vengono ricavati dal vecchio "patrimonio di partenza"
    recurring: parsed.recurring || [],
    budgets: parsed.budgets || [],
    importedKeys: parsed.importedKeys || [],
    settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
    trash: purgeTrash(parsed.trash),
    rules: parsed.rules || [],
    categories: ensureSystemCategories({
      entrata: categories.entrata || DEFAULT_STATE.categories.entrata,
      uscita: categories.uscita || DEFAULT_STATE.categories.uscita,
    }),
  });
}

// ---------- Esportazione e backup ----------
function downloadFile(name, mime, text) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
const csvCell = (v) => {
  const s = String(v ?? "");
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvNum = (n) => Number(n).toFixed(2).replace(".", ",");
// CSV per Excel/Fogli: separatore ";", virgola decimale, BOM UTF-8
function transactionsToCsv(state) {
  const accName = Object.fromEntries((state.accounts || []).map((a) => [a.id, a.name]));
  const head = ["Data", "Tipo", "Importo", "Importo con segno", "Categoria", "Sottocategoria", "Descrizione", "Conto", "Stato", "Giroconto"];
  const rows = [...state.transactions]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((t) => [
      t.date,
      t.type === "entrata" ? "Entrata" : "Uscita",
      csvNum(t.amount),
      (t.type === "entrata" ? "" : "-") + csvNum(t.amount),
      t.category,
      t.subcategory || "",
      t.description || "",
      accName[t.accountId] || "",
      isEffettivo(t) ? "Effettivo" : "Previsto",
      t.transferId || t.isTransfer ? "Sì" : "No",
    ]);
  return "\uFEFF" + [head, ...rows].map((r) => r.map(csvCell).join(";")).join("\r\n");
}
const buildBackup = (state) => JSON.stringify({ app: "finanze", version: 1, exportedAt: new Date().toISOString(), state }, null, 2);
function parseBackup(text) {
  let j;
  try { j = JSON.parse(text); } catch { throw new Error("Il file non è un JSON valido."); }
  if (!j || j.app !== "finanze" || !j.state || typeof j.state !== "object") throw new Error("Il file non sembra un backup di questa app.");
  const st = j.state;
  if (!Array.isArray(st.transactions)) throw new Error("Il backup non contiene l'elenco dei movimenti.");
  if (!Array.isArray(st.accounts) && !Array.isArray(st.openingBalances)) throw new Error("Il backup non contiene i conti.");
  return { exportedAt: j.exportedAt || null, state: st };
}
const stateSummary = (st) =>
  `${st.transactions.length} movimenti, ${(st.accounts || st.openingBalances || []).length} conti, ${(st.investments || []).length} investimenti, ${(st.recurring || []).length} ricorrenze, ${(st.budgets || []).length} budget`;

// ---------- Impostazioni: tema e colore principale ----------
const THEMES = [
  { id: "dark", label: "Scuro" },
  { id: "light", label: "Chiaro" },
];
// colore principale (pulsanti, evidenziazioni, grafici). Entrate/uscite e indicatori positivo/negativo non cambiano mai.
const ACCENTS = [
  { id: "oro", label: "Oro", dark: "#C9A227", light: "#9A7B14" },
  { id: "blu", label: "Blu", dark: "#5B8DEF", light: "#2F62C8" },
  { id: "turchese", label: "Turchese", dark: "#3FB6C9", light: "#17808F" },
  { id: "viola", label: "Viola", dark: "#A78BFA", light: "#6D4FD1" },
  { id: "arancio", label: "Arancio", dark: "#E8884A", light: "#C25A1B" },
  { id: "rosa", label: "Rosa", dark: "#E07BA8", light: "#B8457A" },
];
const PREFS_KEY = "fx-prefs";
function applyPrefs(theme, accent) {
  if (typeof document === "undefined") return;
  const t = THEMES.some((x) => x.id === theme) ? theme : "dark";
  const a = ACCENTS.some((x) => x.id === accent) ? accent : "oro";
  document.documentElement.dataset.theme = t;
  document.documentElement.dataset.accent = a;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: t, accent: a })); } catch (e) { /* ignore */ }
}

const TAB_IDS = ["dashboard", "movimenti", "budget", "investimenti", "patrimonio", "categorie", "consulente", "cestino"];

const STORAGE_KEY = "finanze-state-v1";

function makeDefaultCategories(names) {
  return names.map((name, i) => ({ id: uid(), name, subcategories: [], createdAt: i }));
}

// ---------- Conti ----------
const TRANSFER_CAT = "Giroconto"; // nome predefinito della categoria dei giroconti (rinominabile dalle Categorie)
const LEGACY_TRANSFER_CAT = "Trasferimento tra conti";
// Categorie che spostano denaro verso/da investimenti: non sono spese né entrate "vere".
// I giroconti si riconoscono dai flag transferId / isTransfer (così restano tali anche se si rinomina la categoria).
const NON_FLOW_CATS = ["Investimenti", "Disinvestimento"];
const isFlow = (t) => !t.transferId && !t.isTransfer && !NON_FLOW_CATS.includes(t.category);

// Garantisce una categoria "giroconto" (flag transfer) per entrate e uscite; non si può eliminare ma si può rinominare
function ensureSystemCategories(categories) {
  const strip = ({ system, ...rest }) => rest; // eslint-disable-line no-unused-vars
  const fix = (list) => {
    if (list.some((c) => c.transfer)) return list.map((c) => (c.system ? strip(c) : c));
    const lower = (x) => x.toLowerCase();
    const named = list.find((c) => lower(c.name) === lower(TRANSFER_CAT));
    if (named) return list.map((c) => (c === named ? { ...strip(c), transfer: true } : c));
    const legacy = list.find((c) => c.name === LEGACY_TRANSFER_CAT);
    if (legacy) return list.map((c) => (c === legacy ? { ...strip(c), name: TRANSFER_CAT, transfer: true } : c));
    return [...list, { id: uid(), name: TRANSFER_CAT, subcategories: [], createdAt: Date.now(), transfer: true }];
  };
  return { entrata: fix(categories.entrata || []), uscita: fix(categories.uscita || []) };
}
function ensureCategory(categories, type, name) {
  const list = categories[type] || [];
  if (list.some((c) => c.name.toLowerCase() === name.toLowerCase())) return categories;
  return { ...categories, [type]: [...list, { id: uid(), name, subcategories: [], createdAt: Date.now() }] };
}

// ---------- Posizioni di investimento create dagli estratti conto ----------
function guessInvType(name) {
  if (/ETF|UCITS|ISHARES|VANGUARD|XTRACKERS|AMUNDI|SPDR|\bETC\b|\bETN\b/i.test(name)) return "ETF";
  if (/BOND|BTP|OBBLIG/i.test(name)) return "Obbligazioni";
  return "Azioni";
}
// Applica acquisti/vendite (trades: {isin,name,qty,side,amount,date}) alle posizioni "da import" del conto.
// Per ogni titolo conta il saldo netto delle quote (acquistate − vendute), indipendente dall'ordine:
//  - netto positivo: si aggiunge/crea la posizione, a costo medio d'acquisto
//  - netto negativo: si riduce la posizione esistente in proporzione alle quote vendute (quelle in eccesso erano già in portafoglio prima)
function applyTrades(investments, trades, accountId) {
  const EPS = 1e-6;
  const groups = {};
  trades.forEach((tr) => {
    const g = (groups[tr.isin] ||= { name: tr.name, buyQty: 0, buyAmt: 0, sellQty: 0, first: tr.date });
    if (tr.side === "buy") { g.buyQty += tr.qty; g.buyAmt += tr.amount; if (tr.date < g.first) g.first = tr.date; }
    else g.sellQty += tr.qty;
  });
  let list = [...investments];
  Object.entries(groups).forEach(([isin, g]) => {
    const net = g.buyQty - g.sellQty;
    const idx = list.findIndex((i) => i.source === "import" && i.isin === isin && i.accountId === accountId);
    if (net > EPS && g.buyQty > 0) {
      const cost = Math.round(((g.buyAmt / g.buyQty) * net) * 100) / 100;
      if (idx < 0) {
        list.unshift({
          id: uid(), name: g.name, invType: guessInvType(g.name), startDate: g.first, initialCapital: cost,
          currentValue: cost, contributionFrequency: "nessuno", contributionAmount: 0,
          accountId, isin, quantity: net, source: "import",
        });
      } else {
        const i = list[idx];
        list[idx] = {
          ...i,
          startDate: i.startDate && i.startDate < g.first ? i.startDate : g.first,
          initialCapital: Math.round((Number(i.initialCapital) + cost) * 100) / 100,
          currentValue: Math.round((Number(i.currentValue) + cost) * 100) / 100,
          quantity: Number(i.quantity || 0) + net,
        };
      }
    } else if (net < -EPS && idx >= 0) {
      const i = list[idx];
      const qty = Number(i.quantity || 0);
      const frac = qty > 0 ? Math.min(-net, qty) / qty : 1;
      list[idx] = {
        ...i,
        quantity: qty * (1 - frac),
        initialCapital: Math.round(Number(i.initialCapital) * (1 - frac) * 100) / 100,
        currentValue: Math.round(Number(i.currentValue) * (1 - frac) * 100) / 100,
      };
    }
  });
  // elimina le posizioni esaurite o con valore trascurabile
  return list.filter((i) => !(i.source === "import" && (Number(i.quantity || 0) < EPS || Number(i.currentValue) < 0.5)));
}

// ---------- Regole di categorizzazione automatica (per utente) ----------
// la prima regola il cui testo è contenuto nella descrizione (senza distinguere maiuscole) e dello stesso tipo
const matchRule = (rules, tx) => {
  const hay = `${tx.description || ""} ${tx.raw || ""}`.toUpperCase();
  return (rules || []).find((r) => r.type === tx.type && r.text && hay.includes(r.text.toUpperCase())) || null;
};
function ensureSubcategory(categories, type, catName, subName) {
  if (!subName) return categories;
  return {
    ...categories,
    [type]: (categories[type] || []).map((c) =>
      c.name.toLowerCase() !== catName.toLowerCase() || c.subcategories.some((x) => x.name.toLowerCase() === subName.toLowerCase())
        ? c
        : { ...c, subcategories: [...c.subcategories, { id: uid(), name: subName, createdAt: Date.now() }] }
    ),
  };
}

// ---------- Cestino (30 giorni) ----------
const TRASH_DAYS = 30;
const TRASH_MS = TRASH_DAYS * 24 * 60 * 60 * 1000;
const purgeTrash = (trash) => (trash || []).filter((e) => Date.now() - e.deletedAt < TRASH_MS);
// aggiunge una voce al cestino dello stato `next`
const withTrash = (next, kind, label, payload) => ({
  ...next,
  trash: [{ id: uid(), kind, label, payload, deletedAt: Date.now() }, ...(next.trash || [])],
});

const defaultAccountOf = (accounts) => accounts.find((a) => a.isDefault) || accounts[0] || null;

// Saldo corrente di ogni conto = saldo iniziale + movimenti effettivi (data odierna o passata) del conto
function computeAccountBalances(accounts, transactions) {
  const defId = defaultAccountOf(accounts)?.id;
  const ids = new Set(accounts.map((a) => a.id));
  const delta = {};
  const counts = {};
  transactions.forEach((t) => {
    const id = ids.has(t.accountId) ? t.accountId : defId;
    counts[id] = (counts[id] || 0) + 1;
    if (!isEffettivo(t)) return;
    delta[id] = (delta[id] || 0) + (t.type === "entrata" ? Number(t.amount) : -Number(t.amount));
  });
  return accounts.map((a) => ({ ...a, balance: Number(a.initialBalance || 0) + (delta[a.id] || 0), txCount: counts[a.id] || 0 }));
}

// Porta i dati salvati con versioni precedenti al modello a conti
function migrateState(s) {
  let accounts = s.accounts;
  if (!accounts) {
    accounts = (s.openingBalances || []).map((b, i) => ({
      id: b.id || uid(),
      name: (b.alignClosing ? String(b.name || "").replace(/ · saldo al .*$/, "") : b.name) || "Conto",
      type: b.category || BALANCE_TYPES[0],
      initialBalance: Number(b.value) || 0,
      isDefault: false,
      createdAt: i,
      ...(b.importKey ? { importKey: b.importKey, asOf: b.asOf, alignClosing: b.alignClosing } : {}),
    }));
  }
  if (accounts.length === 0) {
    accounts = [{ id: uid(), name: "Conto principale", type: BALANCE_TYPES[0], initialBalance: 0, isDefault: true, createdAt: 0 }];
  }
  if (!accounts.some((a) => a.isDefault)) {
    const idx = Math.max(0, accounts.findIndex((a) => a.type !== "Bene di valore"));
    accounts = accounts.map((a, i) => ({ ...a, isDefault: i === idx }));
  }
  const defId = accounts.find((a) => a.isDefault).id;
  const ids = new Set(accounts.map((a) => a.id));
  const byImport = new Map(accounts.filter((a) => a.importKey).map((a) => [a.importKey, a.id]));
  const transactions = (s.transactions || []).map((t) =>
    ids.has(t.accountId) ? t : { ...t, accountId: (t.importAccount && byImport.get(`opening:${t.importAccount}`)) || defId }
  );
  const recurring = (s.recurring || []).map((r) => (ids.has(r.accountId) ? r : { ...r, accountId: defId }));
  // giroconti creati con la vecchia categoria "Trasferimento tra conti": passano alla categoria giroconto attuale
  const transferName = (type) => ((s.categories?.[type] || []).find((c) => c.transfer) || {}).name || TRANSFER_CAT;
  const fixedTx = transactions.map((t) => {
    let x = t;
    if (x.category === LEGACY_TRANSFER_CAT) x = { ...x, category: transferName(x.type), isTransfer: true };
    if (x.transferId && !x.isTransfer) x = { ...x, isTransfer: true };
    return x;
  });
  const { openingBalances, ...rest } = s; // eslint-disable-line no-unused-vars
  return { ...rest, accounts, transactions: fixedTx, recurring };
}

const DEFAULT_STATE = {
  transactions: [],
  investments: [],
  accounts: [{ id: uid(), name: "Conto principale", type: "Conto bancario", initialBalance: 0, isDefault: true, createdAt: 0 }],
  recurring: [],
  budgets: [],
  importedKeys: [],
  settings: { txStatusFilter: "", txPageSize: 30, theme: "dark", accent: "oro" },
  trash: [],
  rules: [], // regole di categorizzazione automatica dell'utente: { id, text, type, category, subcategory } // preferenze dell'utente (es. filtro Effettivo/Previsto in Entrate/Uscite)
  categories: ensureSystemCategories({
    entrata: makeDefaultCategories(CATS_ENTRATA),
    uscita: makeDefaultCategories(CATS_USCITA),
  }),
};

const BALANCE_TYPES = ["Conto bancario", "Contanti", "Carta prepagata", "Bene di valore", "Altro"];

// ---------- Movimenti ricorrenti ----------
const RECUR_FREQ = [
  { id: "settimanale", label: "Settimanale" },
  { id: "mensile", label: "Mensile" },
  { id: "trimestrale", label: "Trimestrale" },
  { id: "semestrale", label: "Semestrale" },
  { id: "annuale", label: "Annuale" },
];
const RECUR_MONTHLY_FACTOR = { settimanale: 52 / 12, mensile: 1, trimestrale: 1 / 3, semestrale: 1 / 6, annuale: 1 / 12 };
const pad2 = (n) => String(n).padStart(2, "0");

function addMonthsClamped(iso, months) {
  const [y, m, d] = iso.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const dim = new Date(ny, nm + 1, 0).getDate();
  return `${ny}-${pad2(nm + 1)}-${pad2(Math.min(d, dim))}`;
}
function addDaysISO(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}
function recurOccurrences(rule, untilISO) {
  const out = [];
  const end = rule.endDate && rule.endDate < untilISO ? rule.endDate : untilISO;
  if (rule.frequency === "settimanale") {
    for (let i = 0; i < 2000; i++) {
      const dt = addDaysISO(rule.startDate, 7 * i);
      if (dt > end) break;
      out.push(dt);
    }
  } else {
    const k = CONTRIB_FREQ_MONTHS[rule.frequency] || 1;
    for (let i = 0; i < 1000; i++) {
      const dt = addMonthsClamped(rule.startDate, k * i);
      if (dt > end) break;
      out.push(dt);
    }
  }
  return out;
}
// ---------- Budget mensili ----------
const BUDGET_ALL = "__all__";
const budgetName = (b) => (b.category === BUDGET_ALL ? "Tutte le uscite" : b.subcategory ? `${b.category} › ${b.subcategory}` : b.category);
const BUDGET_COLORS = { ok: "var(--pos)", warn: "var(--warn)", over: "var(--neg)" };

function computeBudgetStatus(b, transactions, mk) {
  const match = (t) => t.type === "uscita" && isFlow(t) && monthKey(t.date) === mk && (b.category === BUDGET_ALL || (t.category === b.category && (!b.subcategory || t.subcategory === b.subcategory)));
  const spent = transactions.filter((t) => match(t) && isEffettivo(t)).reduce((s, t) => s + Number(t.amount), 0);
  const planned = transactions.filter((t) => match(t) && !isEffettivo(t)).reduce((s, t) => s + Number(t.amount), 0);
  const limit = Number(b.limit) || 0;
  const warnAt = Number(b.warnAt ?? 80);
  const alertAt = Number(b.alertAt ?? 100);
  const pct = limit > 0 ? (spent / limit) * 100 : 0;
  const projPct = limit > 0 ? ((spent + planned) / limit) * 100 : 0;
  const level = pct >= alertAt ? "over" : pct >= warnAt ? "warn" : "ok";
  const label = level === "ok" ? "Nei limiti" : level === "warn" ? "Attenzione" : pct > 100 ? "Superato" : pct === 100 ? "Esaurito" : "Soglia critica";
  return { spent, planned, limit, pct, projPct, remaining: limit - spent, level, label, warnAt, alertAt };
}

function recurNextDate(rule) {
  const today = todayISO();
  const skip = new Set(rule.skipDates || []);
  return recurOccurrences(rule, addMonthsClamped(today, 24)).find((d) => d >= today && !skip.has(d)) || null;
}

// Genera/aggiorna i movimenti delle ricorrenze (da oggi a +12 mesi). Idempotente.
function syncRecurring(state) {
  const rules = state.recurring || [];
  const today = todayISO();
  const horizon = addMonthsClamped(today, 12);
  const ruleIds = new Set(rules.map((r) => r.id));
  let changed = false;
  let list = state.transactions.filter((t) => {
    if (t.recurringId && !ruleIds.has(t.recurringId) && t.date > today) { changed = true; return false; }
    return true;
  });
  for (const r of rules) {
    let dates = recurOccurrences(r, horizon);
    if (!r.includePast) dates = dates.filter((d) => d >= today);
    const skip = new Set(r.skipDates || []);
    dates = dates.filter((d) => !skip.has(d));
    const wanted = new Set(dates);
    list = list.filter((t) => {
      if (t.recurringId !== r.id) return true;
      if (t.date > today && !wanted.has(t.date) && !t.recurringEdited) { changed = true; return false; }
      return true;
    });
    list = list.map((t) => {
      if (t.recurringId !== r.id || t.date <= today || t.recurringEdited) return t;
      const fresh = { ...t, type: r.type, amount: r.amount, category: r.category, subcategory: r.subcategory, description: r.description, accountId: r.accountId };
      if (["type", "amount", "category", "subcategory", "description", "accountId"].some((k) => fresh[k] !== t[k])) { changed = true; return fresh; }
      return t;
    });
    const have = new Set(list.filter((t) => t.recurringId === r.id).map((t) => t.date));
    const created = [];
    dates.forEach((d) => {
      if (!have.has(d)) {
        changed = true;
        created.push({ id: uid(), type: r.type, amount: r.amount, category: r.category, subcategory: r.subcategory, description: r.description, date: d, recurringId: r.id, accountId: r.accountId });
      }
    });
    if (created.length) list = [...created, ...list];
  }
  return changed ? { ...state, transactions: list } : state;
}

const PERIODS = [
  { id: "1m", label: "Mese", dir: "past", n: 1 },
  { id: "3m", label: "3M", dir: "past", n: 3 },
  { id: "6m", label: "6M", dir: "past", n: 6 },
  { id: "12m", label: "12M", dir: "past", n: 12 },
  { id: "all", label: "Tutto", dir: "all", n: null },
];

// Serie giornaliera del patrimonio: dal primo movimento a oggi (e fino all'ultimo movimento previsto)
function downsampleWeekly(out) {
  if (out.length <= 60) return out;
  const keep = new Set();
  for (let i = out.length - 1; i >= 0; i -= 7) keep.add(i);
  const lastEff = out.map((d) => d.isFuture).lastIndexOf(false);
  if (lastEff >= 0) keep.add(lastEff); // il punto di oggi c'è sempre
  return out.filter((_, i) => keep.has(i));
}
// intervallo personalizzato {from, to} (ISO), ordinato
const normRange = (range) => {
  const f = range?.from || "";
  const t = range?.to || "";
  return f && t && f > t ? { from: t, to: f } : { from: f, to: t };
};
const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);

function sliceDaily(daily, periodId, includeFuture, range) {
  if (!daily.length) return daily;
  if (periodId === "custom") {
    const { from, to } = normRange(range);
    if (!from || !to) return [];
    const arr = daily.filter((d) => d.date >= from && d.date <= to && (includeFuture || !d.isFuture));
    // oltre ~4 mesi un punto a settimana, come per i periodi lunghi
    return daysBetween(from, to) > 120 ? downsampleWeekly(arr) : arr;
  }
  const opt = PERIODS.find((p) => p.id === periodId) || PERIODS[2];
  const end = includeFuture ? daily.length : daily.filter((d) => !d.isFuture).length;
  let start = 0;
  if (opt.dir !== "all") {
    const from = addMonthsClamped(todayISO(), -opt.n);
    start = Math.max(0, daily.findIndex((d) => d.date >= from));
  }
  const out = daily.slice(start, Math.max(start + 1, end));
  // periodi lunghi: un punto a settimana (saldo a fine settimana) per un andamento leggibile; Mese e 3M restano giornalieri
  return periodId === "6m" || periodId === "12m" || periodId === "all" ? downsampleWeekly(out) : out;
}
// etichetta asse X: giorno/mese per periodi brevi, mese/anno per quelli lunghi
const dayTick = (periodId, range) => {
  let short = periodId === "1m" || periodId === "3m";
  if (periodId === "custom") { const r = normRange(range); short = !!r.from && !!r.to && daysBetween(r.from, r.to) <= 100; }
  return (iso) => (short ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : `${iso.slice(5, 7)}/${iso.slice(2, 4)}`);
};

function sliceTrendByPeriod(trendFull, periodId) {
  const opt = PERIODS.find((p) => p.id === periodId) || PERIODS[2];
  if (opt.dir === "all" || trendFull.length === 0) return trendFull;
  let curIdx = -1;
  for (let i = 0; i < trendFull.length; i++) {
    if (!trendFull[i].isFuture) curIdx = i;
  }
  const end = curIdx >= 0 ? curIdx + 1 : trendFull.length;
  const start = Math.max(0, end - opt.n);
  return trendFull.slice(start, end);
}

const CONTRIB_FREQ = [
  { id: "nessuno", label: "Nessuno" },
  { id: "mensile", label: "Mensile" },
  { id: "trimestrale", label: "Trimestrale" },
  { id: "semestrale", label: "Semestrale" },
  { id: "annuale", label: "Annuale" },
];
const CONTRIB_FREQ_UNIT = { mensile: "mese", trimestrale: "trimestre", semestrale: "semestre", annuale: "anno" };
const CONTRIB_FREQ_MONTHS = { mensile: 1, trimestrale: 3, semestrale: 6, annuale: 12 };

function computeContributionPeriods(startDate, frequency) {
  if (!startDate || !frequency || frequency === "nessuno") return 0;
  const start = new Date(startDate + "T00:00:00");
  const now = new Date();
  const monthsPerPeriod = CONTRIB_FREQ_MONTHS[frequency];
  if (!monthsPerPeriod) return 0;
  const startMonthIndex = start.getFullYear() * 12 + start.getMonth();
  const nowMonthIndex = now.getFullYear() * 12 + now.getMonth();
  const monthsInclusive = nowMonthIndex - startMonthIndex + 1;
  if (monthsInclusive <= 0) return 0;
  return Math.floor((monthsInclusive - 1) / monthsPerPeriod) + 1;
}

function computeInvestedTotal(inv) {
  const initial = Number(inv.initialCapital ?? inv.invested ?? 0);
  if (!(inv.contributionStartDate || inv.startDate) || !inv.contributionFrequency || inv.contributionFrequency === "nessuno" || !inv.contributionAmount) {
    return initial;
  }
  const periods = computeContributionPeriods(inv.contributionStartDate || inv.startDate, inv.contributionFrequency);
  return initial + periods * Number(inv.contributionAmount);
}

function simulateInvestment({ initial, contribution, frequency, annualReturn, years }) {
  const months = Math.max(1, Math.round(years * 12));
  const monthlyRate = Math.pow(1 + annualReturn / 100, 1 / 12) - 1;
  const freqMonths = CONTRIB_FREQ_MONTHS[frequency] || null;
  let balance = Number(initial) || 0;
  let invested = Number(initial) || 0;
  const series = [{ year: 0, invested, balance, gain: balance - invested }];
  for (let m = 1; m <= months; m++) {
    balance = balance * (1 + monthlyRate);
    if (freqMonths && contribution > 0 && m % freqMonths === 0) {
      balance += Number(contribution);
      invested += Number(contribution);
    }
    if (m % 12 === 0) {
      series.push({ year: m / 12, invested, balance, gain: balance - invested });
    }
  }
  const last = series[series.length - 1];
  return { series, finalBalance: last.balance, finalInvested: last.invested, finalGain: last.gain };
}

function computeSpeseCategoria(transactions, inPeriod) {
  const map = {};
  transactions
    .filter((t) => t.type === "uscita" && isFlow(t) && isEffettivo(t) && (!inPeriod || inPeriod(t)))
    .forEach((t) => { map[t.category] = (map[t.category] || 0) + Number(t.amount); });
  return Object.entries(map).map(([name, value]) => ({ name, value }));
}

function sortList(list, mode) {
  if (mode === "alpha") return [...list].sort((a, b) => a.name.localeCompare(b.name, "it"));
  if (mode === "chrono") return [...list].sort((a, b) => a.createdAt - b.createdAt);
  return list;
}

// ---------- Root ----------
// Vista dello stato limitata a un conto (movimenti, conto e investimenti collegati)
const viewForAccount = (st, id) => ({
  ...st,
  transactions: st.transactions.filter((t) => t.accountId === id),
  accounts: st.accounts.filter((a) => a.id === id),
  investments: st.investments.filter((i) => i.accountId === id),
});

function AccountFilter({ accounts, value, onChange }) {
  if (!accounts || accounts.length < 2) return null; // con un solo conto non c'è nulla da filtrare
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)" }}>
      Conto
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...styles.input, width: "auto", maxWidth: 220, padding: "6px 10px", fontSize: 12 }}>
        <option value="all">Tutti i conti</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
    </label>
  );
}

// Totali, serie e indicatori derivati dallo stato (o da una sua "vista", es. un solo conto)
function computeDerived(state) {
  const now = new Date();
  const curMonth = localISO(now).slice(0, 7);

  // entrate/uscite "vere": esclusi trasferimenti tra conti e movimenti da/verso investimenti
  const entrate = state.transactions.filter((t) => t.type === "entrata" && isEffettivo(t) && isFlow(t));
  const uscite = state.transactions.filter((t) => t.type === "uscita" && isEffettivo(t) && isFlow(t));

  const totEntrate = entrate.reduce((s, t) => s + Number(t.amount), 0);
  const totUscite = uscite.reduce((s, t) => s + Number(t.amount), 0);
  const accounts = computeAccountBalances(state.accounts, state.transactions);
  const totPatrimonioPartenza = accounts.reduce((s, a) => s + Number(a.initialBalance || 0), 0);
  const beniValore = accounts.filter((a) => a.type === "Bene di valore").reduce((s, a) => s + a.balance, 0);
  const liquidita = accounts.reduce((s, a) => s + a.balance, 0);
  const nonFlowNet = state.transactions
    .filter((t) => isEffettivo(t) && !isFlow(t))
    .reduce((s, t) => s + (t.type === "entrata" ? Number(t.amount) : -Number(t.amount)), 0);

  const entrateMese = entrate.filter((t) => monthKey(t.date) === curMonth).reduce((s, t) => s + Number(t.amount), 0);
  const usciteMese = uscite.filter((t) => monthKey(t.date) === curMonth).reduce((s, t) => s + Number(t.amount), 0);
  const saldoMese = entrateMese - usciteMese;

  const totInvestito = state.investments.reduce((s, i) => s + computeInvestedTotal(i), 0);
  const totInvestimenti = state.investments.reduce((s, i) => s + Number(i.currentValue || 0), 0);
  const plusMinus = totInvestimenti - totInvestito;
  const plusMinusPct = totInvestito > 0 ? (plusMinus / totInvestito) * 100 : 0;

  const patrimonioNetto = liquidita + totInvestimenti;

  const entratePrevistoTot = state.transactions
    .filter((t) => t.type === "entrata" && !isEffettivo(t) && isFlow(t))
    .reduce((s, t) => s + Number(t.amount), 0);
  const uscitePrevistoTot = state.transactions
    .filter((t) => t.type === "uscita" && !isEffettivo(t) && isFlow(t))
    .reduce((s, t) => s + Number(t.amount), 0);
  const saldoPrevistoTot = entratePrevistoTot - uscitePrevistoTot;

  const allocPerTipo = {};
  state.investments.forEach((i) => {
    allocPerTipo[i.invType] = (allocPerTipo[i.invType] || 0) + Number(i.currentValue || 0);
  });
  const allocData = Object.entries(allocPerTipo).map(([name, value]) => ({ name, value }));

  const allTxSorted = [...state.transactions].sort((a, b) => a.date.localeCompare(b.date));
  const byMonthDeltaEff = {};
  const byMonthDeltaAll = {};
  allTxSorted.forEach((t) => {
    const mk = monthKey(t.date);
    const delta = t.type === "entrata" ? Number(t.amount) : -Number(t.amount);
    byMonthDeltaAll[mk] = (byMonthDeltaAll[mk] || 0) + delta;
    if (isEffettivo(t)) byMonthDeltaEff[mk] = (byMonthDeltaEff[mk] || 0) + delta;
  });
  const hasPrevisto = state.transactions.some((t) => !isEffettivo(t));

  let fullMonths = [];
  if (allTxSorted.length > 0) {
    const firstMonth = monthKey(allTxSorted[0].date);
    const lastMonth = monthKey(allTxSorted[allTxSorted.length - 1].date);
    const startMonth = firstMonth < curMonth ? firstMonth : curMonth;
    const endMonth = lastMonth > curMonth ? lastMonth : curMonth;
    let cursor = new Date(startMonth + "-01T00:00:00");
    const end = new Date(endMonth + "-01T00:00:00");
    while (cursor <= end) {
      fullMonths.push(localISO(cursor).slice(0, 7));
      cursor.setMonth(cursor.getMonth() + 1);
    }
  } else {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      fullMonths.push(localISO(d).slice(0, 7));
    }
  }
  // Valore dei titoli in un dato mese: zero prima dell'apertura della posizione, poi cresce da capitale iniziale a valore attuale
  const monthIdx = (mk) => Number(mk.slice(0, 4)) * 12 + Number(mk.slice(5, 7));
  const invValueAt = (mk) =>
    state.investments.reduce((sum, inv) => {
      const cur = Number(inv.currentValue || 0);
      const startMk = inv.startDate ? monthKey(inv.startDate) : null;
      if (!startMk) return sum + cur;
      if (mk < startMk) return sum;
      const span = monthIdx(curMonth) - monthIdx(startMk);
      if (span <= 0 || mk >= curMonth) return sum + cur;
      const cap = Number(inv.initialCapital ?? inv.invested ?? 0);
      const frac = (monthIdx(mk) - monthIdx(startMk)) / span;
      return sum + cap + (cur - cap) * frac;
    }, 0);
  let runningEff = totPatrimonioPartenza;
  let runningAll = totPatrimonioPartenza;
  if (fullMonths.length > 60) {
    const dropped = fullMonths.slice(0, fullMonths.length - 60);
    dropped.forEach((mk) => { runningEff += byMonthDeltaEff[mk] || 0; runningAll += byMonthDeltaAll[mk] || 0; });
    fullMonths = fullMonths.slice(fullMonths.length - 60);
  }
  const trendFull = fullMonths.map((mk) => {
    runningEff += byMonthDeltaEff[mk] || 0;
    runningAll += byMonthDeltaAll[mk] || 0;
    return {
      monthKey: mk,
      month: mk.slice(5) + "/" + mk.slice(2, 4),
      isFuture: mk > curMonth,
      liquidita: runningEff,
      patrimonio: runningEff + invValueAt(mk),
      liquiditaPrevisto: runningAll,
      patrimonioPrevisto: runningAll + invValueAt(mk),
    };
  });

  // ---- serie giornaliera (per i grafici) ----
  const todayStr = localISO(now);
  const txDates = state.transactions.map((t) => t.date).sort();
  let dFirst = txDates.length && txDates[0] < addDaysISO(todayStr, -30) ? txDates[0] : addDaysISO(todayStr, -30);
  const dLast = txDates.length && txDates[txDates.length - 1] > todayStr ? txDates[txDates.length - 1] : todayStr;
  const dayEff = {};
  const dayAll = {};
  state.transactions.forEach((t) => {
    const delta = t.type === "entrata" ? Number(t.amount) : -Number(t.amount);
    dayAll[t.date] = (dayAll[t.date] || 0) + delta;
    if (isEffettivo(t)) dayEff[t.date] = (dayEff[t.date] || 0) + delta;
  });
  const dailyFull = [];
  {
    let rEff = totPatrimonioPartenza;
    let rAll = totPatrimonioPartenza;
    // movimenti precedenti all'inizio della finestra (se molto lunga) entrano nel saldo di partenza
    if (dFirst > txDates[0]) { for (const d of txDates) { if (d >= dFirst) break; rEff += dayEff[d] || 0; rAll += dayAll[d] || 0; } }
    let cursor = dFirst;
    for (let i = 0; i < 4000 && cursor <= dLast; i++) {
      rEff += dayEff[cursor] || 0;
      rAll += dayAll[cursor] || 0;
      const isFuture = cursor > todayStr;
      const inv = invValueAt(cursor.slice(0, 7));
      dailyFull.push({
        date: cursor,
        isFuture,
        liquidita: isFuture ? null : Math.round(rEff * 100) / 100,
        patrimonio: isFuture ? null : Math.round((rEff + inv) * 100) / 100,
        patrimonioPrevisto: Math.round((rAll + inv) * 100) / 100,
      });
      cursor = addDaysISO(cursor, 1);
    }
  }

  return {
    dailyFull,
    totEntrate, totUscite, liquidita,
    entrateMese, usciteMese, saldoMese,
    totInvestito, totInvestimenti, plusMinus, plusMinusPct,
    patrimonioNetto, allocData, trendFull, hasPrevisto,
    entratePrevistoTot, uscitePrevistoTot, saldoPrevistoTot, totPatrimonioPartenza, beniValore,
    accounts, nonFlowNet,
  };
}

export default function FinanzeApp({ userEmail }) {
  const [state, setState] = useState(DEFAULT_STATE);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTabState] = useState("dashboard");

  // Tab attiva persistente al refresh (salvata nell'hash dell'URL, es. /#budget)
  useEffect(() => {
    const fromHash = window.location.hash.slice(1);
    if (TAB_IDS.includes(fromHash)) setTabState(fromHash);
  }, []);
  const setTab = useCallback((id) => {
    setTabState(id);
    window.history.replaceState(null, "", id === "dashboard" ? window.location.pathname : `#${id}`);
  }, []);
  const [saveFlash, setSaveFlash] = useState(false);
  const [confirmDlg, setConfirmDlg] = useState(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [advisorMessages, setAdvisorMessages] = useState([]);

  const [showTxModal, setShowTxModal] = useState(false);
  const [editingTx, setEditingTx] = useState(null);
  const [showInvModal, setShowInvModal] = useState(false);
  const [editingInv, setEditingInv] = useState(null);
  const [closingInv, setClosingInv] = useState(null);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState(null);
  const [showRecurringModal, setShowRecurringModal] = useState(false);
  const [editingRecurring, setEditingRecurring] = useState(null);
  const [showBudgetModal, setShowBudgetModal] = useState(false);
  const [editingBudget, setEditingBudget] = useState(null);

  // load
  useEffect(() => {
    (async () => {
      try {
        const res = await storage.get(STORAGE_KEY, false);
        if (res && res.value) {
          const parsed = JSON.parse(res.value);
          const loadedState = buildLoadedState(parsed);
          const syncedState = syncRecurring(loadedState);
          setState(syncedState);
          if (!parsed.accounts || syncedState !== loadedState || (parsed.trash || []).length !== (syncedState.trash || []).length) {
            try { await storage.set(STORAGE_KEY, JSON.stringify(syncedState), false); } catch (e) { /* ignore */ }
          }
        }
      } catch (e) {
        // nessun dato salvato ancora
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const persist = useCallback(async (raw) => {
    // elimina definitivamente dal cestino ciò che ha più di 30 giorni
    const next = raw.trash && raw.trash.length !== purgeTrash(raw.trash).length ? { ...raw, trash: purgeTrash(raw.trash) } : raw;
    setState(next);
    try {
      await storage.set(STORAGE_KEY, JSON.stringify(next), false);
      setSaveFlash(true);
      setTimeout(() => setSaveFlash(false), 900);
    } catch (e) {
      console.error("Storage error", e);
    }
  }, []);

  // ---------- Transactions ----------
  const openNewTx = () => { setEditingTx(null); setShowTxModal(true); };
  const openEditTx = (tx) => { setEditingTx(tx); setShowTxModal(true); };
  const saveTransaction = (tx) => {
    if (tx.id) {
      const old = state.transactions.find((t) => t.id === tx.id);
      let recurring = state.recurring;
      if (old?.recurringId && old.date !== tx.date) {
        recurring = recurring.map((r) => (r.id === old.recurringId ? { ...r, skipDates: [...(r.skipDates || []), old.date] } : r));
      }
      persist({
        ...state,
        recurring,
        transactions: state.transactions.map((t) => (t.id === tx.id ? { ...t, ...tx, ...(t.recurringId ? { recurringEdited: true } : {}) } : t)),
      });
    } else {
      persist({ ...state, transactions: [{ ...tx, id: uid() }, ...state.transactions] });
    }
    setShowTxModal(false);
  };
  // Giroconto: crea l'uscita sul conto di origine e l'entrata sul conto di destinazione (stessa data; l'accredito si può cambiare poi)
  const setPref = (patch) => persist({ ...state, settings: { ...state.settings, ...patch } });
  // applica tema e colore dell'utente (anche appena caricati dal suo profilo)
  useEffect(() => { applyPrefs(state.settings?.theme, state.settings?.accent); }, [state.settings?.theme, state.settings?.accent]);
  const setTxPageSize = (value) => persist({ ...state, settings: { ...state.settings, txPageSize: value } });
  const setTxStatusFilter = (value) => persist({ ...state, settings: { ...state.settings, txStatusFilter: value } });
  const saveTransfer = ({ amount, fromId, toId, description, date }) => {
    const transferId = uid();
    const nameOf = (type) => (state.categories[type].find((c) => c.transfer) || {}).name || TRANSFER_CAT;
    const from = state.accounts.find((a) => a.id === fromId);
    const to = state.accounts.find((a) => a.id === toId);
    const base = { amount, subcategory: null, transferId, isTransfer: true, date };
    const out = { ...base, id: uid(), type: "uscita", category: nameOf("uscita"), accountId: fromId, description: description || `Giroconto verso ${to?.name || "altro conto"}` };
    const inn = { ...base, id: uid(), type: "entrata", category: nameOf("entrata"), accountId: toId, opDate: date, description: description || `Giroconto da ${from?.name || "altro conto"}` };
    persist({ ...state, transactions: [out, inn, ...state.transactions] });
    setShowTransferModal(false);
  };
  // Cambia solo la categoria di più movimenti (map: tipo -> nome categoria). La sottocategoria resta solo se esiste anche nella nuova categoria.
  const bulkSetCategory = (ids, map) => {
    const idSet = new Set(ids);
    const transactions = state.transactions.map((t) => {
      if (!idSet.has(t.id)) return t;
      const cat = map[t.type];
      if (!cat || cat === t.category) return t;
      const catObj = (state.categories[t.type] || []).find((c) => c.name === cat);
      const keepSub = t.subcategory && catObj?.subcategories.some((x) => x.name === t.subcategory) ? t.subcategory : null;
      return { ...t, category: cat, subcategory: keepSub, ...(t.recurringId ? { recurringEdited: true } : {}) };
    });
    persist({ ...state, transactions });
  };
  const removeTransactions = (ids) => {
    const idSet = new Set(ids);
    // un trasferimento tra conti si elimina su entrambi i conti
    const tIds = new Set(state.transactions.filter((t) => idSet.has(t.id) && t.transferId).map((t) => t.transferId));
    state.transactions.forEach((t) => { if (t.transferId && tIds.has(t.transferId)) idSet.add(t.id); });
    let recurring = state.recurring;
    const removed = state.transactions.filter((t) => idSet.has(t.id));
    const skips = [];
    removed.filter((t) => t.recurringId).forEach((tx) => {
      skips.push({ ruleId: tx.recurringId, date: tx.date });
      recurring = recurring.map((r) => (r.id === tx.recurringId ? { ...r, skipDates: [...(r.skipDates || []), tx.date] } : r));
    });
    if (removed.length === 0) return;
    const label = removed.length === 1
      ? `${removed[0].description || removed[0].category} · ${removed[0].type === "entrata" ? "+" : "−"}${fmtFull(removed[0].amount)}`
      : `${removed.length} movimenti`;
    persist(withTrash({ ...state, recurring, transactions: state.transactions.filter((t) => !idSet.has(t.id)) }, "transactions", label, { items: removed, skips }));
  };
  const removeTransaction = (id) => removeTransactions([id]);

  // ---------- Import estratto conto ----------
  const importStatement = ({ transactions: newTx, account, tag, trades }) => {
    const tagKeys = new Set(tag ? tag.keys : []);
    let accounts = state.accounts;
    if (account) {
      accounts = account.isNew
        ? [...accounts, { ...account.fields, id: account.id, isDefault: false, createdAt: Date.now() }]
        : accounts.map((a) => (a.id === account.id ? { ...a, ...account.fields } : a));
    }
    // categorie suggerite dall'import (es. "Investimenti") non ancora presenti: le creo
    let categories = state.categories;
    newTx.forEach((t) => { categories = ensureSubcategory(ensureCategory(categories, t.type, t.category), t.type, t.category, t.subcategory); });
    persist({
      ...state,
      categories,
      accounts,
      investments: trades && trades.length ? applyTrades(state.investments, trades, account.id) : state.investments,
      // i movimenti importati in precedenza (senza conto) vengono associati al conto di questo estratto
      transactions: [
        ...newTx,
        ...state.transactions.map((t) => (tag && !t.importAccount && t.importKey && tagKeys.has(t.importKey) ? { ...t, importAccount: tag.account, accountId: tag.accountId } : t)),
      ],
    });
  };

  // ---------- Regole di categorizzazione automatica ----------
  const addRule = ({ text, type, category, subcategory }) => {
    // se la sottocategoria esiste già (anche con maiuscole diverse) uso il nome esistente
    const existingSub = (state.categories[type] || []).find((c) => c.name === category)?.subcategories.find((x) => x.name.toLowerCase() === (subcategory || "").toLowerCase());
    const rule = { id: uid(), text: text.trim(), type, category, subcategory: existingSub ? existingSub.name : subcategory || null };
    persist({
      ...state,
      categories: ensureSubcategory(ensureCategory(state.categories, type, category), type, category, rule.subcategory),
      rules: [...(state.rules || []), rule],
    });
  };
  const matchingForRule = (rule) =>
    state.transactions.filter((t) => t.type === rule.type && (t.description || "").toUpperCase().includes(rule.text.toUpperCase()) && (t.category !== rule.category || (t.subcategory || null) !== (rule.subcategory || null)) && !(t.transferId || t.isTransfer));
  const applyRuleToExisting = (ruleId) => {
    const rule = state.rules.find((r) => r.id === ruleId);
    if (!rule) return;
    const ids = new Set(matchingForRule(rule).map((t) => t.id));
    if (ids.size === 0) return askInfo("Nessun movimento da aggiornare", `Nessun movimento contiene «${rule.text}» con una categoria diversa da quella della regola.`);
    askDelete(
      "Applica la regola",
      `Aggiornare ${ids.size} moviment${ids.size === 1 ? "o" : "i"} che contengono «${rule.text}» in «${rule.category}${rule.subcategory ? ` › ${rule.subcategory}` : ""}»? La categoria attuale verrà sostituita.`,
      () => persist({ ...state, transactions: state.transactions.map((t) => (ids.has(t.id) ? { ...t, category: rule.category, subcategory: rule.subcategory || null } : t)) }),
      "Applica",
      { permanent: true }
    );
  };
  const confirmRemoveRule = (ruleId) => {
    const rule = state.rules.find((r) => r.id === ruleId);
    askDelete("Elimina regola", `Vuoi eliminare la regola «${rule?.text || ""}»? I movimenti già categorizzati non cambiano.`, () => persist({ ...state, rules: state.rules.filter((r) => r.id !== ruleId) }), "Elimina", { permanent: true });
  };

  // ---------- Backup: ripristino ----------
  const restoreFromFile = async (file) => {
    let parsed;
    try {
      parsed = parseBackup(await file.text());
    } catch (e) {
      return askInfo("Backup non valido", e.message || "Impossibile leggere il file.");
    }
    const when = parsed.exportedAt ? new Date(parsed.exportedAt).toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" }) : "data sconosciuta";
    askDelete(
      "Ripristina da backup",
      `Il backup (${when}) contiene: ${stateSummary(parsed.state)}. Sostituirà TUTTI i dati attuali (${stateSummary(state)}). Prima del ripristino viene scaricata automaticamente una copia dei dati attuali.`,
      () => {
        downloadFile(`finanze-backup-prima-del-ripristino-${todayISO()}.json`, "application/json", buildBackup(state));
        persist(syncRecurring(buildLoadedState(parsed.state)));
        setShowSettings(false);
      },
      "Ripristina",
      { permanent: true }
    );
  };

  // ---------- Cestino: ripristino ----------
  const restoreFromTrash = (entryId) => {
    const e = (state.trash || []).find((x) => x.id === entryId);
    if (!e) return;
    let next = { ...state, trash: state.trash.filter((x) => x.id !== entryId) };
    const pl = e.payload;
    if (e.kind === "transactions") {
      const accIds = new Set(state.accounts.map((a) => a.id));
      const defId = defaultAccountOf(state.accounts).id;
      const items = pl.items.map((t) => (accIds.has(t.accountId) ? t : { ...t, accountId: defId }));
      let recurring = next.recurring;
      (pl.skips || []).forEach(({ ruleId, date }) => {
        recurring = recurring.map((r) => (r.id === ruleId ? { ...r, skipDates: (r.skipDates || []).filter((d) => d !== date) } : r));
      });
      next = { ...next, recurring, transactions: [...items, ...next.transactions] };
    } else if (e.kind === "investment") {
      next = { ...next, investments: [pl.investment, ...next.investments] };
    } else if (e.kind === "budget") {
      next = { ...next, budgets: [...next.budgets, pl.budget] };
    } else if (e.kind === "recurring") {
      next = syncRecurring({ ...next, recurring: [pl.rule, ...next.recurring] });
    } else if (e.kind === "account") {
      next = { ...next, accounts: [...next.accounts, { ...pl.account, isDefault: !next.accounts.some((a) => a.isDefault) }] };
    } else if (e.kind === "category") {
      const list = next.categories[pl.type];
      const clash = list.some((c) => c.name.toLowerCase() === pl.category.name.toLowerCase());
      const cat = clash ? { ...pl.category, name: `${pl.category.name} (ripristinata)` } : pl.category;
      const copy = [...list];
      copy.splice(Math.min(pl.index, copy.length), 0, cat);
      next = { ...next, categories: { ...next.categories, [pl.type]: copy } };
    } else if (e.kind === "subcategory") {
      const cat = next.categories[pl.type].find((c) => c.id === pl.catId);
      if (!cat) return askInfo("Impossibile ripristinare", "La categoria di questa sottocategoria è stata eliminata: ripristina prima la categoria dal Cestino.");
      if (cat.subcategories.some((x) => x.name.toLowerCase() === pl.sub.name.toLowerCase())) return askInfo("Impossibile ripristinare", `Esiste già una sottocategoria "${pl.sub.name}" in "${cat.name}".`);
      next = { ...next, categories: { ...next.categories, [pl.type]: next.categories[pl.type].map((c) => (c.id === pl.catId ? { ...c, subcategories: [...c.subcategories, pl.sub] } : c)) } };
    }
    persist(next);
  };
  const deleteForever = (entryId) => persist({ ...state, trash: state.trash.filter((x) => x.id !== entryId) });
  const confirmDeleteForever = (entryId) => {
    const e = state.trash.find((x) => x.id === entryId);
    askDelete("Elimina definitivamente", `Vuoi eliminare per sempre "${e?.label || ""}"? Non potrai più ripristinarlo.`, () => deleteForever(entryId), "Elimina per sempre", { permanent: true });
  };
  const confirmEmptyTrash = () =>
    askDelete("Svuota cestino", `Vuoi eliminare per sempre tutti i ${state.trash.length} elementi del cestino? Non potrai più ripristinarli.`, () => persist({ ...state, trash: [] }), "Svuota cestino", { permanent: true });

  // ---------- Conferma eliminazione ----------
  const askDelete = (title, message, onConfirm, confirmLabel = "Elimina", opts = {}) =>
    setConfirmDlg({ title, message: opts.permanent ? message : `${message} Resta nel Cestino per ${TRASH_DAYS} giorni: potrai ripristinarlo.`, confirmLabel, onConfirm });
  const confirmRemoveTx = (id) => {
    const t = state.transactions.find((x) => x.id === id);
    askDelete(
      "Elimina movimento",
      `Vuoi eliminare ${t ? `"${t.description || t.category}" (${t.type === "entrata" ? "+" : "−"}${fmtFull(t.amount)})` : "questo movimento"}?${t?.recurringId ? " Fa parte di una ricorrenza: verrà rimossa solo questa occorrenza." : ""}${t?.transferId ? " È un trasferimento tra conti: verrà eliminato anche sull'altro conto." : ""}`,
      () => removeTransaction(id)
    );
  };
  const confirmRemoveTxs = (ids) =>
    askDelete(
      "Elimina movimenti",
      `Vuoi eliminare ${ids.length} moviment${ids.length === 1 ? "o" : "i"} selezionat${ids.length === 1 ? "o" : "i"}?${state.transactions.some((t) => ids.includes(t.id) && t.transferId) ? " I trasferimenti tra conti verranno eliminati su entrambi i conti." : ""}`,
      () => removeTransactions(ids),
      `Elimina ${ids.length}`
    );
  const askInfo = (title, message) => setConfirmDlg({ title, message, infoOnly: true });
  const confirmRemoveAccount = (id) => {
    const a = derived.accounts.find((x) => x.id === id);
    if (!a) return;
    if (state.accounts.length <= 1) return askInfo("Impossibile eliminare", "Serve almeno un conto: crea prima un altro conto, poi potrai eliminare questo.");
    if (a.txCount > 0) return askInfo("Impossibile eliminare", `Il conto "${a.name}" ha ${a.txCount} moviment${a.txCount === 1 ? "o" : "i"}. Eliminali o spostali su un altro conto prima di eliminare il conto.`);
    askDelete("Elimina conto", `Vuoi eliminare il conto "${a.name}"?${a.isDefault ? " Il conto predefinito passerà al primo conto rimasto." : ""}`, () => removeAccount(id));
  };
  const confirmRemoveRecurring = (id) => {
    const r = state.recurring.find((x) => x.id === id);
    askDelete("Elimina ricorrenza", `Vuoi eliminare la ricorrenza "${r?.description || r?.category || ""}"? Verranno rimossi anche i movimenti futuri da essa generati.`, () => removeRecurring(id));
  };
  const confirmRemoveBudget = (id) => {
    const b = state.budgets.find((x) => x.id === id);
    askDelete("Elimina budget", `Vuoi eliminare il budget "${b ? budgetName(b) : ""}"?`, () => removeBudget(id));
  };
  const confirmRemoveInvestment = (id) => {
    const i = state.investments.find((x) => x.id === id);
    askDelete("Elimina investimento", `Vuoi eliminare definitivamente "${i?.name || "questa posizione"}"? Non verrà creato alcun movimento. Per chiuderla incassando il netto usa "Chiudi posizione".`, () => removeInvestment(id));
  };
  const confirmDeleteCategory = (type, id) => {
    const c = (state.categories[type] || []).find((x) => x.id === id);
    askDelete("Elimina categoria", `Vuoi eliminare la categoria "${c?.name || ""}" e le sue sottocategorie? I movimenti già registrati manterranno il nome della categoria.`, () => deleteCategory(type, id));
  };
  const confirmDeleteSubcategory = (type, catId, subId) => {
    const c = (state.categories[type] || []).find((x) => x.id === catId);
    const sub = c?.subcategories.find((x) => x.id === subId);
    askDelete("Elimina sottocategoria", `Vuoi eliminare la sottocategoria "${sub?.name || ""}"?`, () => deleteSubcategory(type, catId, subId));
  };

  // ---------- Recurring ----------
  const openNewRecurring = () => { setEditingRecurring(null); setShowRecurringModal(true); };
  const openEditRecurring = (r) => { setEditingRecurring(r); setShowRecurringModal(true); };
  const saveRecurring = (r) => {
    const recurring = r.id
      ? state.recurring.map((x) => (x.id === r.id ? { ...x, ...r } : x))
      : [{ ...r, id: uid(), skipDates: [] }, ...state.recurring];
    persist(syncRecurring({ ...state, recurring }));
    setShowRecurringModal(false);
  };
  // Ricrea le occorrenze future saltate (eliminate una a una): azzera solo le date da oggi in avanti, non quelle passate
  const regenerateRecurring = (id) => {
    const today = todayISO();
    const recurring = state.recurring.map((r) => (r.id === id ? { ...r, skipDates: (r.skipDates || []).filter((d) => d < today) } : r));
    persist(syncRecurring({ ...state, recurring }));
  };
  const confirmRegenerateRecurring = (id) => {
    const rule = state.recurring.find((r) => r.id === id);
    if (!rule) return;
    const today = todayISO();
    const skipped = new Set(rule.skipDates || []);
    const toCreate = recurOccurrences(rule, addMonthsClamped(today, 12)).filter((d) => d >= today && skipped.has(d));
    if (toCreate.length === 0) return askInfo("Niente da rigenerare", `La ricorrenza «${rule.description || rule.category}» non ha occorrenze future saltate: i movimenti previsti sono già tutti presenti.`);
    askDelete(
      "Rigenera movimenti futuri",
      `Verranno ricreati ${toCreate.length} movimenti previsti di «${rule.description || rule.category}» (dal ${formatDate(toCreate[0])} al ${formatDate(toCreate[toCreate.length - 1])}), che erano stati eliminati. I movimenti passati non cambiano.`,
      () => regenerateRecurring(id),
      "Rigenera",
      { permanent: true }
    );
  };
  const removeRecurring = (id) => {
    const rule = state.recurring.find((r) => r.id === id);
    if (!rule) return;
    persist(syncRecurring(withTrash({ ...state, recurring: state.recurring.filter((r) => r.id !== id) }, "recurring", rule.description || rule.category, { rule })));
  };

  // ---------- Budgets ----------
  const openNewBudget = () => { setEditingBudget(null); setShowBudgetModal(true); };
  const openEditBudget = (b) => { setEditingBudget(b); setShowBudgetModal(true); };
  const saveBudget = (b) => {
    const budgets = b.id
      ? state.budgets.map((x) => (x.id === b.id ? { ...x, ...b } : x))
      : [...state.budgets, { ...b, id: uid() }];
    persist({ ...state, budgets });
    setShowBudgetModal(false);
  };
  const removeBudget = (id) => {
    const budget = state.budgets.find((b) => b.id === id);
    if (!budget) return;
    persist(withTrash({ ...state, budgets: state.budgets.filter((b) => b.id !== id) }, "budget", budgetName(budget), { budget }));
  };

  // ---------- Investments ----------
  const openNewInv = () => { setEditingInv(null); setShowInvModal(true); };
  const openEditInv = (inv) => { setEditingInv(inv); setShowInvModal(true); };
  const saveInvestment = (inv) => {
    const { withdraw, ...data } = inv;
    if (data.id) {
      persist({ ...state, investments: state.investments.map((i) => (i.id === data.id ? { ...i, ...data } : i)) });
    } else {
      let transactions = state.transactions;
      let categories = state.categories;
      // il capitale iniziale esce dal conto scelto (registrato come movimento "Investimenti")
      if (withdraw && Number(data.initialCapital) > 0) {
        categories = ensureCategory(categories, "uscita", "Investimenti");
        transactions = [
          {
            id: uid(),
            type: "uscita",
            amount: Number(data.initialCapital),
            category: "Investimenti",
            subcategory: null,
            description: `Apertura posizione "${data.name}" (${data.invType})`,
            date: data.startDate || todayISO(),
            accountId: data.accountId,
          },
          ...transactions,
        ];
      }
      persist({ ...state, categories, transactions, investments: [{ ...data, id: uid() }, ...state.investments] });
    }
    setShowInvModal(false);
  };
  const removeInvestment = (id) => {
    const investment = state.investments.find((i) => i.id === id);
    if (!investment) return;
    persist(withTrash({ ...state, investments: state.investments.filter((i) => i.id !== id) }, "investment", investment.name, { investment }));
  };
  const updateInvestmentValue = (id, value) => {
    persist({ ...state, investments: state.investments.map((i) => (i.id === id ? { ...i, currentValue: value } : i)) });
  };
  const openCloseInv = (inv) => setClosingInv(inv);
  const confirmCloseInvestment = (inv, { closeDate, fees, netAmount }) => {
    const investedTotal = computeInvestedTotal(inv);
    const catType = netAmount >= 0 ? "entrata" : "uscita";
    const catName = "Disinvestimento";
    const existingCat = (state.categories[catType] || []).find((c) => c.name.toLowerCase() === catName.toLowerCase());
    const categoriesNext = existingCat
      ? state.categories
      : { ...state.categories, [catType]: [...(state.categories[catType] || []), { id: uid(), name: catName, subcategories: [], createdAt: Date.now() }] };
    const description = `Chiusura posizione "${inv.name}" (${inv.invType}) · capitale versato ${fmtFull(investedTotal)}${fees > 0 ? `, tasse/commissioni ${fmtFull(fees)}` : ""}`;
    const tx = {
      id: uid(),
      type: catType,
      amount: Math.abs(netAmount),
      category: catName,
      subcategory: null,
      description,
      date: closeDate,
      accountId: state.accounts.some((a) => a.id === inv.accountId) ? inv.accountId : defaultAccountOf(state.accounts).id,
    };
    persist({
      ...state,
      categories: categoriesNext,
      investments: state.investments.filter((i) => i.id !== inv.id),
      transactions: [tx, ...state.transactions],
    });
    setClosingInv(null);
  };

  // ---------- Conti (Gestione Conti) ----------
  const openNewAccount = () => { setEditingAccount(null); setShowAccountModal(true); };
  const openEditAccount = (a) => { setEditingAccount(a); setShowAccountModal(true); };
  const saveAccount = (a) => {
    const id = a.id || uid();
    let accounts = a.id
      ? state.accounts.map((x) => (x.id === a.id ? { ...x, ...a } : x))
      : [...state.accounts, { ...a, id, createdAt: Date.now() }];
    // un solo conto predefinito alla volta
    if (a.isDefault) accounts = accounts.map((x) => ({ ...x, isDefault: x.id === id }));
    if (!accounts.some((x) => x.isDefault)) accounts = accounts.map((x, i) => ({ ...x, isDefault: i === 0 }));
    persist({ ...state, accounts });
    setShowAccountModal(false);
  };
  const setDefaultAccount = (id) => persist({ ...state, accounts: state.accounts.map((x) => ({ ...x, isDefault: x.id === id })) });
  const removeAccount = (id) => {
    const account = state.accounts.find((x) => x.id === id);
    if (!account) return;
    let accounts = state.accounts.filter((x) => x.id !== id);
    if (!accounts.some((x) => x.isDefault)) accounts = accounts.map((x, i) => ({ ...x, isDefault: i === 0 }));
    persist(withTrash({ ...state, accounts }, "account", account.name, { account: { ...account, isDefault: false } }));
  };

  // ---------- Categories ----------
  const updateCategories = (type, updater) => {
    persist({ ...state, categories: { ...state.categories, [type]: updater(state.categories[type]) } });
  };
  const addCategory = (type, name) => {
    const list = state.categories[type];
    if (list.some((c) => c.name.toLowerCase() === name.toLowerCase())) return;
    updateCategories(type, (l) => [...l, { id: uid(), name, subcategories: [], createdAt: Date.now() }]);
  };
  const renameCategory = (type, id, name) => {
    const cat = state.categories[type].find((c) => c.id === id);
    const categories = { ...state.categories, [type]: state.categories[type].map((c) => (c.id === id ? { ...c, name } : c)) };
    // rinominando la categoria dei giroconti, anche i giroconti già registrati la seguono
    const transactions = cat?.transfer
      ? state.transactions.map((t) => (t.type === type && (t.isTransfer || t.transferId) ? { ...t, category: name } : t))
      : state.transactions;
    persist({ ...state, categories, transactions });
  };
  const deleteCategory = (type, id) => {
    const list = state.categories[type];
    const index = list.findIndex((c) => c.id === id);
    if (index < 0) return;
    persist(withTrash({ ...state, categories: { ...state.categories, [type]: list.filter((c) => c.id !== id) } }, "category", `${list[index].name} (${type === "entrata" ? "entrate" : "uscite"})`, { type, category: list[index], index }));
  };
  const moveCategory = (type, id, dir) => updateCategories(type, (l) => {
    const idx = l.findIndex((c) => c.id === id);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= l.length) return l;
    const copy = [...l];
    [copy[idx], copy[newIdx]] = [copy[newIdx], copy[idx]];
    return copy;
  });
  const addSubcategory = (type, catId, name) => updateCategories(type, (l) => l.map((c) => {
    if (c.id !== catId) return c;
    if (c.subcategories.some((s) => s.name.toLowerCase() === name.toLowerCase())) return c;
    return { ...c, subcategories: [...c.subcategories, { id: uid(), name, createdAt: Date.now() }] };
  }));
  const renameSubcategory = (type, catId, subId, name) => updateCategories(type, (l) => l.map((c) =>
    c.id !== catId ? c : { ...c, subcategories: c.subcategories.map((s) => (s.id === subId ? { ...s, name } : s)) }
  ));
  const deleteSubcategory = (type, catId, subId) => {
    const cat = state.categories[type].find((c) => c.id === catId);
    const sub = cat?.subcategories.find((s) => s.id === subId);
    if (!cat || !sub) return;
    const categories = { ...state.categories, [type]: state.categories[type].map((c) => (c.id !== catId ? c : { ...c, subcategories: c.subcategories.filter((s) => s.id !== subId) })) };
    persist(withTrash({ ...state, categories }, "subcategory", `${cat.name} › ${sub.name}`, { type, catId, sub }));
  };
  const moveSubcategory = (type, catId, subId, dir) => updateCategories(type, (l) => l.map((c) => {
    if (c.id !== catId) return c;
    const idx = c.subcategories.findIndex((s) => s.id === subId);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= c.subcategories.length) return c;
    const copy = [...c.subcategories];
    [copy[idx], copy[newIdx]] = [copy[newIdx], copy[idx]];
    return { ...c, subcategories: copy };
  }));

  // ---------- Derived / interconnected totals ----------
  const derived = useMemo(() => computeDerived(state), [state]);

  if (!loaded) {
    return (
      <div style={styles.loadingScreen}>
        <div style={styles.loadingText}>caricamento registro…</div>
      </div>
    );
  }

  return (
    <div style={styles.app}>
      <FontImport />
      <MobileNav tab={tab} setTab={setTab} patrimonio={derived.patrimonioNetto} liquidita={derived.liquidita} investimenti={derived.totInvestimenti} userEmail={userEmail} saveFlash={saveFlash} trashCount={(state.trash || []).length} onSettings={() => setShowSettings(true)} />
      <div style={styles.shell} className="app-shell">
        <Header saveFlash={saveFlash} patrimonio={derived.patrimonioNetto} liquidita={derived.liquidita} investimenti={derived.totInvestimenti} userEmail={userEmail} onSettings={() => setShowSettings(true)} />
        <Nav tab={tab} setTab={setTab} trashCount={(state.trash || []).length} />

        <div style={styles.content}>
          {tab === "dashboard" && <Dashboard derived={derived} state={state} />}
          {tab === "movimenti" && (
            <Movimenti
              transactions={state.transactions}
              onAdd={openNewTx}
              onEdit={openEditTx}
              onRemove={confirmRemoveTx}
              onRemoveMany={confirmRemoveTxs}
              onImport={() => setShowImportModal(true)}
              onGiroconto={() => setShowTransferModal(true)}
              categories={state.categories}
              onBulkCategory={bulkSetCategory}
              pageSize={state.settings?.txPageSize || 30}
              onPageSize={setTxPageSize}
              statusFilter={state.settings?.txStatusFilter || ""}
              onStatusFilter={setTxStatusFilter}
              accounts={derived.accounts}
              recurring={state.recurring}
              onAddRecurring={openNewRecurring}
              onEditRecurring={openEditRecurring}
              onRemoveRecurring={confirmRemoveRecurring}
              onRegenerateRecurring={confirmRegenerateRecurring}
            />
          )}
          {tab === "budget" && (
            <BudgetTab
              budgets={state.budgets}
              transactions={state.transactions}
              onAdd={openNewBudget}
              onEdit={openEditBudget}
              onRemove={confirmRemoveBudget}
            />
          )}
          {tab === "investimenti" && (
            <Investimenti
              investments={state.investments}
              derived={derived}
              onAdd={openNewInv}
              onEdit={openEditInv}
              onRemove={confirmRemoveInvestment}
              onUpdateValue={updateInvestmentValue}
              onClosePosition={openCloseInv}
              accounts={derived.accounts}
            />
          )}
          {tab === "patrimonio" && (
            <Patrimonio
              derived={derived}
              state={state}
              onAddAccount={openNewAccount}
              onEditAccount={openEditAccount}
              onRemoveAccount={confirmRemoveAccount}
              onSetDefaultAccount={setDefaultAccount}
            />
          )}
          {tab === "cestino" && (
            <TrashTab items={state.trash || []} onRestore={restoreFromTrash} onDelete={confirmDeleteForever} onEmpty={confirmEmptyTrash} />
          )}
          {tab === "consulente" && (
            <AdvisorTab messages={advisorMessages} setMessages={setAdvisorMessages} getContext={() => buildAdvisorContext(state, derived)} />
          )}
          {tab === "categorie" && (
            <>
            <CategorieTab
              categories={state.categories}
              onAdd={addCategory}
              onRename={renameCategory}
              onDelete={confirmDeleteCategory}
              onMove={moveCategory}
              onAddSub={addSubcategory}
              onRenameSub={renameSubcategory}
              onDeleteSub={confirmDeleteSubcategory}
              onMoveSub={moveSubcategory}
            />
            <RulesCard rules={state.rules || []} categories={state.categories} onAdd={addRule} onApply={applyRuleToExisting} onRemove={confirmRemoveRule} />
            </>
          )}
        </div>
      </div>

      {showTxModal && (
        <TxModal
          onClose={() => setShowTxModal(false)}
          onSave={saveTransaction}
          categories={state.categories}
          onAddCategory={addCategory}
          editingTx={editingTx}
          accounts={derived.accounts}
        />
      )}
      {showInvModal && (
        <InvModal
          onClose={() => setShowInvModal(false)}
          onSave={saveInvestment}
          editingInv={editingInv}
          accounts={derived.accounts}
        />
      )}
      {showAccountModal && (
        <AccountModal
          onClose={() => setShowAccountModal(false)}
          onSave={saveAccount}
          editingAccount={editingAccount}
          isFirst={state.accounts.length === 0}
        />
      )}
      {showBudgetModal && (
        <BudgetModal
          onClose={() => setShowBudgetModal(false)}
          onSave={saveBudget}
          categories={state.categories}
          budgets={state.budgets}
          editingBudget={editingBudget}
        />
      )}
      {showRecurringModal && (
        <RecurringModal
          onClose={() => setShowRecurringModal(false)}
          onSave={saveRecurring}
          categories={state.categories}
          editingRule={editingRecurring}
          accounts={derived.accounts}
        />
      )}
      {showSettings && (
        <SettingsModal
          theme={state.settings?.theme || "dark"}
          accent={state.settings?.accent || "oro"}
          onChange={setPref}
          onClose={() => setShowSettings(false)}
          userEmail={userEmail}
          onExportCsv={() => downloadFile(`finanze-movimenti-${todayISO()}.csv`, "text/csv;charset=utf-8", transactionsToCsv(state))}
          onExportBackup={() => downloadFile(`finanze-backup-${todayISO()}.json`, "application/json", buildBackup(state))}
          onRestoreFile={restoreFromFile}
        />
      )}
      {showTransferModal && (
        <GirocontoModal accounts={derived.accounts} onClose={() => setShowTransferModal(false)} onSave={saveTransfer} />
      )}
      {showImportModal && (
        <ImportStatementModal
          onClose={() => setShowImportModal(false)}
          onImport={importStatement}
          transactions={state.transactions}
          investments={state.investments}
          accounts={derived.accounts}
          categories={state.categories}
          rules={state.rules || []}
        />
      )}
      {confirmDlg && <ConfirmModal dlg={confirmDlg} onClose={() => setConfirmDlg(null)} />}
      {closingInv && (
        <CloseInvestmentModal
          inv={closingInv}
          accounts={derived.accounts}
          onClose={() => setClosingInv(null)}
          onConfirm={(payload) => confirmCloseInvestment(closingInv, payload)}
        />
      )}
    </div>
  );
}

// ---------- Cestino ----------
const TRASH_KIND = {
  transactions: "Movimenti",
  investment: "Posizione di investimento",
  budget: "Budget",
  recurring: "Ricorrenza",
  account: "Conto",
  category: "Categoria",
  subcategory: "Sottocategoria",
};

function TrashTab({ items, onRestore, onDelete, onEmpty }) {
  const daysLeft = (e) => Math.max(0, Math.ceil((e.deletedAt + TRASH_MS - Date.now()) / 86400000));
  const when = (e) => new Date(e.deletedAt).toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" });
  return (
    <div style={styles.grid}>
      <Card
        title="Cestino"
        extra={items.length > 0 ? <button style={styles.linkBtn} onClick={onEmpty}>Svuota cestino</button> : null}
      >
        <p style={{ ...styles.helpText, marginTop: 0 }}>
          Movimenti, posizioni di investimento, budget, ricorrenze, conti e categorie eliminati restano qui per {TRASH_DAYS} giorni: puoi ripristinarli o eliminarli per sempre. Dopo {TRASH_DAYS} giorni vengono cancellati in automatico.
        </p>
        {items.length === 0 ? (
          <EmptyState text="Il cestino è vuoto." />
        ) : (
          <div style={styles.catList}>
            {items.map((e) => (
              <div key={e.id} style={styles.catRow}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={styles.tag}>{TRASH_KIND[e.kind] || e.kind}</span>
                      <span style={styles.catName}>{e.label}</span>
                    </div>
                    <div style={{ ...styles.invMeta, marginTop: 6, marginBottom: 0 }}>
                      Eliminato il {when(e)} · {daysLeft(e) === 0 ? "scade oggi" : `scade tra ${daysLeft(e)} giorn${daysLeft(e) === 1 ? "o" : "i"}`}
                    </div>
                    {e.kind === "transactions" && (
                      <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: 2 }}>
                        {e.payload.items.slice(0, 4).map((t) => (
                          <span key={t.id}>
                            {formatDate(t.date)} · {t.description || t.category} · <span style={{ color: t.type === "entrata" ? "var(--pos)" : "var(--neg)" }}>{t.type === "entrata" ? "+" : "−"}{fmtFull(t.amount)}</span>
                          </span>
                        ))}
                        {e.payload.items.length > 4 && <span>… e altri {e.payload.items.length - 4}</span>}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button style={styles.primaryBtn} onClick={() => onRestore(e.id)}>Ripristina</button>
                    <button style={styles.iconBtn} onClick={() => onDelete(e.id)} title="Elimina definitivamente"><Trash2 size={15} /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------- Consulente AI (Gemini) ----------
const r2 = (n) => Math.round(Number(n) * 100) / 100;

// Riepilogo compatto delle finanze dell'utente, inviato al consulente a ogni domanda
function buildAdvisorContext(state, derived) {
  const today = todayISO();
  const curMk = today.slice(0, 7);
  const flows = state.transactions.filter((t) => isEffettivo(t) && isFlow(t));
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(addMonthsClamped(curMk + "-01", -i).slice(0, 7));

  const perMonth = months.map((mk) => {
    const inn = flows.filter((t) => t.type === "entrata" && monthKey(t.date) === mk).reduce((s, t) => s + Number(t.amount), 0);
    const out = flows.filter((t) => t.type === "uscita" && monthKey(t.date) === mk).reduce((s, t) => s + Number(t.amount), 0);
    return { mese: mk + (mk === curMk ? " (in corso, parziale)" : ""), entrate: r2(inn), uscite: r2(out), risparmio: r2(inn - out), tassoRisparmioPct: inn > 0 ? Math.round(((inn - out) / inn) * 100) : null };
  });
  const full = perMonth.filter((m) => !m.mese.includes("in corso"));
  const avg = (arr, k) => (arr.length ? r2(arr.reduce((s, m) => s + m[k], 0) / arr.length) : null);
  const last3 = full.slice(-3);

  // spese per categoria: ultimi 3 mesi completi
  const mk3 = new Set(months.filter((m) => m !== curMk).slice(-3));
  const catTot = {};
  flows.filter((t) => t.type === "uscita" && mk3.has(monthKey(t.date))).forEach((t) => { catTot[t.category] = (catTot[t.category] || 0) + Number(t.amount); });
  const catSum = Object.values(catTot).reduce((a, b) => a + b, 0);
  const categorie = Object.entries(catTot).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([categoria, tot]) => ({ categoria, totale3Mesi: r2(tot), mediaMensile: r2(tot / Math.max(1, mk3.size)), percentuale: catSum ? Math.round((tot / catSum) * 100) : 0 }));

  // principali esercenti/voci di spesa negli ultimi 90 giorni
  const from90 = addDaysISO(today, -90);
  const merch = {};
  flows.filter((t) => t.type === "uscita" && t.date >= from90).forEach((t) => {
    const raw = (t.description || t.category || "").split(" · ").pop() || t.category;
    const key = raw.toUpperCase().replace(/[0-9#*]+/g, "").replace(/\s+/g, " ").trim().split(" ").slice(0, 3).join(" ") || t.category;
    (merch[key] ||= { nome: key, totale: 0, n: 0, categoria: t.category });
    merch[key].totale += Number(t.amount); merch[key].n += 1;
  });
  const esercenti = Object.values(merch).sort((a, b) => b.totale - a.totale).slice(0, 15).map((m) => ({ ...m, totale: r2(m.totale) }));

  const recurring = state.recurring.map((r) => ({
    descrizione: r.description || r.category, categoria: r.category, tipo: r.type, frequenza: r.frequency,
    importo: r2(r.amount), importoMensileStimato: r2(Number(r.amount) * (RECUR_MONTHLY_FACTOR[r.frequency] || 0)),
  }));

  const budget = state.budgets.map((b) => {
    const st = computeBudgetStatus(b, state.transactions, curMk);
    return { categoria: budgetName(b), limiteMensile: r2(st.limit), speso: r2(st.spent), previstoAncora: r2(st.planned), percentualeUsata: Math.round(st.pct) };
  });

  const investimenti = state.investments.map((i) => {
    const inv = computeInvestedTotal(i);
    return { nome: i.name, tipo: i.invType, capitaleVersato: r2(inv), valoreAttuale: r2(i.currentValue), plusMinusPct: inv > 0 ? Math.round(((Number(i.currentValue) - inv) / inv) * 100) : null };
  });

  const spesa6 = avg(full, "uscite");
  const liquidaDisp = derived.liquidita - derived.beniValore;
  return {
    oggi: today,
    valuta: "EUR",
    patrimonio: {
      liquidita: r2(derived.liquidita), valoreInvestimenti: r2(derived.totInvestimenti), patrimonioNetto: r2(derived.patrimonioNetto),
      capitaleInvestito: r2(derived.totInvestito), plusMinusInvestimenti: r2(derived.plusMinus), beniDiValore: r2(derived.beniValore),
    },
    conti: derived.accounts.map((a) => ({ nome: a.name, tipo: a.type, saldoCorrente: r2(a.balance), predefinito: !!a.isDefault })),
    ultimiMesi: perMonth,
    mediaMensile: { entrate3Mesi: avg(last3, "entrate"), uscite3Mesi: avg(last3, "uscite"), uscite6Mesi: spesa6 },
    fondoEmergenzaMesi: spesa6 > 0 ? r2(liquidaDisp / spesa6) : null,
    speseCategoriaUltimi3MesiCompleti: categorie,
    principaliEsercenti90Giorni: esercenti,
    movimentiRicorrenti: recurring,
    budgetMeseCorrente: budget,
    investimenti,
    note: "Le categorie Trasferimento tra conti, Investimenti e Disinvestimento sono escluse da entrate/uscite.",
  };
}

// Mini renderer markdown (titoli, elenchi, grassetto) per le risposte del consulente
function renderInline(text, keyBase) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4
      ? <strong key={`${keyBase}-${i}`} style={{ color: "var(--text-strong)" }}>{part.slice(2, -2)}</strong>
      : <span key={`${keyBase}-${i}`}>{part.replace(/\*(?!\*)/g, "")}</span>
  );
}
function MarkdownText({ text }) {
  const blocks = [];
  let list = null;
  text.split("\n").forEach((line, idx) => {
    const t = line.trimEnd();
    let m;
    if ((m = /^\s*(?:[-*•])\s+(.*)$/.exec(t))) {
      if (!list || list.ordered) { list = { ordered: false, items: [] }; blocks.push(list); }
      list.items.push(m[1]);
    } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(t))) {
      if (!list || !list.ordered) { list = { ordered: true, items: [] }; blocks.push(list); }
      list.items.push(m[1]);
    } else {
      list = null;
      if (!t.trim()) return;
      if ((m = /^#{1,4}\s+(.*)$/.exec(t))) blocks.push({ heading: m[1] });
      else blocks.push({ p: t });
    }
  });
  return (
    <>
      {blocks.map((b, i) => {
        if (b.heading) return <div key={i} style={{ fontFamily: "'Fraunces', serif", fontSize: 15, fontWeight: 600, color: "var(--text)", margin: "10px 0 4px" }}>{renderInline(b.heading, i)}</div>;
        if (b.items) {
          const Tag = b.ordered ? "ol" : "ul";
          return <Tag key={i} style={{ margin: "4px 0 8px", paddingLeft: 20 }}>{b.items.map((it, j) => <li key={j} style={{ margin: "3px 0" }}>{renderInline(it, `${i}-${j}`)}</li>)}</Tag>;
        }
        return <p key={i} style={{ margin: "0 0 8px" }}>{renderInline(b.p, i)}</p>;
      })}
    </>
  );
}

const ADVISOR_SUGGESTIONS = [
  "Dove posso risparmiare di più?",
  "Analizza le mie spese ricorrenti",
  "Come sto andando con i budget?",
  "Il mio fondo di emergenza è sufficiente?",
  "Fammi un riepilogo degli ultimi 3 mesi",
];

function AdvisorTab({ messages, setMessages, getContext }) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages, loading]);

  const send = async (raw) => {
    const text = (raw ?? input).trim();
    if (!text || loading) return;
    setError("");
    setInput("");
    const history = [...messages, { role: "user", content: text }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setLoading(true);
    try {
      const res = await fetch("/api/advisor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })), context: getContext() }),
      });
      if (res.status === 401) { window.location.href = "/login"; return; }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Errore del servizio AI");
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        setMessages([...history, { role: "assistant", content: acc }]);
      }
      if (!acc.trim()) throw new Error("Risposta vuota: riprova.");
    } catch (e) {
      setMessages(messages); // toglie la domanda rimasta senza risposta
      setInput(text);
      setError(e.message || "Errore imprevisto");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.grid}>
      <Card
        title="Consulente finanziario AI"
        extra={
          messages.length > 0 && !loading ? (
            <button style={styles.linkBtn} onClick={() => { setMessages([]); setError(""); }}>Nuova conversazione</button>
          ) : (
            <span style={styles.tag}>Gemini</span>
          )
        }
      >
        <p style={{ ...styles.helpText, marginTop: 0 }}>
          Chiedimi di analizzare spese, budget, ricorrenze e patrimonio: rispondo usando i dati del tuo registro.
          Per rispondere, un riepilogo delle tue cifre (saldi, categorie, principali esercenti) viene inviato a Google Gemini.
          Sono spunti di riflessione, non consulenza finanziaria professionale.
        </p>

        <div style={styles.chatBox}>
          {messages.length === 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
              <div style={{ ...styles.helpText, marginBottom: 4 }}>Prova a chiedere:</div>
              {ADVISOR_SUGGESTIONS.map((q) => (
                <button key={q} style={styles.suggestBtn} onClick={() => send(q)}>{q}</button>
              ))}
            </div>
          ) : (
            messages.map((m, i) => (
              <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                <div style={m.role === "user" ? styles.bubbleUser : styles.bubbleAi}>
                  {m.role === "user" ? m.content : m.content ? <MarkdownText text={m.content} /> : <span style={{ color: "var(--text-muted)" }}>sto analizzando i tuoi dati…</span>}
                </div>
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>

        {error && <div style={{ ...styles.fieldError, marginTop: 10 }}>{error}</div>}

        <div style={styles.chatInputRow}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Scrivi una domanda sulle tue finanze…"
            rows={2}
            maxLength={2000}
            style={{ ...styles.input, resize: "none", flex: 1, fontFamily: "'Inter', sans-serif" }}
          />
          <button style={{ ...styles.primaryBtn, height: 44, opacity: loading || !input.trim() ? 0.5 : 1 }} disabled={loading || !input.trim()} onClick={() => send()}>
            <Send size={15} /> Invia
          </button>
        </div>
      </Card>
    </div>
  );
}

// ---------- Header / Nav ----------
function Header({ saveFlash, patrimonio, liquidita, investimenti, userEmail, onSettings }) {
  return (
    <div style={styles.header} className="app-header">
      <div>
        <div style={styles.eyebrow}>REGISTRO PERSONALE</div>
        <h1 style={styles.title}>Le mie finanze</h1>
      </div>
      <div style={styles.headerRight}>
        <div style={styles.saveDot(saveFlash)} title="salvato" />
        <button style={styles.settingsBtn} onClick={onSettings} title="Impostazioni" aria-label="Impostazioni">
          <Settings size={17} />
        </button>
        <div style={styles.userBox}>
          <span style={styles.userEmail} title={userEmail}>{userEmail}</span>
          <button style={styles.logoutBtn} onClick={logout}>Esci</button>
        </div>
        <div style={styles.headerPatrimonio}>
          <div style={styles.headerPatrimonioLabel}>Liquidità</div>
          <div style={styles.headerPatrimonioValue}>{fmt(liquidita)}</div>
          <div style={styles.headerSplit}>Patrimonio netto {fmt(patrimonio)} · Investimenti {fmt(investimenti)}</div>
        </div>
      </div>
    </div>
  );
}

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "movimenti", label: "Entrate / Uscite", icon: Receipt },
  { id: "budget", label: "Budget", icon: Target },
  { id: "investimenti", label: "Investimenti", icon: LineChartIcon },
  { id: "patrimonio", label: "Patrimonio", icon: Landmark },
  { id: "categorie", label: "Categorie", icon: Tag },
  { id: "consulente", label: "Consulente AI", icon: Sparkles },
  { id: "cestino", label: "Cestino", icon: Trash2 },
];
const navLabel = (it, trashCount) => (it.id === "cestino" && trashCount > 0 ? `Cestino (${trashCount})` : it.label);

async function logout() {
  await fetch("/api/auth/logout", { method: "POST" });
  window.location.href = "/login";
}

// Navigazione desktop (barra di schede)
function Nav({ tab, setTab, trashCount }) {
  return (
    <div style={styles.nav} className="nav-desktop">
      <div style={styles.navItems}>
        {NAV_ITEMS.map((it) => {
          const IconC = it.icon;
          const active = tab === it.id;
          return (
            <button key={it.id} onClick={() => setTab(it.id)} style={styles.navBtn(active)}>
              <IconC size={15} strokeWidth={2} />
              {navLabel(it, trashCount)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Navigazione mobile: navbar fissa in alto + drawer laterale (stile app)
function MobileNav({ tab, setTab, patrimonio, liquidita, investimenti, userEmail, saveFlash, trashCount, onSettings }) {
  const [open, setOpen] = useState(false);
  const current = NAV_ITEMS.find((it) => it.id === tab) || NAV_ITEMS[0];

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div className="mobile-nav">
      <div style={styles.topBar}>
        <button style={styles.topBarBtn} onClick={() => setOpen(true)} aria-label="Apri menu" aria-expanded={open}>
          <Menu size={22} />
        </button>
        <div style={styles.topBarTitle}>
          <span>{current.label}</span>
          <span style={styles.saveDot(saveFlash)} />
        </div>
        <div style={styles.topBarValue} title={`Liquidità · patrimonio netto ${fmt(patrimonio)}`}>{fmt(liquidita)}</div>
      </div>

      <div style={{ ...styles.drawerOverlay, opacity: open ? 1 : 0, pointerEvents: open ? "auto" : "none" }} onClick={() => setOpen(false)} />
      <aside style={{ ...styles.drawer, transform: open ? "translateX(0)" : "translateX(-105%)" }} aria-hidden={!open}>
        <div style={styles.drawerHead}>
          <div>
            <div style={styles.eyebrow}>REGISTRO PERSONALE</div>
            <div style={{ ...styles.h3, fontSize: 22 }}>Le mie finanze</div>
          </div>
          <button style={styles.topBarBtn} onClick={() => setOpen(false)} aria-label="Chiudi menu"><X size={20} /></button>
        </div>
        <div style={styles.drawerBalance}>
          <div style={styles.headerPatrimonioLabel}>Liquidità</div>
          <div style={styles.headerPatrimonioValue}>{fmt(liquidita)}</div>
          <div style={styles.headerSplit}>Patrimonio netto {fmt(patrimonio)} · Investimenti {fmt(investimenti)}</div>
        </div>
        <div style={styles.drawerItems}>
          {NAV_ITEMS.map((it) => {
            const IconC = it.icon;
            const active = tab === it.id;
            return (
              <button key={it.id} onClick={() => { setTab(it.id); setOpen(false); }} style={styles.drawerItem(active)}>
                <IconC size={18} strokeWidth={2} />
                {navLabel(it, trashCount)}
              </button>
            );
          })}
        </div>
        <div style={styles.drawerFoot}>
          <span style={{ ...styles.userEmail, maxWidth: 130, flex: 1 }} title={userEmail}>{userEmail}</span>
          <button style={styles.settingsBtn} onClick={() => { setOpen(false); onSettings(); }} title="Impostazioni" aria-label="Impostazioni"><Settings size={17} /></button>
          <button style={styles.logoutBtn} onClick={logout}>Esci</button>
        </div>
      </aside>
    </div>
  );
}

// ---------- Dashboard ----------
function Dashboard({ derived: derivedAll, state: stateAll }) {
  const [account, setAccount] = useState("all");
  const accountId = stateAll.accounts.some((a) => a.id === account) ? account : "all";
  // tutte le cifre e i grafici si riferiscono al conto scelto (o a tutti); i budget restano globali
  const state = useMemo(() => (accountId === "all" ? stateAll : viewForAccount(stateAll, accountId)), [stateAll, accountId]);
  const derived = useMemo(() => (accountId === "all" ? derivedAll : computeDerived(state)), [derivedAll, state, accountId]);
  const scopeName = accountId === "all" ? null : stateAll.accounts.find((a) => a.id === accountId)?.name;
  const [period, setPeriod] = useState("6m");
  const [range, setRange] = useState(() => ({ from: addMonthsClamped(todayISO(), -3), to: todayISO() }));
  const recentTx = state.transactions.slice(0, 5);

  const { trendSlice, pieData, periodLabel, entratePeriodo, uscitePeriodo, saldoPeriodo, mesiPeriodo } = useMemo(() => {
    const opt = PERIODS.find((p) => p.id === period) || PERIODS[2];
    const custom = period === "custom";
    const r = normRange(range);
    const slice = custom ? [] : sliceTrendByPeriod(derived.trendFull, period);
    const monthSet = new Set(slice.map((p) => p.monthKey));
    const inPeriod = custom ? (t) => t.date >= r.from && t.date <= r.to : (t) => monthSet.has(monthKey(t.date));
    const shortDate = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}` : "…");
    const entrate = state.transactions
      .filter((t) => t.type === "entrata" && isEffettivo(t) && isFlow(t) && inPeriod(t))
      .reduce((s, t) => s + Number(t.amount), 0);
    const uscite = state.transactions
      .filter((t) => t.type === "uscita" && isEffettivo(t) && isFlow(t) && inPeriod(t))
      .reduce((s, t) => s + Number(t.amount), 0);
    return {
      trendSlice: slice,
      pieData: computeSpeseCategoria(state.transactions, inPeriod),
      periodLabel: custom ? `${shortDate(r.from)}–${shortDate(r.to)}` : opt.label,
      entratePeriodo: entrate,
      uscitePeriodo: uscite,
      saldoPeriodo: entrate - uscite,
      // intervallo personalizzato: mesi = giorni / 30,4 (mai meno di 1, come per "Mese")
      mesiPeriodo: custom
        ? Math.max(1, Math.round(((daysBetween(r.from || todayISO(), r.to || todayISO()) + 1) / 30.4375) * 10) / 10)
        : Math.max(1, slice.filter((p) => !p.isFuture).length),
    };
  }, [period, range, derived.trendFull, state.transactions]);
  const chartData = useMemo(() => sliceDaily(derived.dailyFull, period, derived.hasPrevisto, range), [derived.dailyFull, derived.hasPrevisto, period, range]);

  const tassoRisparmio = entratePeriodo > 0 ? (saldoPeriodo / entratePeriodo) * 100 : null;
  const spesaMediaMensile = uscitePeriodo / mesiPeriodo;
  const liquidaDisponibile = derived.liquidita - derived.beniValore;
  const mesiAutonomia = spesaMediaMensile > 0 ? liquidaDisponibile / spesaMediaMensile : null;
  const fmtMesi = (n) => n.toLocaleString("it-IT", { maximumFractionDigits: 1 });
  const curMk = todayISO().slice(0, 7);
  const budgetAlerts = (state.budgets || [])
    .map((b) => ({ b, st: computeBudgetStatus(b, stateAll.transactions, curMk) }))
    .filter((x) => x.st.level !== "ok")
    .sort((a, b) => b.st.pct - a.st.pct);

  return (
    <div style={styles.grid}>
      <div style={styles.sectionHeader}>
        <h3 style={styles.h3}>Panoramica{scopeName ? <span style={{ fontSize: 13, color: "var(--text-muted)", fontFamily: "'Inter', sans-serif", fontWeight: 500 }}> · {scopeName}</span> : null}</h3>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, maxWidth: "100%" }}>
          <AccountFilter accounts={stateAll.accounts} value={accountId} onChange={setAccount} />
          <PeriodSelector value={period} onChange={setPeriod} range={range} onRange={setRange} />
        </div>
      </div>

      <div className="stats-row" style={styles.statsRow}>
        <StatCard label={`Entrate effettive · ${periodLabel}`} value={fmt(entratePeriodo)} icon={ArrowUpRight} tone="pos" />
        <StatCard label={`Uscite effettive · ${periodLabel}`} value={fmt(uscitePeriodo)} icon={ArrowDownRight} tone="neg" />
        <StatCard
          label={`Saldo effettivo · ${periodLabel}`}
          value={fmt(saldoPeriodo)}
          icon={saldoPeriodo >= 0 ? TrendingUp : TrendingDown}
          tone={saldoPeriodo >= 0 ? "pos" : "neg"}
        />
        <StatCard label={scopeName ? "Saldo del conto" : "Liquidità totale"} value={fmt(derived.liquidita)} icon={Wallet} tone="neutral" />
      </div>

      <h3 style={styles.h3}>Indicatori</h3>
      <div className="stats-row" style={styles.statsRow}>
        <StatCard
          label={`Tasso di risparmio · ${periodLabel}`}
          value={tassoRisparmio === null ? "—" : `${tassoRisparmio.toFixed(1)}%`}
          sub="obiettivo comune: almeno 20%"
          icon={PiggyBank}
          tone={tassoRisparmio === null ? "neutral" : tassoRisparmio >= 20 ? "pos" : tassoRisparmio >= 0 ? "neutral" : "neg"}
        />
        <StatCard
          label={`Spesa media mensile · ${periodLabel}`}
          value={fmt(spesaMediaMensile)}
          sub={period === "custom" ? `su ${fmtMesi(mesiPeriodo)} ${mesiPeriodo === 1 ? "mese" : "mesi"} (intervallo scelto)` : `su ${mesiPeriodo} ${mesiPeriodo === 1 ? "mese" : "mesi"} (mese in corso incluso)`}
          icon={ArrowDownRight}
          tone="neutral"
        />
        <StatCard
          label="Mesi di autonomia"
          value={mesiAutonomia === null ? "—" : `${fmtMesi(Math.max(0, mesiAutonomia))} mesi`}
          sub={derived.beniValore > 0 ? "liquidità esclusi i beni di valore" : "liquidità ÷ spesa media mensile"}
          icon={Wallet}
          tone={mesiAutonomia === null ? "neutral" : mesiAutonomia >= 6 ? "pos" : mesiAutonomia >= 3 ? "neutral" : "neg"}
        />
      </div>

      {budgetAlerts.length > 0 && (
        <>
          <h3 style={styles.h3}>Avvisi budget · mese in corso</h3>
          <Card>
            {budgetAlerts.map(({ b, st }) => (
              <div key={b.id} style={styles.alertRow}>
                <span style={styles.levelDot(st.level)} />
                <span style={{ flex: 1 }}>{budgetName(b)} <span style={{ color: BUDGET_COLORS[st.level], fontSize: 12 }}>· {st.label}</span></span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                  {fmt(st.spent)} / {fmt(st.limit)} · {Math.round(st.pct)}%
                </span>
              </div>
            ))}
          </Card>
        </>
      )}

      {derived.hasPrevisto && (
        <>
          <h3 style={styles.h3}>Totale previsto (tutti i movimenti futuri)</h3>
          <div className="stats-row" style={styles.statsRow}>
            <StatCard label="Entrate previste totali" value={fmt(derived.entratePrevistoTot)} icon={ArrowUpRight} tone="posMuted" />
            <StatCard label="Uscite previste totali" value={fmt(derived.uscitePrevistoTot)} icon={ArrowDownRight} tone="negMuted" />
            <StatCard
              label="Saldo previsto totale"
              value={fmt(derived.saldoPrevistoTot)}
              icon={derived.saldoPrevistoTot >= 0 ? TrendingUp : TrendingDown}
              tone={derived.saldoPrevistoTot >= 0 ? "posMuted" : "negMuted"}
            />
          </div>
        </>
      )}

      <h3 style={styles.h3}>Andamento</h3>

      <div className="two-col" style={styles.twoCol}>
        <Card title="Andamento patrimonio">
          {chartData.length === 0 ? (
            <EmptyState text="Nessun dato nell'intervallo scelto: i movimenti partono dal primo registrato." />
          ) : (
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="gradPatr" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" stroke="var(--text-muted)" fontSize={11} tickLine={false} axisLine={{ stroke: "var(--border)" }} tickFormatter={dayTick(period, range)} minTickGap={36} />
              <YAxis stroke="var(--text-muted)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => fmt(v)} width={70} domain={["auto", "auto"]} />
              <Tooltip content={<CustomTooltip />} />
              {derived.hasPrevisto && <Legend formatter={(v) => <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{v}</span>} />}
              <Area type="linear" dataKey="patrimonio" name="Patrimonio" stroke="var(--accent)" strokeWidth={2} fill="url(#gradPatr)" dot={false} isAnimationActive={false} />
              {derived.hasPrevisto && (
                <Line type="linear" dataKey="patrimonioPrevisto" name="Proiezione (con previsti)" stroke="var(--chart-3)" strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
              )}
            </ComposedChart>
          </ResponsiveContainer>
          )}
        </Card>

        <Card title={`Spese per categoria · ${periodLabel}`}>
          {pieData.length === 0 ? (
            <EmptyState text="Nessuna uscita registrata in questo periodo." />
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={85} paddingAngle={2}>
                  {pieData.map((_, i) => (
                    <Cell key={i} fill={PALETTE[i % PALETTE.length]} stroke="var(--bg)" strokeWidth={2} />
                  ))}
                </Pie>
                <Tooltip content={<CustomTooltip total={pieData.reduce((t, d) => t + d.value, 0)} />} />
                <Legend
                  layout="vertical"
                  verticalAlign="middle"
                  align="right"
                  iconType="circle"
                  iconSize={8}
                  formatter={(v) => <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{v}</span>}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      <Card title="Movimenti recenti">
        {recentTx.length === 0 ? (
          <EmptyState text="Ancora nessun movimento. Aggiungine uno dalla scheda Entrate / Uscite." />
        ) : (
          <TxTable transactions={recentTx} compact />
        )}
      </Card>
    </div>
  );
}

// ---------- Movimenti ----------
const EMPTY_TX_FILTERS = { dateFrom: "", dateTo: "", category: "", amountMin: "", amountMax: "", search: "", account: "" };

function Movimenti({ transactions, accounts, onAdd, onEdit, onRemove, onRemoveMany, onImport, onGiroconto, categories, onBulkCategory, statusFilter, onStatusFilter, pageSize, onPageSize, recurring, onAddRecurring, onEditRecurring, onRemoveRecurring, onRegenerateRecurring }) {
  const [typeFilter, setTypeFilter] = useState("tutti");
  const [filters, setFilters] = useState(EMPTY_TX_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [sort, setSort] = useState({ key: "date", dir: "desc" });

  const categoriesPresent = useMemo(() => {
    const set = new Set(transactions.map((t) => t.category));
    return Array.from(set).sort((a, b) => a.localeCompare(b, "it"));
  }, [transactions]);

  const filtered = useMemo(() => {
    let list = transactions.filter((t) => typeFilter === "tutti" || t.type === typeFilter);
    if (filters.dateFrom) list = list.filter((t) => t.date >= filters.dateFrom);
    if (filters.dateTo) list = list.filter((t) => t.date <= filters.dateTo);
    if (filters.category) list = list.filter((t) => t.category === filters.category);
    if (filters.amountMin) list = list.filter((t) => Number(t.amount) >= Number(filters.amountMin));
    if (filters.amountMax) list = list.filter((t) => Number(t.amount) <= Number(filters.amountMax));
    if (filters.search) list = list.filter((t) => (t.description || "").toLowerCase().includes(filters.search.toLowerCase()));
    if (statusFilter) list = list.filter((t) => (statusFilter === "previsto" ? !isEffettivo(t) : isEffettivo(t)));
    if (filters.account) list = list.filter((t) => t.accountId === filters.account);
    return list;
  }, [transactions, typeFilter, filters, statusFilter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      let av, bv;
      if (sort.key === "date") { av = a.date; bv = b.date; }
      else if (sort.key === "description") { av = (a.description || "").toLowerCase(); bv = (b.description || "").toLowerCase(); }
      else if (sort.key === "category") { av = a.category.toLowerCase(); bv = b.category.toLowerCase(); }
      else { av = Number(a.amount); bv = Number(b.amount); }
      if (av < bv) return sort.dir === "asc" ? -1 : 1;
      if (av > bv) return sort.dir === "asc" ? 1 : -1;
      return 0;
    });
    return copy;
  }, [filtered, sort]);

  // ---- paginazione ----
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const curPage = Math.min(page, totalPages);
  const pageRows = useMemo(() => sorted.slice((curPage - 1) * pageSize, curPage * pageSize), [sorted, curPage, pageSize]);
  useEffect(() => { setPage(1); }, [typeFilter, filters, statusFilter, sort, pageSize]);

  const [selected, setSelected] = useState(() => new Set());
  const selectedVisibleIds = useMemo(() => sorted.filter((t) => selected.has(t.id)).map((t) => t.id), [sorted, selected]);
  const toggleSelected = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  // la casella nell'intestazione seleziona/deseleziona le righe della pagina corrente
  const toggleAllVisible = () => setSelected((prev) => {
    const allSelected = pageRows.length > 0 && pageRows.every((t) => prev.has(t.id));
    const next = new Set(prev);
    pageRows.forEach((t) => { if (allSelected) next.delete(t.id); else next.add(t.id); });
    return next;
  });
  const selectAllFiltered = () => setSelected((prev) => { const next = new Set(prev); sorted.forEach((t) => next.add(t.id)); return next; });
  const pageFullySelected = pageRows.length > 0 && pageRows.every((t) => selected.has(t.id));
  // rimuove dalla selezione i movimenti non più esistenti
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const existing = new Set(transactions.map((t) => t.id));
      const next = new Set([...prev].filter((id) => existing.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [transactions]);

  const toggleSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "description" || key === "category" ? "asc" : "desc" }));

  const activeFilterCount = Object.values(filters).filter(Boolean).length + (statusFilter ? 1 : 0);
  const resetFilters = () => { setFilters(EMPTY_TX_FILTERS); if (statusFilter) onStatusFilter(""); };
  const [showRecurringList, setShowRecurringList] = useState(false);
  const [fabOpen, setFabOpen] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const monthlyOf = (type) => recurring.filter((r) => r.type === type).reduce((sum, r) => sum + Number(r.amount) * (RECUR_MONTHLY_FACTOR[r.frequency] || 0), 0);
  const recurIn = monthlyOf("entrata");
  const recurOut = monthlyOf("uscita");

  return (
    <div style={styles.grid}>
      <button style={styles.recurBtn} onClick={() => setShowRecurringList(true)}>
        <span style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 600, color: "var(--text)" }}>
          <span style={{ fontSize: 16, color: "var(--accent)" }}>↻</span>
          Movimenti ricorrenti
          <span style={styles.tag}>{recurring.length}</span>
        </span>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>
          <span style={{ color: "var(--pos)" }}>+{fmt(recurIn)}</span> <span style={{ color: "var(--text-dim)" }}>/</span> <span style={{ color: "var(--neg)" }}>−{fmt(recurOut)}</span>
          <span style={{ color: "var(--text-muted)", fontFamily: "'Inter', sans-serif", fontSize: 12 }}> al mese</span>
        </span>
      </button>
      {showRecurringList && (
        <RecurringListModal
          recurring={recurring}
          accounts={accounts}
          recurIn={recurIn}
          recurOut={recurOut}
          onClose={() => setShowRecurringList(false)}
          onAdd={onAddRecurring}
          onEdit={onEditRecurring}
          onRemove={onRemoveRecurring}
          onRegenerate={onRegenerateRecurring}
          transactions={transactions}
        />
      )}

      <div style={styles.sectionHeader}>
        <div style={styles.filterRow}>
          {["tutti", "entrata", "uscita"].map((f) => (
            <button key={f} onClick={() => setTypeFilter(f)} style={styles.filterBtn(typeFilter === f)}>
              {f === "tutti" ? "Tutti" : f === "entrata" ? "Entrate" : "Uscite"}
            </button>
          ))}
          <button
            style={{ ...styles.filterBtn(showFilters || activeFilterCount > 0), display: "inline-flex", alignItems: "center", gap: 6 }}
            onClick={() => setShowFilters((s) => !s)}
            title="Filtri"
            aria-label="Filtri"
            aria-expanded={showFilters}
          >
            <Filter size={14} />
            {activeFilterCount > 0 && <span style={styles.filterBadge}>{activeFilterCount}</span>}
          </button>
        </div>
        <div className={`tx-header-right${selectedVisibleIds.length === 0 ? " empty" : ""}`} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {selectedVisibleIds.length > 0 && (
            <button style={styles.editSelBtn} onClick={() => setShowBulk(true)} title="Cambia la categoria dei movimenti selezionati">
              <Pencil size={14} />
              <span>Modifica</span>
            </button>
          )}
          {selectedVisibleIds.length > 0 && (
            <button
              style={styles.trashBtn}
              onClick={() => onRemoveMany(selectedVisibleIds)}
              title={`Elimina ${selectedVisibleIds.length} selezionat${selectedVisibleIds.length === 1 ? "o" : "i"}`}
            >
              <Trash2 size={15} />
              <span>{selectedVisibleIds.length}</span>
            </button>
          )}
          <span className="tx-actions-desktop" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button style={styles.secondaryBtn} onClick={onImport}>
              <Upload size={15} /> Importa estratto conto
            </button>
            <button style={styles.secondaryBtn} onClick={onGiroconto}>
              <ArrowRightLeft size={15} /> Giroconto
            </button>
            <button style={styles.primaryBtn} onClick={onAdd}>
              <Plus size={15} /> Nuovo movimento
            </button>
          </span>
        </div>
      </div>

      {showBulk && (
        <BulkCategoryModal
          txs={transactions.filter((t) => selectedVisibleIds.includes(t.id))}
          categories={categories}
          onClose={() => setShowBulk(false)}
          onApply={(ids, map) => { onBulkCategory(ids, map); setSelected(new Set()); setShowBulk(false); }}
        />
      )}

      {/* Telefono: pulsante flottante "+" che apre le tre azioni */}
      <div className="tx-fab-wrap">
        {fabOpen && <div style={styles.fabBackdrop} onClick={() => setFabOpen(false)} />}
        {fabOpen && (
          <div style={styles.fabMenu}>
            <button style={styles.fabItem} onClick={() => { setFabOpen(false); onImport(); }}><Upload size={16} /> Importa estratto conto</button>
            <button style={styles.fabItem} onClick={() => { setFabOpen(false); onGiroconto(); }}><ArrowRightLeft size={16} /> Giroconto</button>
            <button style={{ ...styles.fabItem, ...styles.fabItemPrimary }} onClick={() => { setFabOpen(false); onAdd(); }}><Plus size={16} /> Nuovo movimento</button>
          </div>
        )}
        <button style={styles.fab(fabOpen)} onClick={() => setFabOpen((o) => !o)} aria-label="Azioni movimenti" aria-expanded={fabOpen}>
          <Plus size={26} />
        </button>
      </div>

      {showFilters && (
        <Card>
          <div className="filter-grid" style={styles.filterGrid}>
            <Field label="Descrizione contiene">
              <input type="text" placeholder="cerca…" value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} style={styles.input} />
            </Field>
            <Field label="Categoria">
              <select value={filters.category} onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))} style={styles.input}>
                <option value="">Tutte</option>
                {categoriesPresent.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Data da">
              <input type="date" value={filters.dateFrom} onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))} style={styles.input} />
            </Field>
            <Field label="Data a (o data esatta se uguale a 'da')">
              <input type="date" value={filters.dateTo} onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))} style={styles.input} />
            </Field>
            <Field label="Importo minimo (€)">
              <MoneyInput placeholder="0" value={filters.amountMin} onChange={(e) => setFilters((f) => ({ ...f, amountMin: e.target.value }))} style={styles.input} />
            </Field>
            <Field label="Importo massimo (€)">
              <MoneyInput placeholder="—" value={filters.amountMax} onChange={(e) => setFilters((f) => ({ ...f, amountMax: e.target.value }))} style={styles.input} />
            </Field>
            <Field label="Conto">
              <select value={filters.account} onChange={(e) => setFilters((f) => ({ ...f, account: e.target.value }))} style={styles.input}>
                <option value="">Tutti</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Stato">
              <select value={statusFilter} onChange={(e) => onStatusFilter(e.target.value)} style={styles.input}>
                <option value="">Tutti</option>
                <option value="effettivo">Effettivi</option>
                <option value="previsto">Previsti</option>
              </select>
            </Field>
          </div>
          {activeFilterCount > 0 && (
            <button style={styles.linkBtn} onClick={resetFilters}>Reimposta filtri</button>
          )}
        </Card>
      )}

      <div style={styles.legendRow}>
        {[
          { id: "effettivo", label: "Effettivo", eff: true },
          { id: "previsto", label: "Previsto (data futura)", eff: false },
        ].map((o) => (
          <button
            key={o.id}
            style={styles.legendBtn(statusFilter === o.id)}
            onClick={() => onStatusFilter(statusFilter === o.id ? "" : o.id)}
            title={statusFilter === o.id ? "Clicca per mostrare di nuovo tutti i movimenti" : `Mostra solo i movimenti ${o.id === "effettivo" ? "effettivi" : "previsti"}`}
          >
            <span style={styles.statusDot(o.eff)} />{o.label}
            <span style={{ marginLeft: 6, color: "var(--text-dim)" }}>{transactions.filter((t) => isEffettivo(t) === o.eff).length}</span>
          </button>
        ))}
        {statusFilter && <span style={{ alignSelf: "center", color: "var(--text-dim)" }}>filtro salvato sul tuo profilo</span>}
      </div>

      <Card>
        {sorted.length === 0 ? (
          <EmptyState text="Nessun movimento corrisponde ai filtri selezionati." />
        ) : (
          <>
            {pageFullySelected && sorted.length > pageRows.length && (
              <div style={styles.selectBanner}>
                {selectedVisibleIds.length === sorted.length ? (
                  <>Sono selezionati tutti i {sorted.length} movimenti. <button style={styles.linkBtnInline} onClick={() => setSelected(new Set())}>Deseleziona tutto</button></>
                ) : (
                  <>Hai selezionato i {pageRows.length} movimenti di questa pagina. <button style={styles.linkBtnInline} onClick={selectAllFiltered}>Seleziona tutti i {sorted.length} movimenti</button></>
                )}
              </div>
            )}
            <TxTable
              transactions={pageRows}
              onEdit={onEdit}
              onRemove={onRemove}
              sort={sort}
              onSortChange={toggleSort}
              selectedIds={selected}
              onToggleSelect={toggleSelected}
              onToggleAll={toggleAllVisible}
              accounts={accounts}
            />
            <Pager page={curPage} totalPages={totalPages} total={sorted.length} pageSize={pageSize} onPage={setPage} onPageSize={onPageSize} />
          </>
        )}
      </Card>
    </div>
  );
}

const PAGE_SIZES = [10, 30, 50, 100];

function Pager({ page, totalPages, total, pageSize, onPage, onPageSize }) {
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  // numeri di pagina compatti: prima, ultima, corrente ± 1, con "…"
  const nums = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || Math.abs(i - page) <= 1) nums.push(i);
    else if (nums[nums.length - 1] !== "…") nums.push("…");
  }
  return (
    <div style={styles.pagerBar}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)" }}>
        Righe per pagina
        <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} style={{ ...styles.input, width: "auto", padding: "5px 8px", fontSize: 12 }}>
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{from}–{to} di {total}</span>
      <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
        <button style={styles.pageBtn(false, page === 1)} disabled={page === 1} onClick={() => onPage(page - 1)} title="Pagina precedente">‹</button>
        {nums.map((n, i) =>
          n === "…" ? (
            <span key={`e${i}`} style={{ color: "var(--text-dim)", padding: "0 4px" }}>…</span>
          ) : (
            <button key={n} style={styles.pageBtn(n === page, false)} onClick={() => onPage(n)}>{n}</button>
          )
        )}
        <button style={styles.pageBtn(false, page === totalPages)} disabled={page === totalPages} onClick={() => onPage(page + 1)} title="Pagina successiva">›</button>
      </div>
    </div>
  );
}

function SortableTh({ children, sortKey, align, sort, onSortChange }) {
  if (!onSortChange || !sortKey) {
    return <th style={{ ...styles.th, ...(align === "right" ? { textAlign: "right" } : {}) }}>{children}</th>;
  }
  const active = sort?.key === sortKey;
  return (
    <th
      style={{ ...styles.th, ...(align === "right" ? { textAlign: "right" } : {}), cursor: "pointer", userSelect: "none" }}
      onClick={() => onSortChange(sortKey)}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, justifyContent: align === "right" ? "flex-end" : "flex-start", width: "100%" }}>
        {children}
        {active && (sort.dir === "asc" ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
      </span>
    </th>
  );
}

function TxTable({ transactions, onEdit, onRemove, compact, sort, onSortChange, selectedIds, onToggleSelect, onToggleAll, accounts }) {
  const showAccount = !compact && !!accounts;
  const accountName = (id) => (accounts || []).find((a) => a.id === id)?.name || "—";
  const selectable = !compact && !!selectedIds;
  const allSelected = selectable && transactions.length > 0 && transactions.every((t) => selectedIds.has(t.id));
  const someSelected = selectable && !allSelected && transactions.some((t) => selectedIds.has(t.id));
  return (
    <>
    <div className={compact ? undefined : "tx-table-desktop"} style={styles.tableWrap}>
      <table style={compact ? styles.table : { ...styles.table, tableLayout: "fixed", minWidth: 820 }}>
        {!compact && (
          <colgroup>
            {selectable && <col style={{ width: 40 }} />}
            <col style={{ width: 150 }} />
            <col />
            <col style={{ width: 200 }} />
            {showAccount && <col style={{ width: 160 }} />}
            <col style={{ width: 120 }} />
            <col style={{ width: 84 }} />
          </colgroup>
        )}
        <thead>
          <tr>
            {selectable && (
              <th style={{ ...styles.th, width: 28 }}>
                <Checkbox checked={allSelected} indeterminate={someSelected} onChange={onToggleAll} title="Seleziona tutti" />
              </th>
            )}
            <SortableTh sortKey="date" sort={sort} onSortChange={onSortChange}>Data</SortableTh>
            <SortableTh sortKey="description" sort={sort} onSortChange={onSortChange}>Descrizione</SortableTh>
            <SortableTh sortKey="category" sort={sort} onSortChange={onSortChange}>Categoria</SortableTh>
            {showAccount && <th style={styles.th}>Conto</th>}
            <SortableTh sortKey="amount" align="right" sort={sort} onSortChange={onSortChange}>Importo</SortableTh>
            {!compact && <th style={styles.th}></th>}
          </tr>
        </thead>
        <tbody>
          {transactions.map((t) => (
            <tr key={t.id} style={selectable && selectedIds.has(t.id) ? { background: "var(--surface-2)" } : styles.tr}>
              {selectable && (
                <td style={styles.td}>
                  <Checkbox checked={selectedIds.has(t.id)} onChange={() => onToggleSelect(t.id)} />
                </td>
              )}
              <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                <span style={styles.statusDot(isEffettivo(t))} title={isEffettivo(t) ? "Effettivo" : "Previsto"} />
                {formatDate(t.date)}
                {t.recurringId && <span style={styles.recurMark} title="Movimento ricorrente">↻</span>}
                {t.transferId && (
                  <span style={styles.recurMark} title={t.type === "entrata" ? `Giroconto · data di accredito${t.opDate && t.opDate !== t.date ? ` (operazione del ${formatDate(t.opDate)})` : ""}` : "Giroconto"}>⇄</span>
                )}
              </td>
              <td style={{ ...styles.td, ...(compact ? {} : { wordBreak: "break-word" }) }}>{t.description || "—"}</td>
              <td style={{ ...styles.td, ...(compact ? {} : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }) }} title={compact ? undefined : `${t.category}${t.subcategory ? ` › ${t.subcategory}` : ""}`}>
                <span style={styles.tag}>{t.category}{t.subcategory ? ` › ${t.subcategory}` : ""}</span>
              </td>
              {showAccount && <td style={{ ...styles.td, fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={accountName(t.accountId)}>{accountName(t.accountId)}</td>}
              <td style={{ ...styles.td, textAlign: "right", whiteSpace: "nowrap", color: t.type === "entrata" ? "var(--pos)" : "var(--neg)", fontFamily: "'JetBrains Mono', monospace" }}>
                {t.type === "entrata" ? "+" : "−"}{fmtFull(t.amount)}
              </td>
              {!compact && (
                <td style={{ ...styles.td, textAlign: "right" }}>
                  <button style={styles.iconBtn} onClick={() => onEdit(t)}>
                    <Pencil size={14} />
                  </button>
                  <button style={styles.iconBtn} onClick={() => onRemove(t.id)}>
                    <Trash2 size={14} />
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {!compact && (
      <TxMobileList
        transactions={transactions}
        accountName={accountName}
        showAccount={showAccount}
        selectable={selectable}
        selectedIds={selectedIds}
        onToggleSelect={onToggleSelect}
        onToggleAll={onToggleAll}
        allSelected={allSelected}
        someSelected={someSelected}
        onEdit={onEdit}
        onRemove={onRemove}
      />
    )}
    </>
  );
}

// Elenco a schede per telefono: niente scorrimento orizzontale (la tabella resta solo su schermi larghi)
function TxMobileList({ transactions, accountName, showAccount, selectable, selectedIds, onToggleSelect, onToggleAll, allSelected, someSelected, onEdit, onRemove }) {
  return (
    <div className="tx-list-mobile">
      {selectable && (
        <label style={styles.txListHead}>
          <Checkbox checked={allSelected} indeterminate={someSelected} onChange={onToggleAll} title="Seleziona la pagina" />
          <span>Seleziona la pagina</span>
        </label>
      )}
      {transactions.map((t) => {
        const isIn = t.type === "entrata";
        const sel = selectable && selectedIds.has(t.id);
        return (
          <div key={t.id} style={styles.txItem(sel)} onClick={() => onEdit(t)}>
            {selectable && (
              <span onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center" }}>
                <Checkbox checked={sel} onChange={() => onToggleSelect(t.id)} />
              </span>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={styles.txItemTitle}>
                {t.description || t.category}
                {t.recurringId && <span style={styles.recurMark} title="Movimento ricorrente">↻</span>}
                {t.transferId && <span style={styles.recurMark} title="Giroconto">⇄</span>}
              </div>
              <div style={styles.txItemMeta}>
                <span style={styles.statusDot(isEffettivo(t))} />
                {formatDate(t.date)}
                <span style={{ ...styles.tag, marginLeft: 6 }}>{t.category}{t.subcategory ? ` › ${t.subcategory}` : ""}</span>
              </div>
              {showAccount && <div style={styles.txItemAccount}>{accountName(t.accountId)}</div>}
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, fontWeight: 700, color: isIn ? "var(--pos)" : "var(--neg)", whiteSpace: "nowrap" }}>
                {isIn ? "+" : "−"}{fmtFull(t.amount)}
              </div>
              <button style={{ ...styles.iconBtn, marginTop: 4 }} onClick={(e) => { e.stopPropagation(); onRemove(t.id); }} aria-label="Elimina movimento">
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- Investimenti ----------
function Investimenti({ investments, derived, onAdd, onEdit, onRemove, onUpdateValue, onClosePosition, accounts }) {
  const [view, setView] = useState("posizioni");
  return (
    <div style={styles.grid}>
      <div style={styles.toggleRow}>
        <button style={styles.toggleBtn(view === "posizioni", "var(--accent)")} onClick={() => setView("posizioni")}>Posizioni</button>
        <button style={styles.toggleBtn(view === "simulatore", "var(--secondary)")} onClick={() => setView("simulatore")}>Simulatore</button>
      </div>

      {view === "simulatore" ? (
        <SimulatorePanel />
      ) : (
        <>
      <div className="stats-row" style={styles.statsRow}>
        <StatCard label="Capitale investito" value={fmt(derived.totInvestito)} icon={PiggyBank} tone="neutral" />
        <StatCard label="Valore attuale" value={fmt(derived.totInvestimenti)} icon={Wallet} tone="neutral" />
        <StatCard
          label="Plus/minusvalenza"
          value={`${derived.plusMinus >= 0 ? "+" : ""}${fmt(derived.plusMinus)}`}
          sub={`${derived.plusMinusPct >= 0 ? "+" : ""}${derived.plusMinusPct.toFixed(1)}%`}
          icon={derived.plusMinus >= 0 ? TrendingUp : TrendingDown}
          tone={derived.plusMinus >= 0 ? "pos" : "neg"}
        />
      </div>

      <div className="two-col" style={styles.twoCol}>
        <Card title="Allocazione per tipologia">
          {derived.allocData.length === 0 ? (
            <EmptyState text="Nessun investimento registrato." />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={derived.allocData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={80} paddingAngle={2}>
                  {derived.allocData.map((_, i) => (
                    <Cell key={i} fill={PALETTE[i % PALETTE.length]} stroke="var(--bg)" strokeWidth={2} />
                  ))}
                </Pie>
                <Tooltip content={<CustomTooltip total={derived.allocData.reduce((t, d) => t + d.value, 0)} />} />
                <Legend layout="vertical" verticalAlign="middle" align="right" iconType="circle" iconSize={8}
                  formatter={(v) => <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{v}</span>} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Card>
        <Card title="Come funziona">
          <p style={styles.helpText}>
            Ogni investimento ha un capitale versato e un valore attuale, che puoi aggiornare quando controlli il tuo broker.
            La plusvalenza e il patrimonio netto si ricalcolano da soli in tutte le altre schede.
          </p>
        </Card>
      </div>

      <div style={styles.sectionHeader}>
        <h3 style={styles.h3}>Posizioni</h3>
        <button style={styles.primaryBtn} onClick={onAdd}>
          <Plus size={15} /> Nuovo investimento
        </button>
      </div>

      {investments.length === 0 ? (
        <Card><EmptyState text="Ancora nessun investimento registrato." /></Card>
      ) : (
        <div style={styles.invGrid}>
          {investments.map((inv) => (
            <InvestmentCard
              key={inv.id}
              inv={inv}
              onEdit={onEdit}
              onRemove={onRemove}
              onUpdateValue={onUpdateValue}
              onClosePosition={onClosePosition}
              accounts={accounts}
            />
          ))}
        </div>
      )}
        </>
      )}
    </div>
  );
}

// ---------- Patrimonio ----------
function InvestmentCard({ inv, onEdit, onRemove, onUpdateValue, onClosePosition, accounts }) {
  const [valueInput, setValueInput] = useState(String(inv.currentValue));
  useEffect(() => { setValueInput(String(inv.currentValue)); }, [inv.currentValue]);

  const investedTotal = computeInvestedTotal(inv);
  const pl = Number(inv.currentValue || 0) - investedTotal;
  const plPct = investedTotal > 0 ? (pl / investedTotal) * 100 : 0;
  const hasContribution = inv.contributionFrequency && inv.contributionFrequency !== "nessuno" && Number(inv.contributionAmount) > 0;

  const commitValue = () => {
    const n = Number(valueInput);
    if (!isNaN(n)) onUpdateValue(inv.id, n);
  };

  return (
    <div style={styles.invCard}>
      <div style={styles.invCardTop}>
        <div>
          <div style={styles.invName}>{inv.name}</div>
          <span style={styles.tag}>{inv.invType}</span>
        </div>
        <div style={{ display: "flex", gap: 2 }}>
          <button style={styles.iconBtn} onClick={() => onEdit(inv)} title="Modifica">
            <Pencil size={14} />
          </button>
          <button style={styles.iconBtn} onClick={() => onClosePosition(inv)} title="Chiudi posizione">
            <CheckCircle2 size={14} />
          </button>
          <button style={styles.iconBtn} onClick={() => onRemove(inv.id)} title="Elimina">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      {(inv.startDate || hasContribution || inv.accountId) && (
        <div style={styles.invMeta}>
          {inv.startDate && `dal ${formatDate(inv.startDate)}`}
          {inv.startDate && hasContribution && " · "}
          {hasContribution && `+${fmt(inv.contributionAmount)}/${CONTRIB_FREQ_UNIT[inv.contributionFrequency]}`}
          {hasContribution && inv.contributionStartDate && ` dal ${formatDate(inv.contributionStartDate)}`}
          {inv.source === "import" && inv.quantity ? ` · ${Number(inv.quantity).toLocaleString("it-IT", { maximumFractionDigits: 4 })} quote` : ""}
          {(accounts || []).find((a) => a.id === inv.accountId) && ` · conto ${(accounts || []).find((a) => a.id === inv.accountId).name}`}
        </div>
      )}
      <div style={styles.invRow}>
        <span style={styles.invLabel}>Versato</span>
        <span style={styles.invValue}>{fmtFull(investedTotal)}</span>
      </div>
      <div style={styles.invRow}>
        <span style={styles.invLabel}>Valore attuale</span>
        <MoneyInput
          value={valueInput}
          onChange={(e) => setValueInput(e.target.value)}
          onBlur={commitValue}
          style={styles.invInput}
        />
      </div>
      <div style={{ ...styles.invPl, color: pl >= 0 ? "var(--pos)" : "var(--neg)" }}>
        {pl >= 0 ? "+" : ""}{fmtFull(pl)} ({plPct >= 0 ? "+" : ""}{plPct.toFixed(1)}%)
      </div>
    </div>
  );
}

function SimulatorePanel() {
  const [initial, setInitial] = useState("10000");
  const [contribution, setContribution] = useState("200");
  const [frequency, setFrequency] = useState("mensile");
  const [annualReturn, setAnnualReturn] = useState("6");
  const [years, setYears] = useState("20");
  const [taxRate, setTaxRate] = useState("26");

  const result = useMemo(() => {
    return simulateInvestment({
      initial: Number(initial) || 0,
      contribution: Number(contribution) || 0,
      frequency,
      annualReturn: Number(annualReturn) || 0,
      years: Math.max(1, Number(years) || 1),
    });
  }, [initial, contribution, frequency, annualReturn, years]);

  const { series, finalBalance, finalInvested, finalGain } = result;
  const finalGainPct = finalInvested > 0 ? (finalGain / finalInvested) * 100 : 0;
  const taxNum = Number(taxRate) || 0;
  const netGain = finalGain * (1 - taxNum / 100);
  const netBalance = finalInvested + netGain;
  const netGainPct = finalInvested > 0 ? (netGain / finalInvested) * 100 : 0;

  const chartData = series.map((p) => ({
    year: `${p.year}°`,
    "Capitale investito": Math.round(p.invested),
    "Valore investimento": Math.round(p.balance),
  }));

  return (
    <div style={styles.grid}>
      <Card title="Parametri simulazione">
        <div style={styles.filterGrid}>
          <Field label="Capitale iniziale (€)">
            <MoneyInput value={initial} onChange={(e) => setInitial(e.target.value)} style={styles.input} />
          </Field>
          <Field label="Contributo periodico (€)">
            <MoneyInput value={contribution} onChange={(e) => setContribution(e.target.value)} style={styles.input} />
          </Field>
          <Field label="Frequenza contributo">
            <select value={frequency} onChange={(e) => setFrequency(e.target.value)} style={styles.input}>
              {CONTRIB_FREQ.filter((f) => f.id !== "nessuno").map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </Field>
          <Field label="Rendimento atteso annuo (%)">
            <input type="number" value={annualReturn} onChange={(e) => setAnnualReturn(e.target.value)} style={styles.input} />
          </Field>
          <Field label="Orizzonte temporale (anni)">
            <input type="number" min="1" max="50" value={years} onChange={(e) => setYears(e.target.value)} style={styles.input} />
          </Field>
          <Field label="Tassazione sul guadagno (%, opzionale)">
            <MoneyInput value={taxRate} onChange={(e) => setTaxRate(e.target.value)} style={styles.input} />
          </Field>
        </div>
      </Card>

      <div className="stats-row" style={styles.statsRow}>
        <StatCard label="Capitale investito" value={fmt(finalInvested)} icon={PiggyBank} tone="neutral" />
        <StatCard label="Valore finale stimato" value={fmt(finalBalance)} icon={Wallet} tone="neutral" />
        <StatCard
          label="Guadagno lordo"
          value={`+${fmt(finalGain)}`}
          sub={`+${finalGainPct.toFixed(1)}%`}
          icon={TrendingUp}
          tone="pos"
        />
        <StatCard
          label="Guadagno netto (dopo tasse)"
          value={`+${fmt(netGain)}`}
          sub={`+${netGainPct.toFixed(1)}% · finale ${fmt(netBalance)}`}
          icon={TrendingUp}
          tone="posMuted"
        />
      </div>

      <Card title="Andamento stimato">
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
            <defs>
              <linearGradient id="gradSim" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="year" stroke="var(--text-muted)" fontSize={11} tickLine={false} axisLine={{ stroke: "var(--border)" }} />
            <YAxis stroke="var(--text-muted)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => fmt(v)} width={70} />
            <Tooltip content={<CustomTooltip />} />
            <Legend formatter={(v) => <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{v}</span>} />
            <Area type="monotone" dataKey="Valore investimento" stroke="var(--accent)" strokeWidth={2} fill="url(#gradSim)" />
            <Line type="monotone" dataKey="Capitale investito" stroke="var(--secondary)" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </Card>

      <Card title="Riepilogo a scadenza">
        <div style={styles.summaryGrid}>
          <SummaryRow label="Capitale investito" value={fmt(finalInvested)} />
          <SummaryRow label="Valore finale (lordo)" value={fmt(finalBalance)} />
          <SummaryRow label="Guadagno lordo" value={`+${fmt(finalGain)} (+${finalGainPct.toFixed(1)}%)`} highlight="pos" />
          {taxNum > 0 && (
            <>
              <SummaryRow label={`Tasse stimate (${taxNum}% sul guadagno)`} value={fmt(finalGain - netGain)} />
              <SummaryRow label="Valore finale netto" value={fmt(netBalance)} bold />
            </>
          )}
        </div>
        <p style={{ ...styles.helpText, marginTop: 12 }}>
          Stima a rendimento costante con capitalizzazione mensile — non tiene conto di inflazione, volatilità dei mercati o variazioni future del rendimento. Utile come riferimento, non come previsione.
        </p>
      </Card>
    </div>
  );
}

function Patrimonio({ derived: derivedAll, state: stateAll, onAddAccount, onEditAccount, onRemoveAccount, onSetDefaultAccount }) {
  const [account, setAccount] = useState("all");
  const accountId = stateAll.accounts.some((a) => a.id === account) ? account : "all";
  const state = useMemo(() => (accountId === "all" ? stateAll : viewForAccount(stateAll, accountId)), [stateAll, accountId]); // eslint-disable-line no-unused-vars
  const derived = useMemo(() => (accountId === "all" ? derivedAll : computeDerived(state)), [derivedAll, state, accountId]);
  const scopeName = accountId === "all" ? null : stateAll.accounts.find((a) => a.id === accountId)?.name;
  const [period, setPeriod] = useState("6m");
  const [range, setRange] = useState(() => ({ from: addMonthsClamped(todayISO(), -3), to: todayISO() }));
  const composizione = [
    { name: "Liquidità", value: derived.liquidita },
    { name: "Investimenti", value: derived.totInvestimenti },
  ].filter((d) => d.value !== 0);

  const chartData = useMemo(() => sliceDaily(derived.dailyFull, period, derived.hasPrevisto, range), [period, range, derived.dailyFull, derived.hasPrevisto]);

  return (
    <div style={styles.grid}>
      {stateAll.accounts.length > 1 && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <AccountFilter accounts={stateAll.accounts} value={accountId} onChange={setAccount} />
        </div>
      )}
      <Card title={scopeName ? `Patrimonio netto · ${scopeName}` : "Patrimonio netto totale"}>
        <div style={styles.bigNumber}>{fmt(derived.patrimonioNetto)}</div>
        <div style={styles.bigNumberSub}>
          Liquidità {fmt(derived.liquidita)} · Investimenti {fmt(derived.totInvestimenti)}
        </div>
      </Card>

      <Card title="Gestione Conti">
        <p style={{ ...styles.helpText, marginTop: 0 }}>
          I conti (banca, contanti, carte, beni…) sono quelli selezionabili quando inserisci un movimento o apri un investimento.
          Il <strong style={{ color: "var(--text-soft)" }}>saldo iniziale</strong> è il saldo del conto all'inizio del monitoraggio, prima del primo movimento registrato;
          il <strong style={{ color: "var(--text-soft)" }}>saldo corrente</strong> non si modifica a mano: si aggiorna con i movimenti del conto.
        </p>
        <div style={{ ...styles.balanceGrid, gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
          {derivedAll.accounts.map((a) => (
            <div key={a.id} style={{ ...styles.balanceCard, borderColor: a.isDefault ? "color-mix(in srgb, var(--accent) 53%, transparent)" : "var(--border)" }}>
              <div style={styles.balanceCardTop}>
                <div>
                  <div style={styles.invName}>{a.name}</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ ...styles.tag, whiteSpace: "nowrap" }}>{a.type}</span>
                    {a.isDefault && <span style={{ ...styles.tag, whiteSpace: "nowrap", color: "var(--accent)", borderColor: "color-mix(in srgb, var(--accent) 40%, transparent)" }}>predefinito</span>}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 2 }}>
                  <button style={styles.iconBtn} onClick={() => onEditAccount(a)} title="Modifica"><Pencil size={14} /></button>
                  <button style={styles.iconBtn} onClick={() => onRemoveAccount(a.id)} title="Elimina"><Trash2 size={14} /></button>
                </div>
              </div>
              <div style={styles.invRow}>
                <span style={styles.invLabel}>Saldo iniziale</span>
                <span style={styles.invValue}>{fmtFull(a.initialBalance)}</span>
              </div>
              <div style={styles.invRow}>
                <span style={styles.invLabel}>Saldo corrente</span>
                <span style={{ ...styles.balanceValue, color: a.balance < 0 ? "var(--neg)" : "var(--text)" }}>{fmtFull(a.balance)}</span>
              </div>
              {a.alignClosing && (
                <div style={{ ...styles.invMeta, marginBottom: 0 }}>
                  allineato all'ultimo estratto: {fmtFull(a.alignClosing.amount)} al {formatDate(a.alignClosing.date)}
                </div>
              )}
              {!a.isDefault && (
                <button style={{ ...styles.linkBtn, marginTop: 8 }} onClick={() => onSetDefaultAccount(a.id)}>Imposta come predefinito</button>
              )}
            </div>
          ))}
        </div>
        <div style={styles.balanceTotalRow}>
          <span>Saldo corrente totale</span>
          <span style={styles.balanceTotalValue}>{fmtFull(derivedAll.liquidita)}</span>
        </div>
        <button style={{ ...styles.primaryBtn, marginTop: 12 }} onClick={onAddAccount}>
          <Plus size={15} /> Aggiungi conto
        </button>
      </Card>

      <div className="two-col" style={styles.twoCol}>
        <Card title="Composizione patrimonio">
          {composizione.length === 0 ? (
            <EmptyState text="Aggiungi movimenti o investimenti per vedere la composizione." />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={composizione} dataKey="value" nameKey="name" innerRadius={50} outerRadius={85} paddingAngle={2}>
                  {composizione.map((_, i) => (
                    <Cell key={i} fill={["var(--secondary)", "var(--accent)"][i % 2]} stroke="var(--bg)" strokeWidth={2} />
                  ))}
                </Pie>
                <Tooltip content={<CustomTooltip total={composizione.reduce((t, d) => t + d.value, 0)} />} />
                <Legend iconType="circle" iconSize={8} formatter={(v) => <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{v}</span>} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="Andamento patrimonio" extra={<PeriodSelector value={period} onChange={setPeriod} range={range} onRange={setRange} />}>
          {chartData.length === 0 ? (
            <EmptyState text="Nessun dato nell'intervallo scelto: i movimenti partono dal primo registrato." />
          ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" stroke="var(--text-muted)" fontSize={11} tickLine={false} axisLine={{ stroke: "var(--border)" }} tickFormatter={dayTick(period, range)} minTickGap={36} />
              <YAxis stroke="var(--text-muted)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => fmt(v)} width={70} domain={["auto", "auto"]} />
              <Tooltip content={<CustomTooltip />} />
              <Legend formatter={(v) => <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{v}</span>} />
              <Line type="linear" dataKey="liquidita" name="Liquidità" stroke="var(--secondary)" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line type="linear" dataKey="patrimonio" name="Patrimonio" stroke="var(--accent)" strokeWidth={2} dot={false} isAnimationActive={false} />
              {derived.hasPrevisto && (
                <Line type="linear" dataKey="patrimonioPrevisto" name="Proiezione (con previsti)" stroke="var(--chart-3)" strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
              )}
            </LineChart>
          </ResponsiveContainer>
          )}
        </Card>
      </div>

      <Card title="Riepilogo">
        <div style={styles.summaryGrid}>
          <SummaryRow label="Saldi iniziali dei conti" value={fmt(derived.totPatrimonioPartenza)} />
          <SummaryRow label="Totale entrate storiche" value={fmt(derived.totEntrate)} />
          <SummaryRow label="Totale uscite storiche" value={fmt(derived.totUscite)} />
          <SummaryRow label="Trasferimenti e investimenti (netto)" value={fmt(derived.nonFlowNet)} />
          <SummaryRow label="Liquidità disponibile" value={fmt(derived.liquidita)} />
          <SummaryRow label="Capitale investito" value={fmt(derived.totInvestito)} />
          <SummaryRow label="Valore investimenti" value={fmt(derived.totInvestimenti)} />
          <SummaryRow label="Plus/minusvalenza" value={fmt(derived.plusMinus)} highlight={derived.plusMinus >= 0 ? "pos" : "neg"} />
          <SummaryRow label="Patrimonio netto" value={fmt(derived.patrimonioNetto)} bold />
        </div>
      </Card>
    </div>
  );
}

function SummaryRow({ label, value, bold, highlight }) {
  return (
    <div style={styles.summaryRow}>
      <span style={{ color: "var(--text-muted)", fontSize: 13 }}>{label}</span>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: bold ? 16 : 14,
          fontWeight: bold ? 700 : 500,
          color: highlight === "pos" ? "var(--pos)" : highlight === "neg" ? "var(--neg)" : "var(--text)",
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ---------- Budget ----------
function BudgetTab({ budgets, transactions, onAdd, onEdit, onRemove }) {
  const todayMk = todayISO().slice(0, 7);
  const [mk, setMk] = useState(todayMk);
  const shift = (n) => setMk(addMonthsClamped(mk + "-01", n).slice(0, 7));
  const [yy, mm] = mk.split("-").map(Number);
  const monthLabel = new Date(yy, mm - 1, 1).toLocaleDateString("it-IT", { month: "long", year: "numeric" });

  const rows = useMemo(
    () => budgets.map((b) => ({ b, st: computeBudgetStatus(b, transactions, mk) })).sort((a, c) => c.st.pct - a.st.pct),
    [budgets, transactions, mk]
  );
  const catRows = rows.filter((r) => r.b.category !== BUDGET_ALL);
  // un budget su una sottocategoria non si somma se esiste già il budget dell'intera categoria (sarebbe contata due volte)
  const totRows = catRows.filter((r) => !r.b.subcategory || !catRows.some((x) => x.b.category === r.b.category && !x.b.subcategory));
  const totLimit = totRows.reduce((s, r) => s + r.st.limit, 0);
  const totSpent = totRows.reduce((s, r) => s + r.st.spent, 0);
  const totPct = totLimit > 0 ? (totSpent / totLimit) * 100 : 0;

  return (
    <div style={styles.grid}>
      <div style={styles.sectionHeader}>
        <div style={styles.monthNav}>
          <button style={styles.iconBtn} onClick={() => shift(-1)} title="Mese precedente">‹</button>
          <span style={styles.monthLabel}>{monthLabel}</span>
          <button style={styles.iconBtn} onClick={() => shift(1)} title="Mese successivo">›</button>
          {mk !== todayMk && <button style={styles.linkBtn} onClick={() => setMk(todayMk)}>Oggi</button>}
        </div>
        <button style={styles.primaryBtn} onClick={onAdd}><Plus size={15} /> Nuovo budget</button>
      </div>

      {catRows.length > 0 && (
        <div className="stats-row" style={styles.statsRow}>
          <StatCard label="Budget categorie" value={fmt(totLimit)} icon={Target} tone="neutral" />
          <StatCard label="Speso" value={fmt(totSpent)} sub={`${totPct.toFixed(0)}% del budget`} icon={ArrowDownRight} tone={totPct >= 100 ? "neg" : "neutral"} />
          <StatCard
            label={totLimit - totSpent >= 0 ? "Ancora disponibile" : "Sforato di"}
            value={fmt(Math.abs(totLimit - totSpent))}
            icon={totLimit - totSpent >= 0 ? TrendingUp : TrendingDown}
            tone={totLimit - totSpent >= 0 ? "pos" : "neg"}
          />
        </div>
      )}

      {rows.length === 0 ? (
        <Card>
          <EmptyState text="Nessun budget. Imposta un limite mensile per una categoria di spesa e scegli a che percentuale ricevere l'avviso." />
        </Card>
      ) : (
        <div style={styles.catList}>
          {rows.map(({ b, st }) => {
            const color = BUDGET_COLORS[st.level];
            const pctShown = Math.min(100, st.pct);
            const projShown = Math.min(100, st.projPct);
            return (
              <div key={b.id} style={styles.catRow}>
                <div style={styles.budgetTop}>
                  <div>
                    <div style={styles.catName}>{budgetName(b)}</div>
                    <span style={{ ...styles.tag, color, borderColor: alpha(color, 40) }}>{st.label}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ ...styles.budgetPct, color }}>{Math.round(st.pct)}%</span>
                    <button style={styles.iconBtn} onClick={() => onEdit(b)}><Pencil size={14} /></button>
                    <button style={styles.iconBtn} onClick={() => onRemove(b.id)}><Trash2 size={14} /></button>
                  </div>
                </div>

                <div style={styles.budgetBarWrap}>
                  {st.planned > 0 && <div style={styles.budgetBarPlanned(pctShown, projShown)} />}
                  <div style={styles.budgetBarFill(pctShown, color)} />
                  {st.warnAt <= 100 && <div style={styles.budgetMarker(st.warnAt)} title={`Avviso a ${st.warnAt}%`} />}
                  {st.alertAt <= 100 && <div style={styles.budgetMarker(st.alertAt)} title={`Soglia critica a ${st.alertAt}%`} />}
                </div>

                <div style={styles.budgetInfo}>
                  <span>Speso {fmtFull(st.spent)} di {fmtFull(st.limit)}</span>
                  <span style={{ color: st.remaining >= 0 ? "var(--text-muted)" : "var(--neg)" }}>
                    {st.remaining >= 0 ? `Restano ${fmtFull(st.remaining)}` : `Sforato di ${fmtFull(-st.remaining)}`}
                  </span>
                </div>
                {st.planned > 0 && (
                  <div style={styles.invMeta}>
                    + {fmtFull(st.planned)} previsti → {Math.round(st.projPct)}% a fine mese
                  </div>
                )}
                <div style={styles.invMeta}>Avvisi a {st.warnAt}% e {st.alertAt}%</div>
              </div>
            );
          })}
        </div>
      )}
      <p style={styles.helpText}>Il budget è mensile e conta solo le uscite effettive; le uscite previste appaiono come tratto più chiaro nella barra.</p>
    </div>
  );
}

// ---------- Categorie ----------
function RulesCard({ rules, categories, onAdd, onApply, onRemove }) {
  const [text, setText] = useState("");
  const [type, setType] = useState("uscita");
  const [category, setCategory] = useState("");
  const [subcategory, setSubcategory] = useState("");
  const cats = (categories[type] || []).filter((c) => !c.transfer);
  const cat = cats.find((c) => c.name === category) || cats[0];
  const subs = cat?.subcategories || [];

  const submit = () => {
    if (!text.trim() || !cat) return;
    onAdd({ text, type, category: cat.name, subcategory: subcategory.trim() });
    setText(""); setSubcategory("");
  };

  return (
    <div style={{ marginTop: 20 }}>
      <Card title="Regole di categorizzazione automatica">
        <p style={{ ...styles.helpText, marginTop: 0 }}>
          Se la descrizione di un movimento contiene il testo indicato (maiuscole/minuscole non contano), l'importazione degli estratti conto lo assegna in automatico a categoria e sottocategoria scelte. Le regole valgono solo per il tuo utente.
        </p>
        {rules.length === 0 ? (
          <EmptyState text="Nessuna regola. Aggiungine una qui sotto." />
        ) : (
          <div style={styles.catList}>
            {rules.map((r) => (
              <div key={r.id} style={{ ...styles.catRow, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div style={{ fontSize: 13, color: "var(--text-soft)" }}>
                  Se contiene <strong style={{ color: "var(--text)" }}>«{r.text}»</strong> ({r.type === "entrata" ? "entrate" : "uscite"}) → <span style={styles.tag}>{r.category}{r.subcategory ? ` › ${r.subcategory}` : ""}</span>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <button style={{ ...styles.linkBtn, marginTop: 0 }} onClick={() => onApply(r.id)} title="Aggiorna anche i movimenti già registrati">Applica ai movimenti esistenti</button>
                  <button style={styles.iconBtn} onClick={() => onRemove(r.id)} title="Elimina regola"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div style={{ ...styles.filterGrid, marginTop: 16 }}>
          <Field label="Se la descrizione contiene">
            <input type="text" placeholder="es. AMAZON" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} style={styles.input} />
          </Field>
          <Field label="Tipo">
            <select value={type} onChange={(e) => { setType(e.target.value); setCategory(""); setSubcategory(""); }} style={styles.input}>
              <option value="uscita">Uscita</option>
              <option value="entrata">Entrata</option>
            </select>
          </Field>
          <Field label="Categoria">
            <select value={cat?.name || ""} onChange={(e) => { setCategory(e.target.value); setSubcategory(""); }} style={styles.input}>
              {cats.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Sottocategoria (opzionale)">
            <input type="text" list="rule-subs" placeholder="es. Amazon" value={subcategory} onChange={(e) => setSubcategory(e.target.value)} style={styles.input} />
            <datalist id="rule-subs">{subs.map((x) => <option key={x.id} value={x.name} />)}</datalist>
          </Field>
        </div>
        <button style={{ ...styles.primaryBtn, opacity: text.trim() && cat ? 1 : 0.5 }} disabled={!text.trim() || !cat} onClick={submit}>
          <Plus size={15} /> Aggiungi regola
        </button>
      </Card>
    </div>
  );
}

function CategorieTab({ categories, onAdd, onRename, onDelete, onMove, onAddSub, onRenameSub, onDeleteSub, onMoveSub }) {
  const [type, setType] = useState("uscita");
  const [sortMode, setSortMode] = useState("custom");
  const [newCatName, setNewCatName] = useState("");

  const list = categories[type] || [];
  const sorted = useMemo(() => sortList(list, sortMode), [list, sortMode]);

  const submitNewCat = () => {
    const name = newCatName.trim();
    if (!name) return;
    onAdd(type, name);
    setNewCatName("");
  };

  return (
    <div style={styles.grid}>
      <div style={styles.sectionHeader}>
        <div style={styles.toggleRow}>
          <button style={styles.toggleBtn(type === "uscita", "var(--neg)")} onClick={() => setType("uscita")}>Uscite</button>
          <button style={styles.toggleBtn(type === "entrata", "var(--pos)")} onClick={() => setType("entrata")}>Entrate</button>
        </div>
        <div style={styles.filterRow}>
          {[["custom", "Personalizzato"], ["alpha", "Alfabetico"], ["chrono", "Cronologico"]].map(([id, label]) => (
            <button key={id} style={styles.filterBtn(sortMode === id)} onClick={() => setSortMode(id)}>{label}</button>
          ))}
        </div>
      </div>

      <Card>
        <div style={styles.catAddRow}>
          <input
            type="text"
            placeholder="Nuova categoria…"
            value={newCatName}
            onChange={(e) => setNewCatName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitNewCat(); }}
            style={styles.input}
          />
          <button style={styles.catAddConfirm} onClick={submitNewCat}>Aggiungi</button>
        </div>
      </Card>

      {sorted.length === 0 ? (
        <Card><EmptyState text="Nessuna categoria." /></Card>
      ) : (
        <div style={styles.catList}>
          {sorted.map((cat, idx) => (
            <CategoryRow
              key={cat.id}
              type={type}
              cat={cat}
              sortMode={sortMode}
              isFirst={idx === 0}
              isLast={idx === sorted.length - 1}
              onRename={onRename}
              onDelete={onDelete}
              onMove={onMove}
              onAddSub={onAddSub}
              onRenameSub={onRenameSub}
              onDeleteSub={onDeleteSub}
              onMoveSub={onMoveSub}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CategoryRow({ type, cat, sortMode, isFirst, isLast, onRename, onDelete, onMove, onAddSub, onRenameSub, onDeleteSub, onMoveSub }) {
  const [editing, setEditing] = useState(false);
  const [nameVal, setNameVal] = useState(cat.name);
  const [addingSub, setAddingSub] = useState(false);
  const [subName, setSubName] = useState("");

  const saveName = () => {
    const v = nameVal.trim();
    if (v && v !== cat.name) onRename(type, cat.id, v);
    setEditing(false);
  };
  const saveSub = () => {
    const v = subName.trim();
    if (v) onAddSub(type, cat.id, v);
    setSubName("");
    setAddingSub(false);
  };

  const subsSorted = sortList(cat.subcategories, sortMode);

  return (
    <div style={styles.catRow}>
      <div style={styles.catRowTop}>
        {sortMode === "custom" && (
          <div style={styles.reorderCol}>
            <button disabled={isFirst} style={styles.reorderBtn(isFirst)} onClick={() => onMove(type, cat.id, -1)}>
              <ArrowUp size={12} />
            </button>
            <button disabled={isLast} style={styles.reorderBtn(isLast)} onClick={() => onMove(type, cat.id, 1)}>
              <ArrowDown size={12} />
            </button>
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <div style={styles.catAddRow}>
              <input
                autoFocus
                value={nameVal}
                onChange={(e) => setNameVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveName();
                  if (e.key === "Escape") { setEditing(false); setNameVal(cat.name); }
                }}
                style={styles.input}
              />
              <button style={styles.catAddConfirm} onClick={saveName}>Salva</button>
            </div>
          ) : (
            <div style={styles.catNameRow}>
              <span style={styles.catName}>
                {cat.name}
                {cat.transfer && <span style={{ ...styles.tag, marginLeft: 8 }} title="Categoria usata dai giroconti tra conti: si può rinominare ma non eliminare">giroconti</span>}
              </span>
              <div style={styles.catActions}>
                <button style={styles.iconBtn} onClick={() => setEditing(true)}><Pencil size={13} /></button>
                {!cat.transfer && <button style={styles.iconBtn} onClick={() => onDelete(type, cat.id)}><Trash2 size={13} /></button>}
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={styles.subWrap}>
        {subsSorted.map((sub, sidx) => (
          <SubChip
            key={sub.id}
            type={type}
            catId={cat.id}
            sub={sub}
            sortMode={sortMode}
            isFirst={sidx === 0}
            isLast={sidx === subsSorted.length - 1}
            onRename={onRenameSub}
            onDelete={onDeleteSub}
            onMove={onMoveSub}
          />
        ))}
        {addingSub ? (
          <div style={styles.catAddRow}>
            <input
              autoFocus
              placeholder="Nome sottocategoria"
              value={subName}
              onChange={(e) => setSubName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveSub(); if (e.key === "Escape") setAddingSub(false); }}
              style={{ ...styles.input, width: 160 }}
            />
            <button style={styles.catAddConfirm} onClick={saveSub}>Aggiungi</button>
          </div>
        ) : (
          <button style={styles.subAddBtn} onClick={() => setAddingSub(true)}>
            <Plus size={12} /> Sottocategoria
          </button>
        )}
      </div>
    </div>
  );
}

function SubChip({ type, catId, sub, sortMode, isFirst, isLast, onRename, onDelete, onMove }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(sub.name);

  const save = () => {
    const v = val.trim();
    if (v && v !== sub.name) onRename(type, catId, sub.id, v);
    setEditing(false);
  };

  if (editing) {
    return (
      <div style={styles.catAddRow}>
        <input
          autoFocus
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { setEditing(false); setVal(sub.name); } }}
          style={{ ...styles.input, width: 140 }}
        />
        <button style={styles.catAddConfirm} onClick={save}>Salva</button>
      </div>
    );
  }

  return (
    <span style={styles.subChip}>
      {sortMode === "custom" && (
        <>
          <button disabled={isFirst} style={styles.subReorderBtn(isFirst)} onClick={() => onMove(type, catId, sub.id, -1)}>‹</button>
          <button disabled={isLast} style={styles.subReorderBtn(isLast)} onClick={() => onMove(type, catId, sub.id, 1)}>›</button>
        </>
      )}
      {sub.name}
      <button style={styles.subChipBtn} onClick={() => setEditing(true)}><Pencil size={10} /></button>
      <button style={styles.subChipBtn} onClick={() => onDelete(type, catId, sub.id)}><X size={10} /></button>
    </span>
  );
}

// ---------- Shared bits ----------
function StatCard({ label, value, sub, icon: IconC, tone }) {
  const muted = tone === "posMuted" || tone === "negMuted";
  const toneColor =
    tone === "pos" || tone === "posMuted" ? "var(--pos)" :
    tone === "neg" || tone === "negMuted" ? "var(--neg)" : "var(--accent)";
  return (
    <div style={muted ? styles.statCardMuted : styles.statCard}>
      <div style={styles.statTop}>
        <span style={styles.statLabel}>{label}</span>
        <IconC size={16} color={toneColor} strokeWidth={2} style={muted ? { opacity: 0.7 } : undefined} />
      </div>
      <div style={{ ...styles.statValue, opacity: muted ? 0.85 : 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: toneColor, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Card({ title, extra, children }) {
  return (
    <div style={styles.card}>
      {(title || extra) && (
        <div style={styles.cardHeaderRow}>
          {title && <div style={styles.cardTitle}>{title}</div>}
          {extra}
        </div>
      )}
      {children}
    </div>
  );
}

function PeriodSelector({ value, onChange, range, onRange }) {
  const custom = value === "custom";
  const r = range || { from: "", to: "" };
  const today = todayISO();
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, maxWidth: "100%" }}>
      <div style={{ ...styles.filterRow, justifyContent: "flex-end" }}>
        {PERIODS.map((p) => (
          <button key={p.id} onClick={() => onChange(p.id)} style={styles.filterBtn(value === p.id)}>
            {p.label}
          </button>
        ))}
        {onRange && (
          <button onClick={() => onChange("custom")} style={styles.filterBtn(custom)} title="Scegli le date di inizio e fine">
            Intervallo
          </button>
        )}
      </div>
      {custom && onRange && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <label style={styles.rangeLabel}>
            Dal
            <input type="date" value={r.from} max={r.to || today} onChange={(e) => onRange({ ...r, from: e.target.value })} style={styles.rangeInput} />
          </label>
          <label style={styles.rangeLabel}>
            al
            <input type="date" value={r.to} min={r.from || undefined} onChange={(e) => onRange({ ...r, to: e.target.value })} style={styles.rangeInput} />
          </label>
        </div>
      )}
    </div>
  );
}

function EmptyState({ text }) {
  return <div style={styles.emptyState}>{text}</div>;
}

function CustomTooltip({ active, payload, label, total }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={styles.tooltip}>
      {label && <div style={styles.tooltipLabel}>{/^\d{4}-\d{2}-\d{2}$/.test(label) ? formatDate(label) : label}</div>}
      {payload.map((p, i) => {
        const pct = total
          ? (Number(p.value) / total) * 100
          : typeof p.percent === "number" ? p.percent * 100 : null;
        return (
          <div key={i} style={styles.tooltipRow}>
            <span style={{ color: p.color || p.payload?.fill }}>{p.name}</span>
            <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              {fmt(p.value)}{pct !== null ? ` · ${pct.toFixed(1)}%` : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function formatDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" });
}

// ---------- Modals ----------
function ModalShell({ title, onClose, children, wide }) {
  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={wide ? { ...styles.modal, width: 900 } : styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>{title}</span>
          <button style={styles.iconBtn} onClick={onClose}><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Checkbox({ checked, indeterminate, onChange, title }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate && !checked; }, [indeterminate, checked]);
  return <input ref={ref} type="checkbox" className="fx-check" checked={checked} onChange={onChange} title={title} />;
}

const fmtISO = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const dayDiff = (a, b) => Math.abs((new Date(a + "T00:00:00") - new Date(b + "T00:00:00")) / 86400000);

function ImportStatementModal({ onClose, onImport, transactions, investments, accounts, categories, rules }) {
  const [step, setStep] = useState("choose"); // choose | review | done
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState(null);
  const [rows, setRows] = useState([]);
  const [useOpening, setUseOpening] = useState(true);
  const [usePositions, setUsePositions] = useState(true);
  const [lastPages, setLastPages] = useState(null); // pagine del PDF (solo in memoria) per la diagnostica anonima
  const [forceImport, setForceImport] = useState(false);
  const [diagCopied, setDiagCopied] = useState("");
  const [targetId, setTargetId] = useState("__new__"); // conto di destinazione ("__new__" = crea un nuovo conto)
  const [result, setResult] = useState(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = async (file) => {
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") throw new Error("Seleziona un file PDF.");
      const data = new Uint8Array(await file.arrayBuffer());
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      const pages = await extractPages(pdfjs, data);
      setLastPages(pages);
      setForceImport(false);
      setDiagCopied("");
      const st = parseStatement(pages);

      // --- classificazione anti-duplicato ---
      // "già importato" = esiste ancora un movimento con la stessa chiave (se lo elimini, può essere reimportato)
      const known = new Set();
      transactions.forEach((t) => { if (t.importKey) known.add(t.importKey); });
      const manual = transactions.filter((t) => !t.importKey);
      const names = { entrata: categories.entrata.map((c) => c.name), uscita: categories.uscita.map((c) => c.name) };
      const classified = st.transactions.map((tx) => {
        let status = "new";
        if (known.has(tx.key)) status = "imported";
        else if (manual.some((m) => m.type === tx.type && Math.round(Number(m.amount) * 100) === Math.round(tx.amount * 100) && dayDiff(m.date, tx.date) <= 3)) status = "maybe";
        const rule = matchRule(rules, tx);
        return {
          tx, status, checked: status === "new",
          category: rule ? rule.category : suggestCategory(tx, names[tx.type], (categories[tx.type].find((c) => c.transfer) || {}).name),
          subcategory: rule ? rule.subcategory || null : null,
        };
      });

      setUseOpening(true);
      // conto di destinazione: quello già collegato a questo conto bancario, altrimenti se ne crea uno nuovo
      const linked = st.account ? accounts.find((a) => a.importKey === `opening:${st.account}`) : null;
      setTargetId(linked ? linked.id : "__new__");

      setParsed(st);
      setRows(classified);
      setFileName(file.name);
      setStep("review");
    } catch (e) {
      console.error(e);
      setError(e?.message || "Impossibile leggere il file.");
    } finally {
      setBusy(false);
    }
  };

  const counts = useMemo(() => ({
    fresh: rows.filter((r) => r.status === "new").length,
    imported: rows.filter((r) => r.status === "imported").length,
    maybe: rows.filter((r) => r.status === "maybe").length,
    selected: rows.filter((r) => r.checked).length,
  }), [rows]);

  // Allineamento del conto all'ultimo saldo finale letto dall'estratto:
  // il saldo iniziale del conto viene calcolato in modo che  iniziale + movimenti = saldo finale.
  const isNewAccount = targetId === "__new__";
  const targetAcc = isNewAccount ? null : accounts.find((a) => a.id === targetId) || null;
  const alignment = useMemo(() => {
    if (!parsed) return null;
    const stmtKeys = new Set(parsed.transactions.map((t) => t.key));
    const signed = (t) => (t.type === "entrata" ? Number(t.amount) : -Number(t.amount));
    const prev = targetAcc?.alignClosing;
    const latest = prev && prev.date > parsed.closing.date ? prev : parsed.closing; // non retrocedere a un estratto più vecchio
    let net = 0;
    transactions.forEach((t) => {
      const mine = (targetAcc && t.accountId === targetAcc.id) || (!t.importAccount && t.importKey && stmtKeys.has(t.importKey));
      if (mine && t.date <= latest.date) net += signed(t);
    });
    rows.forEach((r) => { if (r.checked && r.status !== "imported" && r.tx.date <= latest.date) net += signed(r.tx); });
    const importKey = parsed.account ? `opening:${parsed.account}` : null;
    const value = Math.round((latest.amount - net) * 100) / 100;
    const changed = isNewAccount || Math.round(Number(targetAcc.initialBalance) * 100) !== Math.round(value * 100);
    return { importKey, value, latest, changed };
  }, [parsed, rows, transactions, targetAcc, isNewAccount]);
  const alignAction = useOpening && !!alignment && alignment.changed;

  // Posizioni di investimento ricavate dagli acquisti/vendite di titoli dell'estratto.
  // Righe già importate contano solo se per quel titolo non esiste ancora una posizione "da import" (così non si applicano due volte).
  const positionPlan = useMemo(() => {
    const accId = targetAcc ? targetAcc.id : "__preview__";
    const trades = [];
    rows.forEach((r) => {
      const ins = r.tx.instrument;
      if (!ins) return;
      const hasPosition = investments.some((i) => i.source === "import" && i.isin === ins.isin && i.accountId === accId);
      const isNewRow = r.checked && r.status !== "imported";
      const isOldRow = r.status === "imported" && !hasPosition;
      if (isNewRow || isOldRow) trades.push({ isin: ins.isin, name: ins.name, qty: ins.qty, side: ins.side, amount: r.tx.amount, date: r.tx.date });
    });
    if (trades.length === 0) return null;
    const mine = (list) => list.filter((i) => i.source === "import" && i.accountId === accId);
    const before = mine(investments);
    const after = mine(applyTrades(investments, trades, accId));
    const sum = (l) => l.reduce((s, i) => s + Number(i.currentValue || 0), 0);
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    if (!changed) return null; // niente da creare/aggiornare: l'opzione non viene proposta
    return { trades, count: after.length, delta: sum(after) - sum(before) };
  }, [rows, investments, targetAcc]);
  const positionAction = usePositions && !!positionPlan;
  const selectable = rows.filter((r) => r.status !== "imported");
  const allChecked = selectable.length > 0 && selectable.every((r) => r.checked);
  const someChecked = selectable.some((r) => r.checked);

  const setRow = (i, patch) => setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const toggleAll = () => setRows((prev) => prev.map((r) => (r.status === "imported" ? r : { ...r, checked: !allChecked })));

  const doImport = () => {
    const chosen = rows.filter((r) => r.checked && r.status !== "imported");
    const accId = isNewAccount ? uid() : targetAcc.id;
    const newTx = chosen.map((r) => ({
      id: uid(),
      type: r.tx.type,
      amount: r.tx.amount,
      category: r.category,
      subcategory: r.subcategory || null,
      description: r.tx.description,
      date: r.tx.date,
      accountId: accId,
      importKey: r.tx.key,
      importAccount: parsed.account,
      // i giroconti importati restano fuori dalle statistiche di entrate/uscite
      ...(r.category.toLowerCase() === ((categories[r.tx.type].find((c) => c.transfer) || {}).name || "").toLowerCase() ? { isTransfer: true } : {}),
    }));
    const align = alignAction ? { initialBalance: alignment.value, asOf: alignment.latest.date, alignClosing: alignment.latest } : {};
    const link = alignment.importKey ? { importKey: alignment.importKey } : {};
    const account = isNewAccount
      ? { id: accId, isNew: true, fields: { name: `Conto ${parsed.bank} ${parsed.accountLabel}`, type: "Conto bancario", initialBalance: 0, ...align, ...link } }
      : { id: accId, isNew: false, fields: { ...align, ...link } };
    onImport({ transactions: newTx, account, trades: positionAction ? positionPlan.trades : null, tag: parsed.account ? { account: parsed.account, accountId: accId, keys: parsed.transactions.map((t) => t.key) } : null });
    setResult({ added: newTx.length, skipped: counts.imported, opening: alignAction, created: isNewAccount, positions: positionAction ? positionPlan.count : 0 });
    setStep("done");
  };

  const checkOk = parsed && parsed.checks.closingOk && parsed.checks.declaredOk !== false && parsed.checks.rowsOk !== false && parsed.checks.skipped === 0;
  const blocked = !!parsed && !checkOk && !forceImport; // se i totali non quadrano l'importazione resta bloccata finché non la si forza
  const diagnostics = () => buildDiagnostics(lastPages || [], parsed
    ? `${parsed.bank}: ${parsed.transactions.length} movimenti letti, totali ${checkOk ? "OK" : "NON quadrano"} (saldo ${parsed.checks.closingOk ? "ok" : "no"}, dichiarati ${parsed.checks.declaredOk === false ? "no" : "ok"}, righe scartate ${parsed.checks.skipped})`
    : (error || "errore di lettura"));
  const copyDiagnostics = async () => {
    const text = diagnostics();
    try { await navigator.clipboard.writeText(text); setDiagCopied("copied"); } catch { setDiagCopied(text); }
  };
  // categorie selezionabili: quelle esistenti + le nuove suggerite dall'estratto
  const categoryOptions = (type) => {
    const names = categories[type].map((c) => c.name);
    rows.forEach((r) => { if (r.tx.type === type && r.category && !names.some((n) => n.toLowerCase() === r.category.toLowerCase())) names.push(r.category); });
    return names;
  };

  return (
    <ModalShell title="Importa estratto conto" onClose={onClose} wide={step === "review"}>
      <div style={styles.modalBody}>
        {step === "choose" && (
          <>
            <label
              style={{ ...styles.dropZone, borderColor: dragOver ? "var(--accent)" : "var(--border-3)" }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files?.[0]); }}
            >
              <FileText size={28} />
              <span style={{ color: "var(--text)", fontWeight: 600 }}>{busy ? "Lettura in corso…" : "Trascina qui il PDF o clicca per sceglierlo"}</span>
              <span>Estratti conto in PDF: Banco BPM e Trade Republic</span>
              <input type="file" accept="application/pdf,.pdf" style={{ display: "none" }} disabled={busy} onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
            {error && <div style={{ ...styles.fieldError, marginTop: 12 }}>{error}</div>}
            {error && lastPages && (
              <div style={{ marginTop: 10 }}>
                <button style={{ ...styles.linkBtn, marginTop: 0 }} onClick={copyDiagnostics}>Copia diagnostica anonima</button>
                {diagCopied === "copied" && <span style={{ ...styles.hint, marginLeft: 8 }}>Copiata negli appunti</span>}
                <div style={styles.hint}>Descrive solo la struttura del file (cifre e lettere sono mascherate): puoi inviarla per far adattare la lettura a questo formato.</div>
                {diagCopied && diagCopied !== "copied" && <textarea readOnly value={diagCopied} rows={6} style={{ ...styles.input, marginTop: 8, fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }} onFocus={(e) => e.target.select()} />}
              </div>
            )}
            <p style={{ ...styles.helpText, marginTop: 14 }}>
              Il file viene letto nel tuo browser: prima di salvare vedrai un'anteprima. Puoi caricare più estratti nel corso dell'anno:
              i movimenti già importati vengono riconosciuti e saltati, quindi ricaricare per errore lo stesso file non crea doppioni.
            </p>
          </>
        )}

        {step === "review" && parsed && (
          <>
            <div style={{ ...styles.helpText, marginBottom: 10 }}>
              <strong style={{ color: "var(--text)" }}>{fileName}</strong> · {parsed.bank} · conto {parsed.accountLabel} · dal {fmtISO(parsed.opening.date)} al {fmtISO(parsed.closing.date)}
            </div>
            <div style={styles.importSummary}>
              <div style={styles.importStat}>
                <div style={styles.invLabel}>Saldo iniziale → finale</div>
                <div style={styles.invValue}>{fmtFull(parsed.opening.amount)} → {fmtFull(parsed.closing.amount)}</div>
              </div>
              <div style={styles.importStat}>
                <div style={styles.invLabel}>Entrate / Uscite</div>
                <div style={styles.invValue}>
                  <span style={{ color: "var(--pos)" }}>+{fmtFull(parsed.totals.entrate)}</span> / <span style={{ color: "var(--neg)" }}>−{fmtFull(parsed.totals.uscite)}</span>
                </div>
              </div>
              <div style={styles.importStat}>
                <div style={styles.invLabel}>Controllo dei totali</div>
                <div style={{ ...styles.invValue, color: checkOk ? "var(--pos)" : "var(--accent)" }}>
                  {checkOk ? "✓ Quadrano con l'estratto" : "⚠ Non quadrano: controlla le righe"}
                </div>
              </div>
              <div style={styles.importStat}>
                <div style={styles.invLabel}>Movimenti</div>
                <div style={styles.invValue}>
                  {counts.fresh} nuovi{counts.imported > 0 && ` · ${counts.imported} già importati`}{counts.maybe > 0 && ` · ${counts.maybe} da verificare`}
                </div>
              </div>
            </div>

            <Field label="Conto di destinazione">
              <select value={targetId} onChange={(e) => setTargetId(e.target.value)} style={styles.input}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.importKey === alignment?.importKey ? " (collegato a questo conto bancario)" : ""}</option>)}
                <option value="__new__">+ Crea nuovo conto «{parsed.bank} {parsed.accountLabel}»</option>
              </select>
            </Field>
            {alignment && alignment.changed && (
              <label style={{ ...styles.checkRow, marginBottom: 12, alignItems: "flex-start" }}>
                <input type="checkbox" className="fx-check" checked={useOpening} onChange={(e) => setUseOpening(e.target.checked)} style={{ marginTop: 1 }} />
                <span>
                  Allinea il conto al saldo finale dell'estratto ({fmtFull(alignment.latest.amount)} al {fmtISO(alignment.latest.date)}):
                  il saldo iniziale del conto viene impostato a <strong style={{ color: "var(--text)" }}>{fmtFull(alignment.value)}</strong>,
                  così il saldo corrente coincide con quello reale anche se mancano dei movimenti.
                </span>
              </label>
            )}
            {positionPlan && (
              <label style={{ ...styles.checkRow, marginBottom: 12, alignItems: "flex-start" }}>
                <input type="checkbox" className="fx-check" checked={usePositions} onChange={(e) => setUsePositions(e.target.checked)} style={{ marginTop: 1 }} />
                <span>
                  Crea/aggiorna le posizioni di investimento dagli acquisti e dalle vendite di titoli: {positionPlan.count} posizion{positionPlan.count === 1 ? "e" : "i"} da questo conto
                  (valore {positionPlan.delta >= 0 ? "+" : "−"}{fmtFull(Math.abs(positionPlan.delta))} stimato al prezzo di acquisto), così i titoli che possiedi contano nel patrimonio e non solo quando li vendi.
                  Il valore attuale si aggiorna a mano da Investimenti.
                </span>
              </label>
            )}
            {(!alignment || !alignment.changed) && !positionPlan && counts.imported === rows.length && (
              <div style={{ ...styles.fieldError, color: "var(--accent)", marginBottom: 12 }}>Questo estratto è già stato importato per intero e il saldo del conto è già allineato: non c'è nulla da aggiungere.</div>
            )}

            {!checkOk && (
              <div style={styles.importWarn}>
                <strong>I totali non quadrano: il file potrebbe non essere stato letto correttamente.</strong>
                <ul style={{ margin: "6px 0 8px", paddingLeft: 18 }}>
                  <li>Movimenti letti: {parsed.transactions.length}{parsed.checks.skipped > 0 ? ` · righe scartate: ${parsed.checks.skipped}` : ""}</li>
                  {parsed.declared.entrate != null && <li>Entrate lette {fmtFull(parsed.totals.entrate)} · dichiarate dalla banca {fmtFull(parsed.declared.entrate)}</li>}
                  {parsed.declared.uscite != null && <li>Uscite lette {fmtFull(parsed.totals.uscite)} · dichiarate dalla banca {fmtFull(parsed.declared.uscite)}</li>}
                  <li>Saldo iniziale + movimenti = {fmtFull(parsed.opening.amount + parsed.totals.entrate - parsed.totals.uscite)} · saldo finale dell'estratto {fmtFull(parsed.closing.amount)}</li>
                </ul>
                <label style={{ ...styles.checkRow, marginBottom: 6 }}>
                  <input type="checkbox" className="fx-check" checked={forceImport} onChange={(e) => setForceImport(e.target.checked)} />
                  <span>Importa comunque (so che i dati potrebbero essere sbagliati)</span>
                </label>
                <button style={{ ...styles.linkBtn, marginTop: 0 }} onClick={copyDiagnostics}>Copia diagnostica anonima</button>
                {diagCopied === "copied" && <span style={{ ...styles.hint, marginLeft: 8 }}>Copiata negli appunti</span>}
                {diagCopied && diagCopied !== "copied" && <textarea readOnly value={diagCopied} rows={6} style={{ ...styles.input, marginTop: 8, fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }} onFocus={(e) => e.target.select()} />}
              </div>
            )}

            <div style={styles.importTableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={{ ...styles.th, width: 28, paddingTop: 10, position: "sticky", top: 0, background: "var(--surface)" }}>
                      <Checkbox checked={allChecked} indeterminate={someChecked} onChange={toggleAll} title="Seleziona tutti" />
                    </th>
                    {["Data", "Descrizione", "Categoria", "Importo"].map((h, i) => (
                      <th key={h} style={{ ...styles.th, paddingTop: 10, position: "sticky", top: 0, background: "var(--surface)", textAlign: i === 3 ? "right" : "left" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.tx.key} style={{ opacity: r.status === "imported" ? 0.45 : 1 }}>
                      <td style={styles.td}>
                        <Checkbox checked={r.checked} onChange={() => setRow(i, { checked: !r.checked })} />
                      </td>
                      <td style={{ ...styles.td, whiteSpace: "nowrap" }}>{formatDate(r.tx.date)}</td>
                      <td style={{ ...styles.td, maxWidth: 320 }}>
                        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.tx.raw}>{r.tx.description}</div>
                        {r.status === "imported" && <span style={styles.statusChip("var(--text-muted)")}>già importato</span>}
                        {r.status === "maybe" && <span style={styles.statusChip("var(--accent)")} title="Esiste già un movimento inserito a mano con stesso importo e data simile">possibile duplicato</span>}
                        {r.status !== "imported" && r.tx.kind === "giroconto" && <span style={styles.statusChip("var(--secondary)")} title="Trasferimento tra conti tuoi: se importi entrambi i conti, le due metà si compensano">giroconto</span>}
                        {r.status !== "imported" && r.tx.kind === "investimento" && <span style={styles.statusChip("var(--chart-4)")} title="Acquisto/vendita di titoli: riduce la liquidità, il valore dei titoli va registrato in Investimenti">investimento</span>}
                      </td>
                      <td style={styles.td}>
                        <select
                          value={r.category}
                          disabled={r.status === "imported"}
                          onChange={(e) => setRow(i, { category: e.target.value, subcategory: null })}
                          style={{ ...styles.input, padding: "5px 8px", fontSize: 12, width: 130 }}
                        >
                          {categoryOptions(r.tx.type).map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                        {r.subcategory && r.status !== "imported" && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>› {r.subcategory} <span title="Da una tua regola automatica">(regola)</span></div>}
                      </td>
                      <td style={{ ...styles.td, textAlign: "right", whiteSpace: "nowrap", color: r.tx.type === "entrata" ? "var(--pos)" : "var(--neg)", fontFamily: "'JetBrains Mono', monospace" }}>
                        {r.tx.type === "entrata" ? "+" : "−"}{fmtFull(r.tx.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p style={{ ...styles.helpText, marginTop: 10 }}>
              Ho assegnato le categorie in automatico: puoi cambiarle riga per riga. I giroconti tra i tuoi conti e gli acquisti di titoli sono inclusi: se importi tutti i tuoi conti le due metà dei giroconti si compensano; togli la spunta alle righe che non vuoi.
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 4 }}>
              <button style={{ ...styles.secondaryBtn, flexShrink: 0 }} onClick={() => { setStep("choose"); setParsed(null); setRows([]); }}>Scegli un altro file</button>
              <button
                style={{ ...styles.primaryBtnFull, flex: 1, marginTop: 0, minWidth: 200, opacity: blocked || (counts.selected === 0 && !alignAction && !positionAction) ? 0.5 : 1 }}
                disabled={blocked || (counts.selected === 0 && !alignAction && !positionAction)}
                onClick={doImport}
              >
                {blocked ? "Importazione bloccata: i totali non quadrano" : counts.selected > 0 ? `Importa ${counts.selected} moviment${counts.selected === 1 ? "o" : "i"}` : alignAction || positionAction ? "Applica solo saldo e posizioni" : "Niente da importare"}
              </button>
            </div>
          </>
        )}

        {step === "done" && result && (
          <>
            <div style={{ textAlign: "center", padding: "10px 0 18px" }}>
              <div style={{ color: "var(--pos)", marginBottom: 8 }}><CheckCircle2 size={34} /></div>
              <div style={{ ...styles.h3, marginBottom: 6 }}>Importazione completata</div>
              <div style={styles.helpText}>
                {result.added} moviment{result.added === 1 ? "o aggiunto" : "i aggiunti"}
                {result.skipped > 0 && ` · ${result.skipped} già presenti, saltati`}
                {result.created && " · conto creato"}{result.positions > 0 && ` · ${result.positions} posizion${result.positions === 1 ? "e" : "i"} di investimento aggiornat${result.positions === 1 ? "a" : "e"}`}{result.opening && " · saldo del conto allineato"}
              </div>
            </div>
            <button style={styles.primaryBtnFull} onClick={onClose}>Chiudi</button>
          </>
        )}
      </div>
    </ModalShell>
  );
}

function BulkCategoryModal({ txs, categories, onApply, onClose }) {
  const editable = txs.filter((t) => !(t.transferId || t.isTransfer)); // i giroconti hanno la categoria bloccata
  const skipped = txs.length - editable.length;
  const types = ["entrata", "uscita"].filter((ty) => editable.some((t) => t.type === ty));
  const [chosen, setChosen] = useState({});
  const ready = editable.length > 0 && types.every((ty) => chosen[ty]);
  const label = { entrata: "entrate", uscita: "uscite" };
  return (
    <ModalShell title="Cambia categoria" onClose={onClose}>
      <div style={styles.modalBody}>
        <p style={{ ...styles.helpText, marginTop: 0 }}>
          {editable.length} moviment{editable.length === 1 ? "o selezionato" : "i selezionati"}. Cambia solo la categoria: la sottocategoria resta solo se esiste con lo stesso nome nella nuova categoria, altrimenti viene tolta.
        </p>
        {editable.length === 0 && <div style={{ ...styles.fieldError, marginBottom: 12 }}>I giroconti non si possono ricategorizzare.</div>}
        {types.map((ty) => {
          const group = editable.filter((t) => t.type === ty);
          const cats = [...new Set(group.map((t) => t.category))];
          return (
            <Field key={ty} label={`Nuova categoria per ${group.length} ${group.length === 1 ? (ty === "entrata" ? "entrata" : "uscita") : label[ty]}`}>
              <select value={chosen[ty] || ""} onChange={(e) => setChosen((c) => ({ ...c, [ty]: e.target.value }))} style={styles.input}>
                <option value="">Scegli una categoria…</option>
                {(categories[ty] || []).filter((c) => !c.transfer).map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
              <div style={styles.hint}>Attuale: {cats.length === 1 ? cats[0] : `${cats.length} categorie diverse`}</div>
            </Field>
          );
        })}
        {skipped > 0 && <div style={{ ...styles.hint, marginBottom: 12 }}>{skipped} giroconto{skipped === 1 ? "" : "i"} selezionat{skipped === 1 ? "o" : "i"} verr{skipped === 1 ? "à" : "anno"} ignorat{skipped === 1 ? "o" : "i"}.</div>}
        <button style={{ ...styles.primaryBtnFull, opacity: ready ? 1 : 0.5 }} disabled={!ready} onClick={() => onApply(editable.map((t) => t.id), chosen)}>
          Applica a {editable.length} moviment{editable.length === 1 ? "o" : "i"}
        </button>
      </div>
    </ModalShell>
  );
}

function GirocontoModal({ accounts, onClose, onSave }) {
  const def = defaultAccountOf(accounts);
  const [amount, setAmount] = useState("");
  const [fromId, setFromId] = useState(def?.id || "");
  const [toId, setToId] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(todayISO());

  const others = accounts.filter((a) => a.id !== fromId);
  useEffect(() => {
    if (!others.some((a) => a.id === toId)) setToId(others[0]?.id || "");
  }, [fromId]); // eslint-disable-line
  const blocked = accounts.length < 2;

  const submit = () => {
    if (blocked || !amount || Number(amount) <= 0 || !fromId || !toId || fromId === toId || !date) return;
    onSave({ amount: Number(amount), fromId, toId, description: description.trim(), date });
  };

  return (
    <ModalShell title="Giroconto" onClose={onClose}>
      <div style={styles.modalBody}>
        {blocked ? (
          <div style={{ ...styles.fieldError, marginBottom: 12 }}>Servono almeno due conti: creane un altro in Patrimonio › Gestione Conti.</div>
        ) : null}
        <Field label="Importo (€)">
          <MoneyInput autoFocus placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} style={styles.input} />
        </Field>
        <Field label="Conto di origine">
          <select value={fromId} onChange={(e) => setFromId(e.target.value)} style={styles.input}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.isDefault ? " (predefinito)" : ""} · {fmtFull(a.balance)}</option>)}
          </select>
        </Field>
        <Field label="Conto di destinazione">
          <select value={toId} onChange={(e) => setToId(e.target.value)} disabled={blocked} style={styles.input}>
            {others.map((a) => <option key={a.id} value={a.id}>{a.name} · {fmtFull(a.balance)}</option>)}
          </select>
        </Field>
        <Field label="Descrizione (opzionale)">
          <input type="text" placeholder="es. Ricarica carta" value={description} onChange={(e) => setDescription(e.target.value)} style={styles.input} />
        </Field>
        <Field label="Data dell'operazione">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={styles.input} />
        </Field>
        <Field label="Stato">
          <div style={styles.autoStatusBox}>
            <span style={styles.statusDot(date <= todayISO())} />
            {date <= todayISO() ? "Effettivo (data odierna o passata)" : "Previsto (data futura)"}
          </div>
          <div style={styles.hint}>
            Vengono creati due movimenti: un'uscita sul conto di origine e un'entrata sul conto di destinazione. La data di accredito, di default uguale a quella dell'operazione, si può modificare dal movimento in entrata.
          </div>
        </Field>
        <button style={{ ...styles.primaryBtnFull, opacity: blocked ? 0.5 : 1 }} disabled={blocked} onClick={submit}>Crea giroconto</button>
      </div>
    </ModalShell>
  );
}

function SettingsModal({ theme, accent, onChange, onClose, userEmail, onExportCsv, onExportBackup, onRestoreFile }) {
  const current = THEMES.some((t) => t.id === theme) ? theme : "dark";
  const fileRef = useRef(null);
  // cambio password
  const [pwCur, setPwCur] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwNew2, setPwNew2] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState(null); // { ok, text }
  const changePassword = async () => {
    setPwMsg(null);
    if (pwNew.length < 8) return setPwMsg({ ok: false, text: "La nuova password deve avere almeno 8 caratteri." });
    if (pwNew !== pwNew2) return setPwMsg({ ok: false, text: "Le due password nuove non coincidono." });
    setPwBusy(true);
    try {
      const res = await fetch("/api/auth/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current: pwCur, next: pwNew }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setPwMsg({ ok: false, text: data.error || "Impossibile cambiare la password." });
      setPwCur(""); setPwNew(""); setPwNew2("");
      setPwMsg({ ok: true, text: data.closedSessions > 0 ? `Password aggiornata. ${data.closedSessions} altre sessioni sono state chiuse.` : "Password aggiornata." });
    } catch {
      setPwMsg({ ok: false, text: "Errore di rete: riprova." });
    } finally {
      setPwBusy(false);
    }
  };
  const swatch = (a) => (current === "light" ? a.light : a.dark);
  // mini anteprima del tema
  const preview = (id) => {
    const light = id === "light";
    return (
      <div style={{ width: "100%", height: 54, borderRadius: 8, overflow: "hidden", border: `1px solid ${light ? "#DDD7C8" : "#26333F"}`, background: light ? "#F5F2EA" : "#0F1720", padding: 8, display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ height: 8, width: "55%", borderRadius: 4, background: light ? "#1F2933" : "#E8E6DF", opacity: 0.85 }} />
        <div style={{ flex: 1, borderRadius: 5, background: light ? "#FFFFFF" : "#16212C", border: `1px solid ${light ? "#DDD7C8" : "#26333F"}` }} />
      </div>
    );
  };
  return (
    <ModalShell title="Impostazioni" onClose={onClose}>
      <div style={styles.modalBody}>
        <div style={styles.settingsTitle}>Tema</div>
        <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
          {THEMES.map((t) => (
            <button key={t.id} style={styles.themeCard(current === t.id)} onClick={() => onChange({ theme: t.id })} aria-pressed={current === t.id}>
              {preview(t.id)}
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t.label}</span>
            </button>
          ))}
        </div>

        <div style={styles.settingsTitle}>Colore principale</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
          {ACCENTS.map((a) => (
            <button key={a.id} style={styles.swatchBtn(accent === a.id)} onClick={() => onChange({ accent: a.id })} title={a.label} aria-label={a.label} aria-pressed={accent === a.id}>
              <span style={{ width: 26, height: 26, borderRadius: "50%", background: swatch(a), display: "block" }} />
              <span style={{ fontSize: 11 }}>{a.label}</span>
            </button>
          ))}
        </div>
        <p style={styles.helpText}>
          Il colore principale cambia pulsanti, evidenziazioni e grafici. Entrate (verde) e uscite (rosso), insieme agli indicatori positivo/negativo e di avviso, mantengono sempre i loro colori per riconoscere subito gli importi.
        </p>
        <div style={{ marginTop: 4, marginBottom: 20 }}>
          <button style={{ ...styles.linkBtn, marginTop: 0 }} onClick={() => onChange({ theme: "dark", accent: "oro" })}>Ripristina predefiniti</button>
        </div>

        <div style={styles.settingsTitle}>Account</div>
        <div style={{ ...styles.helpText, marginBottom: 10 }}>Accesso come <strong style={{ color: "var(--text)" }}>{userEmail}</strong></div>
        <Field label="Password attuale">
          <input type="password" autoComplete="current-password" value={pwCur} onChange={(e) => setPwCur(e.target.value)} style={styles.input} />
        </Field>
        <Field label="Nuova password (almeno 8 caratteri)">
          <input type="password" autoComplete="new-password" value={pwNew} onChange={(e) => setPwNew(e.target.value)} style={styles.input} />
        </Field>
        <Field label="Ripeti la nuova password">
          <input type="password" autoComplete="new-password" value={pwNew2} onChange={(e) => setPwNew2(e.target.value)} onKeyDown={(e) => e.key === "Enter" && changePassword()} style={styles.input} />
        </Field>
        {pwMsg && <div style={{ ...(pwMsg.ok ? { fontSize: 12, color: "var(--pos)" } : styles.fieldError), marginBottom: 10 }}>{pwMsg.text}</div>}
        <button style={{ ...styles.secondaryBtn, opacity: pwBusy || !pwCur || !pwNew ? 0.5 : 1, marginBottom: 22 }} disabled={pwBusy || !pwCur || !pwNew} onClick={changePassword}>
          Cambia password
        </button>
        <p style={{ ...styles.helpText, marginTop: -14, marginBottom: 22 }}>Cambiando la password vengono chiuse tutte le altre sessioni aperte (altri browser e dispositivi).</p>

        <div style={styles.settingsTitle}>Dati</div>
        <p style={{ ...styles.helpText, marginTop: 0 }}>
          Scarica una copia dei tuoi dati o ripristinala. Il backup completo include movimenti, conti, investimenti, budget, ricorrenze, categorie, regole e impostazioni.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          <button style={styles.secondaryBtn} onClick={onExportCsv}>Esporta movimenti (CSV)</button>
          <button style={styles.secondaryBtn} onClick={onExportBackup}>Backup completo (JSON)</button>
          <button style={styles.secondaryBtn} onClick={() => fileRef.current?.click()}>Ripristina da backup…</button>
          <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onRestoreFile(f); }} />
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button style={styles.primaryBtn} onClick={onClose}>Fatto</button>
        </div>
      </div>
    </ModalShell>
  );
}

function ConfirmModal({ dlg, onClose }) {
  return (
    <ModalShell title={dlg.title} onClose={onClose}>
      <p style={{ ...styles.helpText, margin: 0 }}>{dlg.message}</p>
      {dlg.infoOnly ? (
        <button autoFocus style={{ ...styles.primaryBtnFull, marginTop: 20 }} onClick={onClose}>Ho capito</button>
      ) : (
      <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
        <button style={styles.toggleBtn(false, "var(--text-muted)")} onClick={onClose}>Annulla</button>
        <button
          autoFocus
          style={{ ...styles.primaryBtnFull, flex: 1, marginTop: 0, background: "var(--neg)", color: "#FFFFFF" }}
          onClick={() => { dlg.onConfirm(); onClose(); }}
        >
          {dlg.confirmLabel}
        </button>
      </div>
      )}
    </ModalShell>
  );
}

// Input numerico che non accetta valori negativi
function MoneyInput({ onChange, onKeyDown, ...props }) {
  return (
    <input
      {...props}
      type="number"
      min="0"
      onKeyDown={(e) => { if (e.key === "-" || e.key === "e" || e.key === "E") e.preventDefault(); onKeyDown && onKeyDown(e); }}
      onChange={(e) => {
        if (e.target.value.startsWith("-")) e.target.value = e.target.value.replace(/^-+/, "");
        onChange(e);
      }}
    />
  );
}

function TxModal({ onClose, onSave, categories, onAddCategory, editingTx, accounts }) {
  const isEdit = !!editingTx;
  const [type, setType] = useState(editingTx?.type || "uscita");
  const [amount, setAmount] = useState(editingTx ? String(editingTx.amount) : "");
  const [description, setDescription] = useState(editingTx?.description || "");
  const [date, setDate] = useState(editingTx?.date || todayISO());
  const defaultAccount = defaultAccountOf(accounts);
  const [accountId, setAccountId] = useState(
    editingTx && accounts.some((a) => a.id === editingTx.accountId) ? editingTx.accountId : defaultAccount?.id || ""
  );
  const [addingCat, setAddingCat] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [pendingSelectName, setPendingSelectName] = useState(null);

  // la categoria giroconto non si sceglie nei movimenti normali: i giroconti si creano dal pulsante "Giroconto"
  const lockedTransfer = isEdit && !!(editingTx.transferId || editingTx.isTransfer);
  const catList = (categories[type] || []).filter((c) => lockedTransfer || !c.transfer);

  const [categoryId, setCategoryId] = useState(() => {
    if (editingTx) {
      const found = catList.find((c) => c.name === editingTx.category);
      return found ? found.id : (catList[0]?.id || "");
    }
    return catList[0]?.id || "";
  });
  const [subName, setSubName] = useState(editingTx?.subcategory || "");

  // reimposta la categoria solo quando cambia davvero il tipo (in dev React esegue gli effetti due volte al mount)
  const prevTypeRef = useRef(type);
  useEffect(() => {
    if (prevTypeRef.current === type) return;
    prevTypeRef.current = type;
    const list = categories[type] || [];
    setCategoryId(list[0]?.id || "");
    setSubName("");
    setAddingCat(false);
    setNewCatName("");
  }, [type]); // eslint-disable-line

  useEffect(() => {
    if (pendingSelectName) {
      const found = catList.find((c) => c.name.toLowerCase() === pendingSelectName.toLowerCase());
      if (found) { setCategoryId(found.id); setPendingSelectName(null); }
    }
  }, [catList, pendingSelectName]);

  const selectedCat = catList.find((c) => c.id === categoryId);

  const isCreditLeg = lockedTransfer && editingTx.type === "entrata"; // metà in entrata di un giroconto: la data è quella di accredito

  const submit = () => {
    if (!amount || Number(amount) <= 0 || !accountId) return;
    const cat = catList.find((c) => c.id === categoryId) || catList[0];
    const payload = {
      type,
      amount: Number(amount),
      category: cat ? cat.name : "",
      subcategory: subName || null,
      description,
      date,
      accountId,
    };
    onSave(isEdit ? { ...editingTx, ...payload } : payload);
  };

  const saveNewCategory = () => {
    const name = newCatName.trim();
    if (!name) { setAddingCat(false); return; }
    const exists = catList.some((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!exists) {
      onAddCategory(type, name);
      setPendingSelectName(name);
    } else {
      const found = catList.find((c) => c.name.toLowerCase() === name.toLowerCase());
      setCategoryId(found.id);
    }
    setAddingCat(false);
    setNewCatName("");
  };

  return (
    <ModalShell title={isEdit ? "Modifica movimento" : "Nuovo movimento"} onClose={onClose}>
      <div style={styles.modalBody}>
        <div style={styles.toggleRow}>
          <button style={styles.toggleBtn(type === "entrata", "var(--pos)")} onClick={() => !lockedTransfer && setType("entrata")}>Entrata</button>
          <button style={styles.toggleBtn(type === "uscita", "var(--neg)")} onClick={() => !lockedTransfer && setType("uscita")}>Uscita</button>
        </div>

        <Field label="Importo (€)">
          <MoneyInput autoFocus placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} style={styles.input} />
        </Field>

        <Field label={lockedTransfer ? (type === "uscita" ? "Conto di origine" : "Conto di destinazione") : "Conto"}>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} style={styles.input}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.isDefault ? " (predefinito)" : ""}</option>)}
          </select>
        </Field>

        <Field label="Categoria">
          {addingCat ? (
            <div style={styles.catAddRow}>
              <input
                autoFocus
                type="text"
                placeholder="Nome nuova categoria"
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveNewCategory();
                  if (e.key === "Escape") setAddingCat(false);
                }}
                style={styles.input}
              />
              <button type="button" style={styles.catAddConfirm} onClick={saveNewCategory}>Aggiungi</button>
            </div>
          ) : (
            <div style={styles.catSelectRow}>
              <select value={categoryId} disabled={lockedTransfer} onChange={(e) => { setCategoryId(e.target.value); setSubName(""); }} style={styles.input}>
                {catList.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button type="button" style={styles.catPlusBtn} onClick={() => setAddingCat(true)} title="Nuova categoria">
                <Plus size={14} />
              </button>
            </div>
          )}
        </Field>

        {selectedCat && selectedCat.subcategories.length > 0 && (
          <Field label="Sottocategoria (opzionale)">
            <select value={subName} onChange={(e) => setSubName(e.target.value)} style={styles.input}>
              <option value="">Nessuna</option>
              {selectedCat.subcategories.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
            </select>
          </Field>
        )}

        {lockedTransfer && <div style={{ ...styles.hint, marginBottom: 12, marginTop: 0 }}>Questo movimento fa parte di un giroconto: la sua metà sull'altro conto si modifica separatamente.</div>}

        <Field label="Descrizione (opzionale)">
          <input type="text" placeholder="es. spesa supermercato" value={description} onChange={(e) => setDescription(e.target.value)} style={styles.input} />
        </Field>
        <Field label={isCreditLeg ? "Data di accredito" : lockedTransfer ? "Data dell'operazione" : "Data"}>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={styles.input} />
          {isCreditLeg && editingTx.opDate && editingTx.opDate !== date && <div style={styles.hint}>Operazione del {formatDate(editingTx.opDate)}</div>}
        </Field>

        <Field label="Stato">
          <div style={styles.autoStatusBox}>
            <span style={styles.statusDot(date <= todayISO())} />
            {date <= todayISO() ? "Effettivo (data odierna o passata)" : "Previsto (data futura)"}
          </div>
        </Field>

        <button style={styles.primaryBtnFull} onClick={submit}>{isEdit ? "Salva modifiche" : "Salva movimento"}</button>
      </div>
    </ModalShell>
  );
}

function InvModal({ onClose, onSave, editingInv, accounts }) {
  const isEdit = !!editingInv;
  const [name, setName] = useState(editingInv?.name || "");
  const [invType, setInvType] = useState(editingInv?.invType || INVEST_TYPES[0]);
  const [startDate, setStartDate] = useState(editingInv?.startDate || todayISO());
  const [initialCapital, setInitialCapital] = useState(
    editingInv ? String(editingInv.initialCapital ?? editingInv.invested ?? "") : ""
  );
  const [contributionAmount, setContributionAmount] = useState(editingInv?.contributionAmount ? String(editingInv.contributionAmount) : "");
  const [contributionFrequency, setContributionFrequency] = useState(editingInv?.contributionFrequency || "nessuno");
  const [contribSameDate, setContribSameDate] = useState(!editingInv?.contributionStartDate);
  const [contribStartDate, setContribStartDate] = useState(editingInv?.contributionStartDate || editingInv?.startDate || todayISO());
  const [currentValue, setCurrentValue] = useState(editingInv ? String(editingInv.currentValue) : "");
  // conto da cui prelevare: scelto solo all'inserimento, poi in sola lettura
  const [accountId, setAccountId] = useState(
    editingInv && accounts.some((a) => a.id === editingInv.accountId) ? editingInv.accountId : defaultAccountOf(accounts)?.id || ""
  );
  const [withdraw, setWithdraw] = useState(true);
  const lockedAccount = accounts.find((a) => a.id === editingInv?.accountId);

  const hasContribution = contributionFrequency !== "nessuno";
  const invalidContribDate = hasContribution && !contribSameDate && (!contribStartDate || (startDate && contribStartDate < startDate));
  const hasNegative = [initialCapital, contributionAmount, currentValue].some((v) => v !== "" && Number(v) < 0);

  const submit = () => {
    if (!name || !initialCapital || hasNegative || invalidContribDate || (!isEdit && !accountId)) return;
    const payload = {
      name,
      invType,
      startDate,
      initialCapital: Number(initialCapital),
      contributionAmount: contributionAmount ? Number(contributionAmount) : 0,
      contributionFrequency,
      accountId: isEdit ? editingInv.accountId : accountId,
      ...(isEdit ? {} : { withdraw }),
      contributionStartDate: hasContribution && !contribSameDate ? contribStartDate : null,
      currentValue: currentValue ? Number(currentValue) : Number(initialCapital),
    };
    onSave(isEdit ? { ...editingInv, ...payload } : payload);
  };

  return (
    <ModalShell title={isEdit ? "Modifica investimento" : "Nuovo investimento"} onClose={onClose}>
      <div style={styles.modalBody}>
        <Field label="Nome">
          <input autoFocus type="text" placeholder="es. MSCI World ETF" value={name} onChange={(e) => setName(e.target.value)} style={styles.input} />
        </Field>
        <Field label="Tipologia">
          <select value={invType} onChange={(e) => setInvType(e.target.value)} style={styles.input}>
            {INVEST_TYPES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Conto da cui prelevare">
          {isEdit ? (
            <div style={styles.autoStatusBox}>{lockedAccount ? lockedAccount.name : "Non specificato (posizione creata prima della gestione conti)"}</div>
          ) : (
            <>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} style={styles.input}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.isDefault ? " (predefinito)" : ""}</option>)}
              </select>
              <label style={{ ...styles.checkRow, marginTop: 8, marginBottom: 0 }}>
                <input type="checkbox" className="fx-check" checked={withdraw} onChange={(e) => setWithdraw(e.target.checked)} />
                <span>Registra il prelievo del capitale iniziale come movimento in uscita dal conto</span>
              </label>
            </>
          )}
          {isEdit && <div style={styles.hint}>Il conto si sceglie solo all'apertura della posizione.</div>}
        </Field>
        <Field label="Data di inizio posizione">
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={styles.input} />
        </Field>
        <Field label="Capitale iniziale (€)">
          <MoneyInput placeholder="0" value={initialCapital} onChange={(e) => setInitialCapital(e.target.value)} style={styles.input} />
        </Field>
        <Field label="Contributo aggiuntivo (€, opzionale)">
          <MoneyInput placeholder="0" value={contributionAmount} onChange={(e) => setContributionAmount(e.target.value)} style={styles.input} />
        </Field>
        <Field label="Frequenza contributo">
          <select value={contributionFrequency} onChange={(e) => setContributionFrequency(e.target.value)} style={styles.input}>
            {CONTRIB_FREQ.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </Field>
        <Field label="Inizio contributo">
          <select
            value={contribSameDate ? "same" : "custom"}
            onChange={(e) => setContribSameDate(e.target.value === "same")}
            disabled={!hasContribution}
            style={{ ...styles.input, opacity: hasContribution ? 1 : 0.5 }}
          >
            <option value="same">Stessa data dell'apertura</option>
            <option value="custom">Scegli una data</option>
          </select>
          {!contribSameDate && (
            <input
              type="date"
              min={startDate || undefined}
              value={contribStartDate}
              onChange={(e) => setContribStartDate(e.target.value)}
              disabled={!hasContribution}
              style={{ ...styles.input, marginTop: 8, opacity: hasContribution ? 1 : 0.5 }}
            />
          )}
          {!hasContribution && <div style={styles.hint}>Scegli una frequenza del contributo per attivarlo.</div>}
          {invalidContribDate && <div style={styles.fieldError}>L'inizio del contributo non può precedere la data di apertura.</div>}
        </Field>
        <Field label="Valore attuale (€, opzionale)">
          <MoneyInput placeholder="uguale al capitale se vuoto" value={currentValue} onChange={(e) => setCurrentValue(e.target.value)} style={styles.input} />
        </Field>
        <button style={styles.primaryBtnFull} onClick={submit}>{isEdit ? "Salva modifiche" : "Salva investimento"}</button>
      </div>
    </ModalShell>
  );
}

function BudgetModal({ onClose, onSave, categories, budgets, editingBudget }) {
  const isEdit = !!editingBudget;
  const uscite = (categories.uscita || []).filter((c) => !c.transfer && !NON_FLOW_CATS.includes(c.name));
  const options = [BUDGET_ALL, ...uscite.map((c) => c.name)];
  const [category, setCategory] = useState(editingBudget?.category || options[0] || "");
  const [subcategory, setSubcategory] = useState(editingBudget?.subcategory || "");
  const [limit, setLimit] = useState(editingBudget ? String(editingBudget.limit) : "");
  const [warnAt, setWarnAt] = useState(String(editingBudget?.warnAt ?? 80));
  const [alertAt, setAlertAt] = useState(String(editingBudget?.alertAt ?? 100));

  const subs = category === BUDGET_ALL ? [] : (uscite.find((c) => c.name === category)?.subcategories || []);
  const sub = subs.some((x) => x.name === subcategory) || (isEdit && subcategory && category === editingBudget.category) ? subcategory : "";
  const duplicate = budgets.some((b) => b.id !== editingBudget?.id && b.category === category && (b.subcategory || "") === sub);

  const w = Number(warnAt);
  const a = Number(alertAt);
  const invalidThresholds = !(w > 0) || !(a > 0) || w >= a;

  const submit = () => {
    if (!category || !(Number(limit) > 0) || invalidThresholds || duplicate) return;
    const payload = { category, subcategory: sub || null, limit: Number(limit), warnAt: w, alertAt: a };
    onSave(isEdit ? { ...editingBudget, ...payload } : payload);
  };

  return (
    <ModalShell title={isEdit ? "Modifica budget" : "Nuovo budget"} onClose={onClose}>
      <div style={styles.modalBody}>
        <Field label="Categoria di spesa">
          <select value={category} onChange={(e) => { setCategory(e.target.value); setSubcategory(""); }} style={styles.input}>
            {(isEdit && !options.includes(category) ? [category, ...options] : options).map((c) => (
              <option key={c} value={c}>{c === BUDGET_ALL ? "Tutte le uscite" : c}</option>
            ))}
          </select>
        </Field>
        {subs.length > 0 && (
          <Field label="Sottocategoria (opzionale)">
            <select value={sub} onChange={(e) => setSubcategory(e.target.value)} style={styles.input}>
              <option value="">Tutta la categoria</option>
              {subs.map((x) => <option key={x.id} value={x.name}>{x.name}</option>)}
            </select>
          </Field>
        )}
        {duplicate && <div style={{ ...styles.fieldError, marginBottom: 12 }}>Esiste già un budget per {sub ? `"${category} › ${sub}"` : category === BUDGET_ALL ? "tutte le uscite" : `"${category}"`}: modificalo dall'elenco.</div>}
        <Field label="Limite mensile (€)">
          <MoneyInput autoFocus placeholder="0" value={limit} onChange={(e) => setLimit(e.target.value)} style={styles.input} />
        </Field>
        <div style={styles.filterGrid}>
          <Field label="Avviso a (%)">
            <MoneyInput value={warnAt} onChange={(e) => setWarnAt(e.target.value)} style={styles.input} />
          </Field>
          <Field label="Soglia critica a (%)">
            <MoneyInput value={alertAt} onChange={(e) => setAlertAt(e.target.value)} style={styles.input} />
          </Field>
        </div>
        {invalidThresholds && <div style={{ ...styles.fieldError, marginBottom: 12 }}>L'avviso deve essere maggiore di 0 e inferiore alla soglia critica.</div>}
        <p style={styles.helpText}>Con una sottocategoria il budget conta solo le spese di quella sottocategoria. Verde sotto l'avviso, giallo tra avviso e soglia critica, rosso oltre. Con soglia critica al 100% il rosso scatta quando il budget è esaurito.</p>
        <button style={{ ...styles.primaryBtnFull, opacity: duplicate ? 0.5 : 1 }} disabled={duplicate} onClick={submit}>{isEdit ? "Salva modifiche" : "Salva budget"}</button>
      </div>
    </ModalShell>
  );
}

function RecurringListModal({ recurring, accounts, recurIn, recurOut, onClose, onAdd, onEdit, onRemove, onRegenerate, transactions }) {
  const accountName = (id) => accounts.find((a) => a.id === id)?.name;
  return (
    <ModalShell title="Movimenti ricorrenti" onClose={onClose} wide>
      <div style={styles.modalBody}>
        <p style={{ ...styles.helpText, marginTop: 0 }}>
          Stipendio, affitto, abbonamenti: inseriscili una volta sola. L'app crea i movimenti dei prossimi 12 mesi come previsti, che diventano effettivi alla data. Eliminare o modificare una singola occorrenza nella tabella non tocca le altre.
        </p>
        {recurring.length === 0 ? (
          <EmptyState text="Nessun movimento ricorrente." />
        ) : (
          <div style={styles.balanceGrid}>
            {recurring.map((r) => {
              const next = recurNextDate(r);
              const today = todayISO();
              const futureCount = transactions.filter((t) => t.recurringId === r.id && t.date > today).length;
              const skippedFuture = (r.skipDates || []).filter((d) => d >= today).length;
              const ended = !!r.endDate && r.endDate < today;
              return (
                <div key={r.id} style={styles.balanceCard}>
                  <div style={styles.balanceCardTop}>
                    <div>
                      <div style={styles.invName}>{r.description || r.category}</div>
                      <span style={styles.tag}>{r.category}{r.subcategory ? ` › ${r.subcategory}` : ""}</span>
                    </div>
                    <div style={{ display: "flex", gap: 2 }}>
                      <button style={styles.iconBtn} onClick={() => onEdit(r)}><Pencil size={14} /></button>
                      <button style={styles.iconBtn} onClick={() => onRemove(r.id)}><Trash2 size={14} /></button>
                    </div>
                  </div>
                  <div style={{ ...styles.balanceValue, color: r.type === "entrata" ? "var(--pos)" : "var(--neg)" }}>
                    {r.type === "entrata" ? "+" : "−"}{fmtFull(r.amount)}
                  </div>
                  <div style={styles.invMeta}>
                    {(RECUR_FREQ.find((f) => f.id === r.frequency) || {}).label}
                    {" · "}
                    {next ? `prossima ${formatDate(next)}` : "terminata"}
                    {r.endDate ? ` · fino al ${formatDate(r.endDate)}` : ""}
                    {accountName(r.accountId) ? ` · ${accountName(r.accountId)}` : ""}
                  </div>
                  {!ended && futureCount === 0 && skippedFuture > 0 && (
                    <div style={{ ...styles.fieldError, marginTop: 8, color: "var(--warn)" }}>
                      Nessun movimento futuro: {skippedFuture} date sono state eliminate.
                    </div>
                  )}
                  {skippedFuture > 0 && (
                    <button style={{ ...styles.linkBtn, marginTop: 8 }} onClick={() => onRegenerate(r.id)}>Rigenera movimenti futuri</button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {recurring.length > 0 && (
          <div style={styles.balanceTotalRow}>
            <span>Ricorrenti al mese (stima)</span>
            <span style={styles.balanceTotalValue}>+{fmt(recurIn)} · −{fmt(recurOut)}</span>
          </div>
        )}
        <button style={{ ...styles.primaryBtn, marginTop: 12 }} onClick={onAdd}>
          <Plus size={15} /> Aggiungi ricorrenza
        </button>
      </div>
    </ModalShell>
  );
}

function RecurringModal({ onClose, onSave, categories, editingRule, accounts }) {
  const isEdit = !!editingRule;
  const [type, setType] = useState(editingRule?.type || "uscita");
  const [amount, setAmount] = useState(editingRule ? String(editingRule.amount) : "");
  const [description, setDescription] = useState(editingRule?.description || "");
  const [frequency, setFrequency] = useState(editingRule?.frequency || "mensile");
  const [startDate, setStartDate] = useState(editingRule?.startDate || todayISO());
  const [endDate, setEndDate] = useState(editingRule?.endDate || "");
  const [includePast, setIncludePast] = useState(!!editingRule?.includePast);
  const [categoryId, setCategoryId] = useState(() => {
    const list = categories[editingRule?.type || "uscita"] || [];
    const found = editingRule ? list.find((c) => c.name === editingRule.category) : null;
    return found ? found.id : (list[0]?.id || "");
  });
  const [subName, setSubName] = useState(editingRule?.subcategory || "");
  const [accountId, setAccountId] = useState(
    editingRule && accounts.some((a) => a.id === editingRule.accountId) ? editingRule.accountId : defaultAccountOf(accounts)?.id || ""
  );

  const catList = (categories[type] || []).filter((c) => !c.transfer);
  const selectedCat = catList.find((c) => c.id === categoryId);

  const prevTypeRef = useRef(type);
  useEffect(() => {
    if (prevTypeRef.current === type) return;
    prevTypeRef.current = type;
    setCategoryId((categories[type] || []).filter((c) => !c.transfer)[0]?.id || "");
    setSubName("");
  }, [type]); // eslint-disable-line

  const invalidEnd = endDate && endDate < startDate;

  const submit = () => {
    if (!amount || Number(amount) <= 0 || !startDate || invalidEnd || !accountId) return;
    const cat = selectedCat || catList[0];
    const payload = {
      type,
      amount: Number(amount),
      category: cat ? cat.name : "",
      subcategory: subName || null,
      description,
      frequency,
      accountId,
      startDate,
      endDate: endDate || null,
      includePast,
    };
    onSave(isEdit ? { ...editingRule, ...payload } : payload);
  };

  return (
    <ModalShell title={isEdit ? "Modifica ricorrenza" : "Nuova ricorrenza"} onClose={onClose}>
      <div style={styles.modalBody}>
        <div style={styles.toggleRow}>
          <button style={styles.toggleBtn(type === "entrata", "var(--pos)")} onClick={() => setType("entrata")}>Entrata</button>
          <button style={styles.toggleBtn(type === "uscita", "var(--neg)")} onClick={() => setType("uscita")}>Uscita</button>
        </div>
        <Field label="Importo (€)">
          <MoneyInput autoFocus placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} style={styles.input} />
        </Field>
        <Field label="Conto">
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} style={styles.input}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.isDefault ? " (predefinito)" : ""}</option>)}
          </select>
        </Field>
        <Field label="Descrizione">
          <input type="text" placeholder="es. Affitto, Stipendio, Netflix" value={description} onChange={(e) => setDescription(e.target.value)} style={styles.input} />
        </Field>
        <Field label="Categoria">
          <select value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setSubName(""); }} style={styles.input}>
            {catList.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        {selectedCat && selectedCat.subcategories.length > 0 && (
          <Field label="Sottocategoria (opzionale)">
            <select value={subName} onChange={(e) => setSubName(e.target.value)} style={styles.input}>
              <option value="">Nessuna</option>
              {selectedCat.subcategories.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Frequenza">
          <select value={frequency} onChange={(e) => setFrequency(e.target.value)} style={styles.input}>
            {RECUR_FREQ.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </Field>
        <Field label="Prima occorrenza">
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={styles.input} />
        </Field>
        <Field label="Fine (opzionale)">
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={styles.input} />
          {invalidEnd && <div style={styles.fieldError}>La data di fine è precedente alla prima occorrenza.</div>}
        </Field>
        {startDate < todayISO() && (
          <label style={styles.checkRow}>
            <input type="checkbox" className="fx-check" checked={includePast} onChange={(e) => setIncludePast(e.target.checked)} />
            <span>Crea anche le occorrenze passate (come movimenti effettivi)</span>
          </label>
        )}
        <button style={styles.primaryBtnFull} onClick={submit}>{isEdit ? "Salva modifiche" : "Salva ricorrenza"}</button>
      </div>
    </ModalShell>
  );
}

function AccountModal({ onClose, onSave, editingAccount }) {
  const isEdit = !!editingAccount;
  // i campi calcolati (saldo corrente, numero movimenti) non vanno salvati
  const { balance: _b, txCount: _c, ...core } = editingAccount || {}; // eslint-disable-line no-unused-vars
  const [name, setName] = useState(editingAccount?.name || "");
  const [type, setType] = useState(editingAccount?.type || BALANCE_TYPES[0]);
  const [initialBalance, setInitialBalance] = useState(editingAccount ? String(editingAccount.initialBalance) : "");
  const [isDefault, setIsDefault] = useState(!!editingAccount?.isDefault);

  const submit = () => {
    if (!name.trim() || initialBalance === "" || isNaN(Number(initialBalance))) return;
    const payload = { name: name.trim(), type, initialBalance: Number(initialBalance), isDefault };
    onSave(isEdit ? { ...core, ...payload } : payload);
  };

  return (
    <ModalShell title={isEdit ? "Modifica conto" : "Nuovo conto"} onClose={onClose}>
      <div style={styles.modalBody}>
        <Field label="Nome">
          <input autoFocus type="text" placeholder="es. Conto corrente Intesa" value={name} onChange={(e) => setName(e.target.value)} style={styles.input} />
        </Field>
        <Field label="Tipo">
          <select value={type} onChange={(e) => setType(e.target.value)} style={styles.input}>
            {BALANCE_TYPES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Saldo iniziale (€)">
          <input type="number" placeholder="0" value={initialBalance} onChange={(e) => setInitialBalance(e.target.value)} style={styles.input} />
          <div style={styles.hint}>È il saldo del conto all'inizio del monitoraggio, prima dei movimenti registrati nell'app. Può essere negativo (conto scoperto).</div>
        </Field>
        <label style={{ ...styles.checkRow, opacity: editingAccount?.isDefault ? 0.7 : 1 }}>
          <input type="checkbox" className="fx-check" checked={isDefault} disabled={!!editingAccount?.isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          <span>
            Conto predefinito per i nuovi movimenti
            {editingAccount?.isDefault && " (per cambiarlo, imposta un altro conto come predefinito)"}
          </span>
        </label>
        <button style={styles.primaryBtnFull} onClick={submit}>{isEdit ? "Salva modifiche" : "Aggiungi conto"}</button>
      </div>
    </ModalShell>
  );
}

function CloseInvestmentModal({ inv, onClose, onConfirm, accounts }) {
  const investedTotal = computeInvestedTotal(inv);
  const grossGain = Number(inv.currentValue || 0) - investedTotal;
  const grossGainPct = investedTotal > 0 ? (grossGain / investedTotal) * 100 : 0;
  const [closeDate, setCloseDate] = useState(todayISO());
  const [fees, setFees] = useState("");

  const feesNum = fees ? Math.max(0, Number(fees)) : 0;
  const netAmount = Number(inv.currentValue || 0) - feesNum;
  const netGain = netAmount - investedTotal;
  const netGainPct = investedTotal > 0 ? (netGain / investedTotal) * 100 : 0;

  const submit = () => {
    onConfirm({ closeDate, fees: feesNum, netAmount });
  };

  return (
    <ModalShell title={`Chiudi posizione · ${inv.name}`} onClose={onClose}>
      <div style={styles.modalBody}>
        <div style={styles.closeBox}>
          <SummaryRow label="Tipologia" value={inv.invType} />
          {inv.startDate && <SummaryRow label="Data di inizio" value={formatDate(inv.startDate)} />}
          <SummaryRow label="Conto" value={(accounts.find((a) => a.id === inv.accountId) || defaultAccountOf(accounts) || {}).name || "—"} />
          <SummaryRow label="Capitale versato" value={fmtFull(investedTotal)} />
          <SummaryRow label="Valore attuale" value={fmtFull(inv.currentValue)} />
          <SummaryRow
            label="Guadagno/perdita lordo"
            value={`${grossGain >= 0 ? "+" : ""}${fmtFull(grossGain)} (${grossGainPct >= 0 ? "+" : ""}${grossGainPct.toFixed(1)}%)`}
            highlight={grossGain >= 0 ? "pos" : "neg"}
          />
        </div>

        <Field label="Data di chiusura">
          <input type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} style={styles.input} />
        </Field>
        <Field label="Tasse / commissioni da pagare (€)">
          <MoneyInput placeholder="0" value={fees} onChange={(e) => setFees(e.target.value)} style={styles.input} />
        </Field>

        <div style={styles.closeBox}>
          <SummaryRow label="Netto incassato" value={fmtFull(netAmount)} bold />
          <SummaryRow
            label="Guadagno netto"
            value={`${netGain >= 0 ? "+" : ""}${fmtFull(netGain)} (${netGainPct >= 0 ? "+" : ""}${netGainPct.toFixed(1)}%)`}
            highlight={netGain >= 0 ? "pos" : "neg"}
          />
        </div>

        <p style={styles.helpText}>
          Alla conferma la posizione viene chiusa e rimossa dagli investimenti. Il netto incassato viene aggiunto a Entrate/Uscite come movimento del {formatDate(closeDate)} sul conto "{(accounts.find((a) => a.id === inv.accountId) || defaultAccountOf(accounts) || {}).name || "—"}".
        </p>

        <button style={styles.primaryBtnFull} onClick={submit}>Conferma chiusura</button>
      </div>
    </ModalShell>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={styles.fieldLabel}>{label}</label>
      {children}
    </div>
  );
}

function FontImport() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap');
      * { box-sizing: border-box; }
      input, select { font-family: 'Inter', sans-serif; }
      input::-webkit-outer-spin-button, input::-webkit-inner-spin-button { opacity: 1; }
      ::selection { background: color-mix(in srgb, var(--accent) 33%, transparent); }
      .fx-check {
        -webkit-appearance: none; appearance: none;
        width: 17px; height: 17px; margin: 0; flex-shrink: 0;
        display: inline-block; vertical-align: middle; cursor: pointer;
        background: var(--bg) center / 12px 12px no-repeat;
        border: 1.5px solid var(--border-3); border-radius: 5px;
        transition: background-color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
      }
      .fx-check:hover { border-color: var(--accent); }
      .fx-check:focus-visible { outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 27%, transparent); }
      .fx-check:checked {
        background-color: var(--accent); border-color: var(--accent);
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%230F1720' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12.5l4.5 4.5L19 7.5'/%3E%3C/svg%3E");
      }
      :root[data-theme="light"] .fx-check:checked {
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23FFFFFF' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12.5l4.5 4.5L19 7.5'/%3E%3C/svg%3E");
      }
      :root[data-theme="light"] .fx-check:indeterminate {
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23FFFFFF' stroke-width='3.5' stroke-linecap='round'%3E%3Cpath d='M6 12h12'/%3E%3C/svg%3E");
      }
      .fx-check:indeterminate {
        background-color: var(--accent); border-color: var(--accent);
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%230F1720' stroke-width='3.5' stroke-linecap='round'%3E%3Cpath d='M6 12h12'/%3E%3C/svg%3E");
      }
      .mobile-nav { display: none; }
      .tx-list-mobile, .tx-fab-wrap { display: none; }
      @media (max-width: 720px) {
        .mobile-nav { display: block; }
        .nav-desktop, .app-header { display: none !important; }
        .tx-table-desktop, .tx-actions-desktop { display: none !important; }
        .tx-header-right.empty { display: none !important; }
        .filter-grid { grid-template-columns: 1fr 1fr !important; gap: 4px 10px !important; }
        .tx-list-mobile { display: block; }
        .tx-fab-wrap { display: block; }
        .app-shell { padding: 76px 16px 40px !important; }
        .two-col { grid-template-columns: 1fr !important; }
        .stats-row { grid-template-columns: 1fr 1fr !important; }
      }
      @media (max-width: 480px) {
        .stats-row { grid-template-columns: 1fr !important; }
      }
    `}</style>
  );
}

// ---------- Styles ----------
const styles = {
  app: {
    minHeight: "100vh",
    background: "var(--bg)",
    color: "var(--text)",
    fontFamily: "'Inter', sans-serif",
    padding: "0",
  },
  loadingScreen: {
    minHeight: "100vh",
    background: "var(--bg)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  loadingText: {
    color: "var(--text-muted)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    letterSpacing: 1,
  },
  shell: {
    maxWidth: 1080,
    margin: "0 auto",
    padding: "32px 24px 60px",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginBottom: 24,
    flexWrap: "wrap",
    gap: 16,
  },
  eyebrow: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    letterSpacing: 2,
    color: "var(--accent)",
    marginBottom: 4,
  },
  title: {
    fontFamily: "'Fraunces', serif",
    fontSize: 34,
    fontWeight: 600,
    margin: 0,
    color: "var(--text-strong)",
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  saveDot: (active) => ({
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: active ? "var(--pos)" : "var(--border-2)",
    transition: "background 0.3s ease",
  }),
  settingsBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 34,
    height: 34,
    borderRadius: 9,
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--text-muted)",
    cursor: "pointer",
    flexShrink: 0,
  },
  userBox: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 },
  userEmail: { fontSize: 11, color: "var(--text-dim)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  logoutBtn: { background: "transparent", border: "none", color: "var(--accent)", fontSize: 12, cursor: "pointer", padding: 0, textDecoration: "underline" },
  headerPatrimonio: {
    textAlign: "right",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "10px 16px",
  },
  headerPatrimonioLabel: {
    fontSize: 11,
    color: "var(--text-muted)",
    marginBottom: 2,
  },
  headerSplit: { marginTop: 4, fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" },
  headerPatrimonioValue: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 18,
    fontWeight: 700,
    color: "var(--accent)",
  },
  nav: {
    marginBottom: 28,
    borderBottom: "1px solid var(--surface-3)",
    paddingBottom: 12,
  },
  navItems: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap",
  },
  topBar: {
    position: "fixed", top: 0, left: 0, right: 0, height: 56, zIndex: 40,
    display: "flex", alignItems: "center", gap: 10, padding: "0 12px",
    background: "color-mix(in srgb, var(--bg) 93%, transparent)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
    borderBottom: "1px solid var(--surface-3)",
  },
  topBarBtn: {
    display: "flex", alignItems: "center", justifyContent: "center",
    width: 40, height: 40, borderRadius: 10, border: "none",
    background: "transparent", color: "var(--text)", cursor: "pointer", flexShrink: 0,
  },
  topBarTitle: {
    flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8,
    fontFamily: "'Fraunces', serif", fontSize: 18, fontWeight: 600, color: "var(--text-strong)",
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
  },
  topBarValue: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 700, color: "var(--accent)",
    background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px", flexShrink: 0,
  },
  drawerOverlay: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.67)", zIndex: 60, transition: "opacity 0.25s ease",
  },
  drawer: {
    position: "fixed", top: 0, bottom: 0, left: 0, width: 290, maxWidth: "85vw", zIndex: 61,
    background: "var(--bg)", borderRight: "1px solid var(--border)",
    display: "flex", flexDirection: "column", padding: "18px 14px",
    transition: "transform 0.28s ease", overflowY: "auto",
  },
  drawerHead: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, paddingLeft: 4 },
  drawerBalance: {
    background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "10px 14px", marginBottom: 16,
  },
  drawerItems: { display: "flex", flexDirection: "column", gap: 4, flex: 1 },
  drawerItem: (active) => ({
    display: "flex", alignItems: "center", gap: 12, padding: "13px 14px", borderRadius: 10,
    border: "1px solid " + (active ? "color-mix(in srgb, var(--accent) 27%, transparent)" : "transparent"),
    background: active ? "var(--surface-2)" : "transparent",
    color: active ? "var(--accent)" : "var(--text-soft-2)", fontSize: 15, fontWeight: 500, cursor: "pointer", textAlign: "left",
  }),
  drawerFoot: {
    display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
    paddingTop: 14, marginTop: 14, borderTop: "1px solid var(--surface-3)",
  },
  navBtn: (active) => ({
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "8px 14px",
    borderRadius: 8,
    border: "1px solid transparent",
    background: active ? "var(--surface-2)" : "transparent",
    color: active ? "var(--text)" : "var(--text-muted)",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    transition: "all 0.15s ease",
  }),
  content: {},
  grid: {
    display: "flex",
    flexDirection: "column",
    gap: 20,
  },
  statsRow: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: 14,
  },
  statCard: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: "16px 18px",
  },
  statCardMuted: {
    background: "var(--surface-muted)",
    border: "1px dashed var(--border-3)",
    borderRadius: 12,
    padding: "16px 18px",
  },
  statTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  statLabel: {
    fontSize: 12,
    color: "var(--text-muted)",
  },
  statValue: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 22,
    fontWeight: 700,
    color: "var(--text-strong)",
  },
  twoCol: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 14,
  },
  card: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: 20,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-soft-2)",
    letterSpacing: 0.2,
  },
  cardHeaderRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 14,
  },
  emptyState: {
    color: "var(--text-dim)",
    fontSize: 13,
    textAlign: "center",
    padding: "30px 10px",
  },
  sectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 10,
  },
  filterRow: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap",
    alignItems: "center",
  },
  filterGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
    gap: 12,
  },
  linkBtn: {
    background: "transparent",
    border: "none",
    color: "var(--accent)",
    fontSize: 12,
    cursor: "pointer",
    padding: 0,
    marginTop: 10,
    textDecoration: "underline",
  },
  filterBtn: (active) => ({
    padding: "6px 12px",
    borderRadius: 7,
    border: "1px solid " + (active ? "var(--accent)" : "var(--border)"),
    background: active ? "color-mix(in srgb, var(--accent) 13%, transparent)" : "transparent",
    color: active ? "var(--accent)" : "var(--text-muted)",
    fontSize: 12,
    cursor: "pointer",
  }),
  primaryBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: "var(--accent)",
    color: "var(--accent-contrast)",
    border: "none",
    borderRadius: 8,
    padding: "9px 16px",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
  },
  primaryBtnFull: {
    width: "100%",
    background: "var(--accent)",
    color: "var(--accent-contrast)",
    border: "none",
    borderRadius: 8,
    padding: "11px 16px",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    marginTop: 6,
  },
  h3: {
    fontFamily: "'Fraunces', serif",
    fontSize: 18,
    fontWeight: 600,
    margin: 0,
    color: "var(--text)",
  },
  tableWrap: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse" },
  th: {
    textAlign: "left",
    fontSize: 11,
    color: "var(--text-dim)",
    fontWeight: 600,
    letterSpacing: 0.5,
    padding: "0 10px 10px 10px",
    borderBottom: "1px solid var(--surface-3)",
  },
  tr: {},
  td: {
    padding: "10px",
    fontSize: 13,
    borderBottom: "1px solid var(--line-faint)",
    color: "var(--text-soft)",
  },
  tag: {
    fontSize: 11,
    background: "var(--surface-3)",
    color: "var(--text-soft-2)",
    padding: "3px 9px",
    borderRadius: 20,
    border: "1px solid var(--border-2)",
  },
  pagerBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 14,
    paddingTop: 14,
    borderTop: "1px solid var(--surface-3)",
  },
  pageBtn: (active, disabled) => ({
    minWidth: 32,
    height: 32,
    padding: "0 8px",
    borderRadius: 7,
    border: "1px solid " + (active ? "var(--accent)" : "var(--border)"),
    background: active ? "color-mix(in srgb, var(--accent) 13%, transparent)" : "transparent",
    color: disabled ? "var(--border-3)" : active ? "var(--accent)" : "var(--text-muted)",
    fontSize: 13,
    cursor: disabled ? "default" : "pointer",
  }),
  selectBanner: {
    textAlign: "center",
    fontSize: 12,
    color: "var(--text-soft)",
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "8px 12px",
    marginBottom: 12,
  },
  linkBtnInline: { background: "transparent", border: "none", color: "var(--accent)", fontSize: 12, cursor: "pointer", padding: 0, textDecoration: "underline" },
  rangeLabel: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" },
  rangeInput: {
    background: "var(--bg)",
    border: "1px solid var(--border-2)",
    borderRadius: 8,
    color: "var(--text)",
    fontSize: 12,
    padding: "6px 8px",
    fontFamily: "'Inter', sans-serif",
  },
  settingsTitle: { fontSize: 12, fontWeight: 600, color: "var(--text-muted)", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 10 },
  themeCard: (active) => ({
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    padding: 10,
    borderRadius: 12,
    border: "2px solid " + (active ? "var(--accent)" : "var(--border)"),
    background: active ? alpha("var(--accent)", 10) : "transparent",
    color: "var(--text)",
    cursor: "pointer",
  }),
  swatchBtn: (active) => ({
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 5,
    width: 62,
    padding: "8px 4px",
    borderRadius: 10,
    border: "2px solid " + (active ? "var(--accent)" : "transparent"),
    background: active ? alpha("var(--accent)", 10) : "transparent",
    color: "var(--text-soft)",
    cursor: "pointer",
  }),
  legendBtn: (active) => ({
    display: "inline-flex",
    alignItems: "center",
    padding: "4px 10px",
    borderRadius: 20,
    border: "1px solid " + (active ? "var(--accent)" : "var(--border)"),
    background: active ? "color-mix(in srgb, var(--accent) 13%, transparent)" : "transparent",
    color: active ? "var(--accent)" : "var(--text-muted)",
    fontSize: 12,
    cursor: "pointer",
  }),
  legendRow: {
    display: "flex",
    gap: 16,
    fontSize: 12,
    color: "var(--text-muted)",
  },
  legendItem: {
    display: "inline-flex",
    alignItems: "center",
  },
  statusDot: (effettivo) => ({
    display: "inline-block",
    width: 7,
    height: 7,
    borderRadius: "50%",
    marginRight: 7,
    verticalAlign: "middle",
    background: effettivo ? "var(--pos)" : "var(--secondary)",
  }),
  autoStatusBox: {
    display: "flex",
    alignItems: "center",
    fontSize: 13,
    color: "var(--text-soft)",
    background: "var(--bg)",
    border: "1px solid var(--border-2)",
    borderRadius: 8,
    padding: "9px 11px",
  },
  iconBtn: {
    background: "transparent",
    border: "none",
    color: "var(--text-dim)",
    cursor: "pointer",
    padding: 4,
    display: "inline-flex",
  },
  monthNav: { display: "flex", alignItems: "center", gap: 8 },
  monthLabel: { fontFamily: "'Fraunces', serif", fontSize: 18, fontWeight: 600, textTransform: "capitalize", minWidth: 150, textAlign: "center" },
  budgetTop: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 },
  budgetPct: { fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 700 },
  budgetBarWrap: { position: "relative", height: 10, background: "var(--surface-3)", borderRadius: 6, overflow: "hidden", marginBottom: 10 },
  budgetBarFill: (pct, color) => ({ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, background: color, borderRadius: 6 }),
  budgetBarPlanned: (from, to) => ({ position: "absolute", left: `${from}%`, top: 0, bottom: 0, width: `${Math.max(0, to - from)}%`, background: "var(--secondary)", opacity: 0.45 }),
  budgetMarker: (at) => ({ position: "absolute", left: `${at}%`, top: 0, bottom: 0, width: 2, background: "color-mix(in srgb, var(--text) 40%, transparent)" }),
  budgetInfo: { display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6, fontSize: 12, color: "var(--text-muted)", marginBottom: 4 },
  alertRow: { display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--line-faint)", fontSize: 13, color: "var(--text-soft)" },
  levelDot: (level) => ({ width: 8, height: 8, borderRadius: "50%", background: BUDGET_COLORS[level], flexShrink: 0 }),
  recurMark: {
    marginLeft: 6,
    fontSize: 12,
    color: "var(--text-muted)",
  },
  hint: { marginTop: 6, fontSize: 12, color: "var(--text-dim)" },
  fieldError: {
    marginTop: 6,
    fontSize: 12,
    color: "var(--neg)",
  },
  checkRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12,
    color: "var(--text-muted)",
    marginBottom: 14,
    cursor: "pointer",
  },
  balanceGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 12,
    marginTop: 14,
  },
  balanceCard: {
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: 14,
  },
  balanceCardTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 10,
  },
  balanceValue: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 16,
    fontWeight: 700,
    color: "var(--text)",
  },
  balanceTotalRow: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 13,
    color: "var(--text-muted)",
    marginTop: 14,
    paddingTop: 12,
    borderTop: "1px solid var(--surface-3)",
  },
  balanceTotalValue: {
    fontFamily: "'JetBrains Mono', monospace",
    fontWeight: 700,
    color: "var(--accent)",
  },
  closeBox: {
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "2px 14px",
    marginBottom: 16,
  },
  invGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
    gap: 12,
  },
  invCard: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: 16,
  },
  invCardTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 12,
  },
  invName: {
    fontSize: 14,
    fontWeight: 600,
    color: "var(--text)",
    marginBottom: 5,
  },
  invMeta: {
    fontSize: 11,
    color: "var(--text-dim)",
    marginBottom: 10,
  },
  invRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  invLabel: { fontSize: 12, color: "var(--text-muted)" },
  invValue: { fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: "var(--text-soft)" },
  invInput: {
    width: 100,
    background: "var(--bg)",
    border: "1px solid var(--border-2)",
    borderRadius: 6,
    color: "var(--text)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    padding: "3px 7px",
    textAlign: "right",
  },
  invPl: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    fontWeight: 700,
    marginTop: 8,
    paddingTop: 8,
    borderTop: "1px solid var(--surface-3)",
  },
  bigNumber: {
    fontFamily: "'Fraunces', serif",
    fontSize: 42,
    fontWeight: 700,
    color: "var(--accent)",
  },
  bigNumberSub: {
    fontSize: 13,
    color: "var(--text-muted)",
    marginTop: 6,
  },
  summaryGrid: { display: "flex", flexDirection: "column", gap: 0 },
  summaryRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "10px 0",
    borderBottom: "1px solid var(--line-faint)",
  },
  helpText: { fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 },
  tooltip: {
    background: "var(--surface-2)",
    border: "1px solid var(--border-2)",
    borderRadius: 8,
    padding: "8px 12px",
    fontSize: 12,
  },
  tooltipLabel: { color: "var(--text-muted)", marginBottom: 4 },
  tooltipRow: { display: "flex", justifyContent: "space-between", gap: 14, color: "var(--text)" },
  modalOverlay: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.60)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20,
  },
  modal: {
    background: "var(--surface)",
    border: "1px solid var(--border-2)",
    borderRadius: 14,
    width: 380,
    maxWidth: "100%",
    padding: 20,
    maxHeight: "90vh",
    overflowY: "auto",
  },
  modalHeader: {
    display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16,
  },
  modalTitle: { fontFamily: "'Fraunces', serif", fontSize: 18, fontWeight: 600, color: "var(--text)" },
  modalBody: {},
  toggleRow: { display: "flex", gap: 8, marginBottom: 16 },
  toggleBtn: (active, color) => ({
    flex: 1,
    padding: "9px",
    borderRadius: 8,
    border: "1px solid " + (active ? color : "var(--border)"),
    background: active ? alpha(color, 13) : "transparent",
    color: active ? color : "var(--text-muted)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  }),
  fieldLabel: { display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 6 },
  catSelectRow: { display: "flex", gap: 8, alignItems: "center" },
  catPlusBtn: {
    flexShrink: 0,
    width: 36,
    height: 36,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--surface-3)",
    border: "1px solid var(--border-2)",
    borderRadius: 8,
    color: "var(--accent)",
    cursor: "pointer",
  },
  catAddRow: { display: "flex", gap: 8, alignItems: "center" },
  catAddConfirm: {
    flexShrink: 0,
    background: "var(--accent)",
    color: "var(--accent-contrast)",
    border: "none",
    borderRadius: 8,
    padding: "9px 12px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  catList: { display: "flex", flexDirection: "column", gap: 10 },
  catRow: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: 14,
  },
  catRowTop: { display: "flex", gap: 10, alignItems: "flex-start" },
  reorderCol: { display: "flex", flexDirection: "column", gap: 3 },
  reorderBtn: (disabled) => ({
    width: 22,
    height: 22,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--surface-3)",
    border: "1px solid var(--border-2)",
    borderRadius: 5,
    color: disabled ? "var(--border-3)" : "var(--text-muted)",
    cursor: disabled ? "default" : "pointer",
  }),
  catNameRow: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  catName: { fontSize: 14, fontWeight: 600, color: "var(--text)" },
  catActions: { display: "flex", gap: 2 },
  subWrap: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--surface-3)" },
  subChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 12,
    background: "var(--surface-3)",
    color: "var(--text-soft)",
    padding: "5px 8px",
    borderRadius: 20,
    border: "1px solid var(--border-2)",
  },
  subChipBtn: {
    background: "transparent",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    padding: 1,
    display: "inline-flex",
  },
  subReorderBtn: (disabled) => ({
    background: "transparent",
    border: "none",
    color: disabled ? "var(--border-3)" : "var(--text-muted)",
    cursor: disabled ? "default" : "pointer",
    fontSize: 13,
    padding: "0 1px",
    lineHeight: 1,
  }),
  subAddBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 12,
    background: "transparent",
    color: "var(--accent)",
    border: "1px dashed var(--border-3)",
    padding: "5px 10px",
    borderRadius: 20,
    cursor: "pointer",
  },
  editSelBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 36,
    padding: "0 12px",
    background: "transparent",
    color: "var(--text)",
    border: "1px solid var(--border-2)",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
  filterBadge: {
    minWidth: 16,
    height: 16,
    padding: "0 4px",
    borderRadius: 8,
    background: "var(--accent)",
    color: "var(--accent-contrast)",
    fontSize: 10,
    fontWeight: 700,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },
  txListHead: { display: "flex", alignItems: "center", gap: 10, padding: "4px 4px 10px", fontSize: 12, color: "var(--text-muted)", cursor: "pointer" },
  txItem: (selected) => ({
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "11px 8px",
    borderTop: "1px solid var(--line-faint)",
    background: selected ? "var(--surface-2)" : "transparent",
    cursor: "pointer",
  }),
  txItemTitle: { fontSize: 14, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  txItemMeta: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 2, fontSize: 12, color: "var(--text-muted)", marginTop: 3 },
  txItemAccount: { fontSize: 11, color: "var(--text-dim)", marginTop: 3 },
  fab: (open) => ({
    position: "fixed",
    right: 16,
    bottom: "calc(20px + env(safe-area-inset-bottom, 0px))",
    zIndex: 46,
    width: 56,
    height: 56,
    borderRadius: "50%",
    border: "none",
    background: "var(--accent)",
    color: "var(--accent-contrast)",
    boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    transform: open ? "rotate(45deg)" : "none",
    transition: "transform 0.2s ease",
  }),
  fabBackdrop: { position: "fixed", inset: 0, zIndex: 44, background: "rgba(0,0,0,0.45)" },
  fabMenu: {
    position: "fixed",
    right: 16,
    bottom: "calc(88px + env(safe-area-inset-bottom, 0px))",
    zIndex: 46,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    alignItems: "flex-end",
  },
  fabItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "11px 16px",
    borderRadius: 24,
    border: "1px solid var(--border-2)",
    background: "var(--surface)",
    color: "var(--text)",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    boxShadow: "0 4px 14px rgba(0,0,0,0.3)",
  },
  fabItemPrimary: { background: "var(--accent)", color: "var(--accent-contrast)", borderColor: "var(--accent)" },
  recurBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
    width: "100%",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: "14px 18px",
    fontSize: 14,
    cursor: "pointer",
    textAlign: "left",
  },
  chatBox: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    minHeight: 280,
    maxHeight: "58vh",
    overflowY: "auto",
    padding: 14,
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 12,
  },
  bubbleUser: {
    maxWidth: "85%",
    background: "color-mix(in srgb, var(--accent) 13%, transparent)",
    border: "1px solid color-mix(in srgb, var(--accent) 33%, transparent)",
    color: "var(--text-strong)",
    borderRadius: "14px 14px 4px 14px",
    padding: "9px 13px",
    fontSize: 14,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  bubbleAi: {
    maxWidth: "92%",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    color: "var(--text-soft)",
    borderRadius: "14px 14px 14px 4px",
    padding: "10px 14px",
    fontSize: 14,
    lineHeight: 1.55,
    wordBreak: "break-word",
  },
  suggestBtn: {
    background: "transparent",
    border: "1px solid var(--border-2)",
    color: "var(--text-soft)",
    borderRadius: 20,
    padding: "7px 14px",
    fontSize: 13,
    cursor: "pointer",
    textAlign: "left",
  },
  chatInputRow: { display: "flex", gap: 10, alignItems: "flex-end", marginTop: 12 },
  secondaryBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: "transparent",
    color: "var(--text-soft)",
    border: "1px solid var(--border-2)",
    borderRadius: 8,
    padding: "9px 14px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  dropZone: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    textAlign: "center",
    padding: "34px 16px",
    border: "1px dashed var(--border-3)",
    borderRadius: 12,
    background: "var(--bg)",
    color: "var(--text-muted)",
    fontSize: 13,
    cursor: "pointer",
  },
  importSummary: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
    gap: 10,
    marginBottom: 12,
  },
  importWarn: {
    background: "color-mix(in srgb, var(--neg) 10%, transparent)",
    border: "1px solid color-mix(in srgb, var(--neg) 45%, transparent)",
    borderRadius: 10,
    padding: "10px 14px",
    marginBottom: 12,
    fontSize: 12,
    color: "var(--text-soft)",
  },
  importStat: { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px" },
  importTableWrap: { maxHeight: 360, overflow: "auto", border: "1px solid var(--border)", borderRadius: 10 },
  statusChip: (color) => ({
    fontSize: 10,
    color,
    border: "1px solid " + alpha(color, 40),
    background: alpha(color, 8),
    padding: "2px 7px",
    borderRadius: 20,
    whiteSpace: "nowrap",
  }),
  trashBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 36,
    padding: "0 12px",
    background: "color-mix(in srgb, var(--neg) 13%, transparent)",
    color: "var(--neg)",
    border: "1px solid var(--neg)",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
  input: {
    width: "100%",
    background: "var(--bg)",
    border: "1px solid var(--border-2)",
    borderRadius: 8,
    color: "var(--text)",
    fontSize: 14,
    padding: "9px 11px",
  },
};
