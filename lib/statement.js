// Lettura estratti conto bancari (PDF) e preparazione all'importazione.
// Questo file è puro (nessun accesso a DOM/Node): funziona sia nel browser che nei test.
//
// Banche supportate:
//  - Banco BPM  ("Conto corrente ordinario")
//  - Trade Republic (conto corrente)
// Ogni banca ha un parser che usa le coordinate del testo nel PDF; tutti producono lo stesso risultato.

// ---------- Estrazione del testo con coordinate ----------
// `pdfjs` è il modulo pdfjs-dist (passato dal chiamante), `data` un Uint8Array.
export async function extractPages(pdfjs, data) {
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push({
      items: tc.items
        .filter((it) => typeof it.str === "string" && it.str.length > 0)
        .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width })),
    });
  }
  return pages;
}

// ---------- Utility ----------
const cents = (n) => Math.round(n * 100);
const norm = (s) => s.toUpperCase().replace(/\s+/g, " ").trim();
const toNumber = (s) => Number(s.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", "."));

// Raggruppa gli item in righe (stessa coordinata y, tolleranza 1.5pt), dall'alto in basso
function toLines(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= 1.5) last.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  lines.forEach((l) => l.items.sort((a, b) => a.x - b.x));
  return lines;
}

const pageText = (page) => toLines(page.items).map((l) => l.items.map((i) => i.str).join("")).join("\n");

// Hash veloce non crittografico (cyrb53) per ottenere chiavi compatte e stabili
function hashString(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// vero se `text` contiene tutte le parole del nome dell'intestatario (in qualunque ordine)
const sameHolder = (holder, text) => {
  if (!holder) return false;
  const tokens = norm(holder).split(" ").filter((t) => t.length > 1);
  if (tokens.length < 2) return false;
  const hay = ` ${norm(text).replace(/[^A-Z0-9' ]/g, " ")} `;
  return tokens.every((t) => hay.includes(` ${t} `));
};

// ---------- Rilevamento banca ----------
export function parseStatement(pages) {
  if (!pages.length) throw new Error("Il PDF è vuoto.");
  const first = pageText(pages[0]);
  if (/TRADE REPUBLIC/i.test(first)) return parseTradeRepublic(pages);
  if (/ESTRATTO\s*CONTO/i.test(first)) return parseBancoBpm(pages);
  throw new Error("Formato non riconosciuto. Per ora sono supportati gli estratti conto Banco BPM e Trade Republic.");
}

// Costruisce il risultato comune: chiavi anti-duplicato, totali e controlli
function finalize({ bank, account, accountLabel, holder, opening, closing, declared, rows, extraChecks = {} }) {
  if (!rows.length) throw new Error("Nessun movimento trovato nell'estratto.");
  const seen = new Map();
  const transactions = rows.map((r) => {
    // La chiave identifica il movimento in modo stabile: conto + data + segno + importo + testo.
    // Movimenti identici nello stesso estratto vengono numerati (#1, #2…).
    const base = [account || "?", r.date, r.type, cents(r.amount), norm(r.raw)].join("|");
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return {
      date: r.date,
      valuta: r.valuta || null,
      type: r.type,
      amount: r.amount,
      raw: r.raw,
      description: r.description,
      suggest: r.suggest || null,
      kind: r.kind || null,
      instrument: r.instrument || null,
      key: `bk:${hashString(base)}#${n}`,
    };
  });

  const sum = (type) => transactions.filter((t) => t.type === type).reduce((s, t) => s + cents(t.amount), 0) / 100;
  const totals = { entrate: sum("entrata"), uscite: sum("uscita") };
  const closingOk = cents(opening.amount + totals.entrate - totals.uscite) === cents(closing.amount);
  const declaredOk =
    declared && declared.entrate != null && declared.uscite != null
      ? cents(declared.entrate) === cents(totals.entrate) && cents(declared.uscite) === cents(totals.uscite)
      : null;

  return {
    bank,
    account,
    accountLabel,
    holder: holder || null,
    opening,
    closing,
    declared: declared || { entrate: null, uscite: null },
    totals,
    checks: { closingOk, declaredOk, skipped: 0, ...extraChecks },
    transactions,
  };
}

// =====================================================================
//  Banco BPM
// =====================================================================
const BPM_DATE_RE = /^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/;
// importo con eventuale segno attaccato ("-66,08") o con spazi dopo il segno; il segno "-" indica un'uscita
const BPM_AMOUNT_RE = /^[-−–+]?\s*\d+(?:\.\d{3})*,\d{2}$/;
const isNegText = (s) => /^[-−–]/.test(s.trim());
const bpmISO = (s) => {
  const m = BPM_DATE_RE.exec(s);
  return m ? `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[2]}-${m[1]}` : null;
};
// Colonne (punti PDF): data contabile x≈71, importo uscite con bordo destro ≈260,
// importo entrate con bordo destro ≈332, descrizione x≥336. Le righe lunghe vengono spezzate a 45 caratteri.
const BPM = { dateMin: 60, dateMax: 85, amountMin: 200, descMin: 330, outRightMax: 270, lineWrapChars: 43 };

function parseBancoBpm(pages) {
  const firstText = pageText(pages[0]);
  const inMatch = /TOTALE ENTRATE\s*\+?\s*([\d.]+,\d{2})/.exec(firstText);
  const outMatch = /TOTALE USCITE\s*-?\s*([\d.]+,\d{2})/.exec(firstText);
  const declared = {
    entrate: inMatch ? toNumber(inMatch[1]) : null,
    uscite: outMatch ? toNumber(outMatch[1]) : null,
  };

  // intestatario: il testo subito sotto "Intestato a"
  let holder = null;
  const p1 = [...pages[0].items].sort((a, b) => b.y - a.y);
  const idx = p1.findIndex((i) => i.str.trim() === "Intestato a");
  if (idx >= 0) {
    const h = p1.slice(idx + 1).find((i) => i.x < 100 && /^[A-Z' ]{5,}$/.test(i.str.trim()));
    if (h) holder = h.str.trim();
  }

  let account = null;
  const rows = [];
  let opening = null;
  let closing = null;
  let cur = null;
  let ended = false;
  let skipped = 0;

  for (const page of pages.slice(1)) {
    if (ended) break;
    const header = page.items.find((i) => i.str.trim() === "DESCRIZIONE DELLE OPERAZIONI");
    if (!header) continue;

    if (!account) {
      const acc = page.items.find((i) => /^\d{9,14}$/.test(i.str.trim()) && Math.abs(i.y - (header.y + 104)) < 30 && i.x > 400);
      if (acc) account = acc.str.trim();
    }

    // corpo tabella: sotto l'intestazione (e la riga delle note *1 *2 *3), sopra il piè di pagina
    const body = page.items.filter((i) => i.y < header.y - 12 && i.y > 30);
    for (const line of toLines(body)) {
      const dateItem = line.items.find((i) => i.x >= BPM.dateMin - 20 && i.x <= BPM.dateMax + 20 && BPM_DATE_RE.test(i.str.trim()));
      const descItems = line.items.filter((i) => i.x >= BPM.descMin);
      const descText = descItems.map((i) => i.str).join("");

      if (!dateItem) {
        // riga di continuazione della descrizione (anche a cavallo di pagina)
        if (cur && descText.trim()) cur.lines.push(descText);
        continue;
      }

      const amountItem = line.items.find((i) => i.x >= BPM.amountMin && i.x < BPM.descMin && BPM_AMOUNT_RE.test(i.str.trim()));
      const amount = amountItem ? Math.abs(toNumber(amountItem.str.trim().replace(/[−–]/g, "-"))) : null;
      // uscita se il testo ha il segno "-", altrimenti si decide dalla colonna (bordo destro dell'importo)
      const isIn = amountItem ? !isNegText(amountItem.str) && amountItem.x + amountItem.w > BPM.outRightMax : false;
      const date = bpmISO(dateItem.str.trim());
      const upper = descText.trim().toUpperCase();

      if (upper.startsWith("SALDO INIZIALE")) {
        opening = { date, amount: upper.includes("DEBITO") ? -amount : amount };
        cur = null;
        continue;
      }
      if (upper.startsWith("SALDO FINALE")) {
        closing = { date, amount: upper.includes("DEBITO") ? -amount : amount };
        ended = true;
        break;
      }
      if (amount == null || !date) { skipped++; cur = null; continue; }

      const valutaItem = line.items.find((i) => i.x > 100 && i.x < 150 && BPM_DATE_RE.test(i.str.trim()));
      cur = {
        date,
        valuta: valutaItem ? bpmISO(valutaItem.str.trim()) : null,
        type: isIn ? "entrata" : "uscita",
        amount,
        lines: [descText],
      };
      rows.push(cur);
    }
  }

  if (!opening || !closing) {
    throw new Error("Non trovo il saldo iniziale/finale: il formato dell'estratto non è riconosciuto.");
  }

  const prepared = rows.map((r) => {
    // le righe lunghe vengono spezzate dalla banca a metà parola: si riuniscono senza spazio
    let raw = "";
    r.lines.forEach((l, i) => {
      const text = l.trim();
      if (i === 0) { raw = text; return; }
      const prev = r.lines[i - 1].trim();
      const wrapped = prev.length >= BPM.lineWrapChars && !/^SDD CORE/i.test(prev) && !/^(ITA|IT)\b/.test(text);
      raw += (wrapped ? "" : " ") + text;
    });
    raw = raw.replace(/\s+/g, " ").trim();
    const description = bpmDescription(raw);
    const kind = /^Bonifico/.test(description) && sameHolder(holder, description) ? "giroconto" : null;
    return { date: r.date, valuta: r.valuta, type: r.type, amount: r.amount, raw, description, kind };
  });

  const res = finalize({
    bank: "Banco BPM",
    account,
    accountLabel: account ? `····${account.slice(-4)}` : "conto",
    holder,
    opening,
    closing,
    declared,
    rows: prepared,
  });
  res.checks.skipped = skipped;
  return res;
}

export function bpmDescription(raw) {
  const s = raw;
  let m;
  if ((m = /^CARTA\*\d+ MC DIGIT-\d{2}:\d{2}-(.*)$/i.exec(s.replace(/^PAGAMENTO POS\s*/i, "")))) return `POS · ${m[1].trim()}`;
  if (/^PAGAMENTO POS/i.test(s)) return `POS · ${s.replace(/^PAGAMENTO POS\s*/i, "").trim()}`;
  if ((m = /^INCASSO RETRIBUZIONE E\/O PENSIONE\s*BON\.DA\s*(.*)$/i.exec(s))) return `Retribuzione · ${m[1].trim()}`;
  if ((m = /^SDD CORE:\s*\S+\s*(.*)$/i.exec(s))) return `Addebito diretto · ${m[1].trim() || "SDD"}`;
  if ((m = /^VS\.DISP\..*?FAVORE\s*(.*?)\s*(?:NOTPROVIDE)?$/i.exec(s))) return `Bonifico a ${m[1].trim() || "—"}`;
  if (/^RIF\.MBYT\S*\s*COMM\./i.test(s)) return "Commissione bonifico";
  if ((m = /^BON\.DA\s+(.*)$/i.exec(s))) return `Bonifico da ${m[1].trim()}`;
  return s;
}

// =====================================================================
//  Trade Republic
// =====================================================================
const IT_MONTHS = { gen: 1, feb: 2, mar: 3, apr: 4, mag: 5, giu: 6, lug: 7, ago: 8, set: 9, ott: 10, nov: 11, dic: 12 };
const TR_AMOUNT_RE = /^-?\d{1,3}(?:\.\d{3})*,\d{2}\s*€$/;
// Colonne (punti PDF): data x≈74, tipo x≈100, descrizione x≈145 (fino a ≈392),
// importi allineati a sinistra: entrate da x≈396, uscite da x≈437.6, saldo da x≈480-490.
const TR = { dateX: 80, typeMin: 95, descMin: 140, descMax: 392, outLeftMin: 430, balLeftMin: 470 };
const pad2 = (n) => String(n).padStart(2, "0");

function parseItalianDate(str) {
  const m = /^(\d{1,2})\s+([a-z]{3})\w*\s+(\d{4})$/i.exec(str.trim());
  if (!m || !IT_MONTHS[m[2].toLowerCase()]) return null;
  return `${m[3]}-${pad2(IT_MONTHS[m[2].toLowerCase()])}-${pad2(m[1])}`;
}

function parseTradeRepublic(pages) {
  const p1 = pages[0];
  const text1 = pageText(p1);

  // intestazione: periodo, IBAN, intestatario
  const period = /(\d{1,2}\s+[a-z]{3}\w*\s+\d{4})\s*-\s*(\d{1,2}\s+[a-z]{3}\w*\s+\d{4})/i.exec(text1);
  const iban = p1.items.map((i) => i.str.trim()).find((s) => /^[A-Z]{2}\d{2}[A-Z0-9]{15,30}$/.test(s)) || null;
  const holderItem = [...p1.items].filter((i) => i.x < 100 && i.y > 690 && i.y < 705).sort((a, b) => b.y - a.y)[0];
  const holder = holderItem ? holderItem.str.trim() : null;

  // riepilogo: saldo iniziale, entrate, uscite, saldo finale (4 importi sulla riga del prodotto)
  const amountsLine = toLines(p1.items).find((l) => l.items.filter((i) => TR_AMOUNT_RE.test(i.str.trim())).length >= 4);
  if (!amountsLine) throw new Error("Non trovo il riepilogo dei saldi: il formato dell'estratto non è riconosciuto.");
  const [iniz, ent, usc, fin] = amountsLine.items.filter((i) => TR_AMOUNT_RE.test(i.str.trim())).map((i) => toNumber(i.str));
  const opening = { date: period ? parseItalianDate(period[1]) : null, amount: iniz };
  const closing = { date: period ? parseItalianDate(period[2]) : null, amount: fin };
  if (!opening.date || !closing.date) throw new Error("Non trovo il periodo dell'estratto.");
  const declared = { entrate: ent, uscite: usc };

  const rows = [];
  for (const page of pages) {
    const hdrOut = page.items.find((i) => i.str.trim() === "IN USCITA" && i.x > 400);
    const hdrIn = page.items.find((i) => i.str.trim() === "IN ENTRATA" && i.x > 380);
    if (!hdrOut || !hdrIn) continue; // pagine senza la tabella dei movimenti (es. fondi monetari)
    const top = hdrOut.y - 5;
    const endMark = page.items.find((i) => /^PANORAMICA DEL SALDO/.test(i.str.trim()));
    const body = page.items.filter((i) => i.y < top && i.y > 85 && (!endMark || i.y > endMark.y));

    // ogni movimento è un blocco verticale: dalla riga con giorno (e mese) fino all'anno (x≈74)
    const starts = body
      .filter((i) => i.x < TR.dateX && (/^\d{2}$/.test(i.str.trim()) || /^\d{2}\s+[a-z]{3}$/i.test(i.str.trim())))
      .sort((a, b) => b.y - a.y);
    const years = body.filter((i) => i.x < TR.dateX && /^\d{4}$/.test(i.str.trim())).sort((a, b) => b.y - a.y);

    for (const st of starts) {
      const yr = years.find((y) => y.y < st.y && st.y - y.y < 40);
      if (!yr) continue;
      const block = body.filter((i) => i.y <= st.y + 1.5 && i.y >= yr.y - 1.5);

      const dayMonth = st.str.trim();
      let day, mon;
      if (/^\d{2}$/.test(dayMonth)) {
        day = dayMonth;
        const monItem = block.find((i) => i.x < TR.dateX && /^[a-z]{3}$/i.test(i.str.trim()));
        mon = monItem ? monItem.str.trim() : null;
      } else {
        [day, mon] = dayMonth.split(/\s+/);
      }
      if (!mon || !IT_MONTHS[mon.toLowerCase()]) continue;
      const date = `${yr.str.trim()}-${pad2(IT_MONTHS[mon.toLowerCase()])}-${day}`;

      const amountItems = block.filter((i) => i.x >= 390 && TR_AMOUNT_RE.test(i.str.trim()));
      const inAmt = amountItems.find((i) => i.x < TR.outLeftMin);
      const outAmt = amountItems.find((i) => i.x >= TR.outLeftMin && i.x < TR.balLeftMin);
      const balItem = amountItems.find((i) => i.x >= TR.balLeftMin);
      const amountItem = inAmt || outAmt;
      // alcune righe hanno l'importo "incollato" alla descrizione: in quel caso lo si ricava dal saldo
      if (!amountItem && !balItem) continue;

      const typeText = block
        .filter((i) => i.x >= TR.typeMin && i.x < TR.descMin)
        .sort((a, b) => b.y - a.y || a.x - b.x)
        .map((i) => i.str.trim())
        .join(" ");
      const detail = block
        .filter((i) => i.x >= TR.descMin && i.x < TR.descMax)
        .sort((a, b) => b.y - a.y || a.x - b.x)
        .map((i) => i.str.trim())
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      rows.push({
        date,
        type: inAmt ? "entrata" : "uscita",
        amount: amountItem ? Math.abs(toNumber(amountItem.str)) : null,
        balance: balItem ? toNumber(balItem.str) : null,
        tipo: typeText,
        raw: "",
        detail,
      });
    }
  }

  // controllo riga per riga: il saldo progressivo stampato dalla banca deve tornare
  let running = opening.amount;
  let rowMismatch = 0;
  rows.forEach((r) => {
    if (r.amount == null) {
      // importo fuso con la descrizione: lo deduco dalla variazione del saldo
      const delta = Math.round((r.balance - running) * 100) / 100;
      r.type = delta >= 0 ? "entrata" : "uscita";
      r.amount = Math.abs(delta);
      r.detail = r.detail.replace(/\s*-?[\d.]+,\d{2}\s*€\s*$/, "").trim();
    }
    r.raw = `${r.tipo} ${r.detail}`.trim();
    running = Math.round((running + (r.type === "entrata" ? r.amount : -r.amount)) * 100) / 100;
    if (r.balance != null && cents(running) !== cents(r.balance)) {
      rowMismatch++;
      running = r.balance; // riallinea per non propagare l'errore alle righe successive
    }
  });

  const prepared = rows.map((r) => {
    const c = trDescribe(r, holder);
    return { date: r.date, type: r.type, amount: r.amount, raw: r.raw, description: c.description, suggest: c.suggest, kind: c.kind, instrument: c.instrument || null };
  });

  return finalize({
    bank: "Trade Republic",
    account: iban,
    accountLabel: iban ? `····${iban.slice(-4)}` : "conto",
    holder,
    opening,
    closing,
    declared,
    rows: prepared,
    extraChecks: { rowsOk: rowMismatch === 0, rowMismatch },
  });
}

function trDescribe(r, holder) {
  const { tipo, detail: d, type } = r;
  let m;
  if (/^Commercio/i.test(tipo)) {
    const instrument = (m, side) => ({ isin: m[1], name: m[2].replace(/,$/, "").trim(), qty: Number(m[3]), side });
    if ((m = /^Savings plan execution (\S+) (.*?),?\s*quantity:\s*([\d.]+)/i.exec(d))) return { description: `Piano di accumulo · ${m[2].replace(/,$/, "").trim()}`, suggest: "Investimenti", kind: "investimento", instrument: instrument(m, "buy") };
    if ((m = /^Sell trade (\S+) (.*?),?\s*quantity:\s*([\d.]+)/i.exec(d))) return { description: `Vendita titoli · ${m[2].replace(/,$/, "").trim()}`, suggest: "Disinvestimento", kind: "investimento", instrument: instrument(m, "sell") };
    if ((m = /^Buy trade (\S+) (.*?),?\s*quantity:\s*([\d.]+)/i.exec(d))) return { description: `Acquisto titoli · ${m[2].replace(/,$/, "").trim()}`, suggest: "Investimenti", kind: "investimento", instrument: instrument(m, "buy") };
    return { description: d || "Operazione su titoli", suggest: type === "entrata" ? "Disinvestimento" : "Investimenti", kind: "investimento" };
  }
  if (/^Transazione/i.test(tipo)) {
    const merchant = /^(.*?),\s*[\d.,]+\s*\S{1,3},\s*exchange rate/i.exec(d);
    const name = (merchant ? merchant[1] : d.replace(/,?\s*markup:.*$/i, "")).trim();
    return { description: `Carta · ${name}`, suggest: null, kind: null };
  }
  if (/^Rendimento/i.test(tipo)) {
    if ((m = /Cash Dividend for ISIN (\S+)/i.exec(d))) return { description: `Dividendo · ${m[1]}`, suggest: "Rendimenti", kind: null };
    return { description: d || "Rendimento", suggest: "Rendimenti", kind: null };
  }
  if (/^Interessi/i.test(tipo)) return { description: "Interessi · Trade Republic", suggest: "Rendimenti", kind: null };
  if (/^Imposte/i.test(tipo)) {
    if (/Cancellation/i.test(d)) return { description: "Storno imposta di bollo", suggest: null, kind: null };
    if (/Stamp Duty/i.test(d)) return { description: "Imposta di bollo (portafoglio)", suggest: null, kind: null };
    return { description: d || "Imposte", suggest: null, kind: null };
  }
  if (/^Bonifico/i.test(tipo)) {
    if ((m = /^Outgoing transfer for (.*?)(?:\s*\([A-Z0-9]{15,}\))?$/i.exec(d))) {
      return { description: `Bonifico a ${m[1].trim()}`, suggest: null, kind: sameHolder(holder, m[1]) ? "giroconto" : null };
    }
    if ((m = /^Incoming transfer from (.*?)(?:\s*\([A-Z0-9]{15,}\))?$/i.exec(d))) {
      return { description: `Bonifico da ${m[1].trim()}`, suggest: null, kind: sameHolder(holder, m[1]) ? "giroconto" : null };
    }
  }
  return { description: `${tipo} ${d}`.trim(), suggest: null, kind: null };
}

// ---------- Categorie suggerite ----------
export const TRANSFER_CATEGORY = "Giroconto";
const RULES_USCITA = [
  ["Casa", /MUTUO|AFFITTO|CONDOMIN|\bENEL\b|\bHERA\b|\bIREN\b|\bGAS\b|\bLUCE\b|ACQUA/],
  ["Trasporti", /\bENI\b|DISTRIBUTORE|\bQ8\b|TAMOIL|\bIP\b|TELEPASS|BOLLO AUTO|\bACI\b|AUTOSTRAD|\bSHELL\b|\bESSO\b|TRENITALIA|ITALO|NORAUTO|AUTOPRATICHE/],
  ["Salute", /FARMACIA|PHARMACY|AMBULATORIO|VETERIN|MEDIC|OSPEDAL|DENTIST|OTTIC/],
  ["Cibo", /CONAD|\bCOOP\b|ESSELUNGA|LIDL|CARREFOUR|\bPAM\b|MC ?DONALD|BURGER|RISTORANT|PIZZ|AUTOGRILL|GMA DISTRIBUZIONE|SUPERMERC|PANIFIC|\bBAR\b|STARBUCKS|COFFEE|TARGET/],
  ["Abbonamenti", /WIND ?TRE|\bTIM\b|VODAFONE|ILIAD|NETFLIX|SPOTIFY|DISNEY|CANONE|YOUALERT|PRIME VIDEO|CLOUD|VERCEL|UPFOLLOW/],
  ["Svago", /MULTIPLEX|CINEMA|ARCADIA|DOJO|PALESTRA|STEAM|PLAYSTATION|TEATRO/],
  ["Shopping", /AMAZON|ZALANDO|EBAY|ARCAPLANET|DECATHLON|IKEA/],
];
const RULES_ENTRATA = [
  ["Stipendio", /RETRIBUZIONE|STIPENDIO|PENSIONE/],
  ["Rimborsi", /RIMBORSO|STORNO/],
];

// Categoria suggerita: una esistente, oppure (per i casi speciali delle banche, es. "Investimenti") una nuova da creare
export function suggestCategory(tx, categoryNames, transferName) {
  const find = (name) => categoryNames.find((c) => c.toLowerCase() === name.toLowerCase());
  if (tx.kind === "giroconto") return transferName || find(TRANSFER_CATEGORY) || TRANSFER_CATEGORY;
  if (tx.suggest) return find(tx.suggest) || tx.suggest;
  const rules = tx.type === "entrata" ? RULES_ENTRATA : RULES_USCITA;
  const text = tx.description.toUpperCase();
  for (const [name, re] of rules) {
    if (re.test(text) && find(name)) return find(name);
  }
  return find("Altro") || categoryNames[0] || "";
}


// =====================================================================
//  Diagnostica anonima
// =====================================================================
// Produce un testo che descrive la STRUTTURA del PDF (posizioni delle colonne, forma delle righe) senza dati personali:
// cifre -> 9, lettere -> a / A; restano in chiaro solo le etichette standard delle intestazioni.
const KEEP_LABELS = new Set([
  "DATA", "CONTABILE", "VALUTA", "DISPONIBILE", "USCITE", "ENTRATE", "DESCRIZIONE DELLE OPERAZIONI", "DESCRIZIONE",
  "ATM", "WEB", "APP", "*1", "*2", "*3", "ESTRATTO CONTO", "TOTALE ENTRATE", "TOTALE USCITE", "SALDO INIZIALE A VOSTRO CREDITO",
  "SALDO FINALE A VOSTRO CREDITO", "SALDO INIZIALE A VOSTRO DEBITO", "SALDO FINALE A VOSTRO DEBITO", "-", "+", "/", "€",
  "IN ENTRATA", "IN USCITA", "SALDO", "TIPO", "PRODOTTO", "SALDO INIZIALE", "SALDO FINALE",
]);
const maskText = (str) => {
  const t = str.trim();
  if (KEEP_LABELS.has(t.toUpperCase())) return t;
  return str.replace(/[0-9]/g, "9").replace(/[a-z]/g, "a").replace(/[A-Z]/g, "A");
};

export function buildDiagnostics(pages, outcome) {
  const out = [];
  out.push("DIAGNOSTICA ESTRATTO CONTO (anonima: cifre -> 9, lettere -> a/A)");
  out.push(`Esito: ${outcome || "n/d"}`);
  out.push(`Pagine: ${pages.length}`);
  const bin = (x) => Math.round(x / 5) * 5;
  const hist = (xs) => {
    const m = {};
    xs.forEach((x) => { m[bin(x)] = (m[bin(x)] || 0) + 1; });
    return Object.entries(m).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(" ");
  };
  let shown = 0;
  pages.forEach((page, pi) => {
    const it = page.items;
    const dateLike = it.filter((i) => /^\d{2}\/\d{2}\/(\d{2}|\d{4})$/.test(i.str.trim()));
    const amountLike = it.filter((i) => /^[-−–+]?\s*\d+(?:\.\d{3})*,\d{2}(\s*€)?$/.test(i.str.trim()));
    const header = it.filter((i) => /DESCRIZIONE|CONTABILE|USCITE|ENTRATE/.test(i.str.toUpperCase()) && i.str.length < 40);
    out.push("");
    out.push(`--- Pagina ${pi + 1}: elementi=${it.length} date=${dateLike.length} importi=${amountLike.length}`);
    out.push(`    intestazioni: ${header.map((h) => `"${h.str.trim()}"@x${Math.round(h.x)},y${Math.round(h.y)}`).join(" ") || "nessuna"}`);
    out.push(`    x delle date (istogramma): ${hist(dateLike.map((d) => d.x)) || "-"}`);
    out.push(`    x di inizio importi: ${hist(amountLike.map((d) => d.x)) || "-"} | bordo destro importi: ${hist(amountLike.map((d) => d.x + d.w)) || "-"}`);
    if (dateLike.length > 0 && shown < 3) {
      shown++;
      const lines = toLines(it);
      const start = Math.max(0, lines.findIndex((l) => l.items.some((i) => /DESCRIZIONE|DESCRIZ|OPERAZIONI/.test(i.str.toUpperCase()))));
      out.push("    prime righe (y | x:testo mascherato):");
      lines.slice(start, start + 28).forEach((l) => {
        out.push(`    ${Math.round(l.y)} | ${l.items.map((i) => `${Math.round(i.x)}:${maskText(i.str)}`).join("  ")}`);
      });
    }
  });
  return out.join("\n");
}
