#!/usr/bin/env node
/**
 * ETF iNAV discount alert  (NSE India)
 *
 * Which ETFs are genuinely cheap right now? The only comparison that answers
 * that is the live price against the live fair value:
 *
 *   A) LTP vs iNAV   lastPrice below iNAV -> the ETF trades below its fair value
 *   B) iNAV vs NAV   context: how far today's fair value has moved from the
 *                    last declared NAV (which lags one session) - NOT a discount
 *
 * Two things make a discount "genuine" and both are enforced here:
 *
 *   1. Liquidity - only the top TOP_LIQUID_N (default 100) ETFs by traded value
 *      are considered. A 0.3% discount in an ETF that trades Rs 2 lakh a day is
 *      inside its own bid/ask spread and cannot actually be bought.
 *
 *   2. Fresh iNAV - only categories whose iNAV tracks live (SEBI May-2022
 *      passive-funds circular): EQUITY (<=15 s lag) and COMMODITY gold/silver
 *      (live metal price when available). DEBT (iNAV only 4x/day) and GLOBAL
 *      INDICES (iNAV static when the foreign market is shut) are skipped -
 *      their "discounts" are almost always a stale iNAV, not a cheap ETF.
 *
 * On top of that the discount must persist across two feed snapshots taken
 * CONFIRM_SECONDS apart, so a single stale LTP print cannot raise an alert.
 *
 * Sends one Telegram message (Bot API). Designed for GitHub Actions:
 * no dependencies, Node >= 18 (global fetch).
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN      required unless DRY_RUN=1
 *   TELEGRAM_CHAT_ID        required unless DRY_RUN=1
 *   MIN_DISCOUNT_PCT        LTP-vs-iNAV threshold, default 0.25
 *   MIN_NAV_GAP_PCT         iNAV-vs-NAV threshold (section B), default 0.25
 *   TOP_LIQUID_N            universe = this many most-traded ETFs, default 100 (0 = all)
 *   MIN_TURNOVER_RS         optional absolute traded-value floor, default 0
 *   CONFIRM_SECONDS         re-check the feed after N s and keep only persistent
 *                           discounts; 0 disables the second sample. Default 60
 *   CHEAP_CATEGORIES        mainCatagory values eligible for the alert,
 *                           default "EQUITY,COMMODITY"
 *   SANITY_MAX_PCT          drop rows where |iNAV vs NAV| exceeds this, default 25
 *   MAX_ROWS                max rows listed per section, default 15
 *   ALWAYS_SEND_SUMMARY     "false" -> stay silent when nothing qualifies
 *   STALE_OK                "1" -> send even if the NSE snapshot is not from today
 *   DRY_RUN                 "1" -> print the message instead of sending
 */

const API =
  "https://www.nseindia.com/api/NextApi/apiClient/marketWatchApi?functionName=getETFData&parent=all&child=null";
const PAGE = "https://www.nseindia.com/market-data/exchange-traded-funds-etf";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? n : d;
};

const cfg = {
  minDiscountPct: num(process.env.MIN_DISCOUNT_PCT, 0.25),
  minNavGapPct: num(process.env.MIN_NAV_GAP_PCT, 0.25),
  topLiquidN: num(process.env.TOP_LIQUID_N, 100),
  minTurnover: num(process.env.MIN_TURNOVER_RS, 0),
  confirmSeconds: num(process.env.CONFIRM_SECONDS, 60),
  cheapCategories: (process.env.CHEAP_CATEGORIES || "EQUITY,COMMODITY")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  sanityMaxPct: num(process.env.SANITY_MAX_PCT, 25),
  maxRows: num(process.env.MAX_ROWS, 15),
  alwaysSummary: process.env.ALWAYS_SEND_SUMMARY !== "false",
  staleOk: process.env.STALE_OK === "1" || process.env.STALE_OK === "true",
  dryRun: process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true",
};

/* ------------------------------------------------------------------ utils */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const istNow = () =>
  new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

const istDateKey = () =>
  new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata" }); // dd/mm/yyyy

// "16-Oct-2026 16:00:00" -> "16/10/2026"
function stampDateKey(stamp) {
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})/.exec(String(stamp || ""));
  if (!m) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mm = months.indexOf(m[2]) + 1;
  if (!mm) return null;
  return `${m[1]}/${String(mm).padStart(2, "0")}/${m[3]}`;
}

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const sign = (n) => (n > 0 ? "+" : n < 0 ? "\u2212" : ""); // U+2212 minus
const pct = (n) => `${sign(n)}${Math.abs(n).toFixed(2)}%`;

const money = (n) => {
  if (!Number.isFinite(n)) return "-";
  if (n >= 1e7) return `\u20b9${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `\u20b9${(n / 1e5).toFixed(2)} L`;
  if (n >= 1e3) return `\u20b9${(n / 1e3).toFixed(1)} k`;
  return `\u20b9${Math.round(n)}`;
};

const pad = (s, w) => String(s).padEnd(w, " ");

/* ------------------------------------------------------------------- data */

async function fetchEtfs(attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(API, {
        headers: {
          "user-agent": UA,
          accept: "application/json, text/plain, */*",
          "accept-language": "en-IN,en;q=0.9",
          referer: PAGE,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const d = json?.data;
      if (!d || !Array.isArray(d.data)) throw new Error("unexpected payload shape");
      return d;
    } catch (err) {
      lastErr = err;
      if (i < attempts) await sleep(2000 * i);
    }
  }
  throw new Error(`NSE ETF feed failed after ${attempts} attempts: ${lastErr.message}`);
}

/* ------------------------------------------------------------------ score */

function analyse(snapshot) {
  let anomalies = 0;
  const rows = snapshot.data
    .map((r) => {
      const ltp = num(r.lastPrice, NaN);
      const inav = num(r.inav, NaN);
      const nav = num(r.nav, NaN);
      const turnover = num(r.totalTradedValue, 0);
      const volume = num(r.totalTradedVolume, 0);
      return {
        symbol: r.symbol,
        name: r.companyName || r.assets || r.symbol,
        category: String(r.mainCatagory || "").toUpperCase(),
        sub: r.subCatagory || "",
        ltp,
        inav,
        nav,
        turnover,
        volume,
        vsInav: inav > 0 && ltp > 0 ? ((ltp - inav) / inav) * 100 : null,
        inavVsNav: nav > 0 && inav > 0 ? ((inav - nav) / nav) * 100 : null,
      };
    })
    // a tradable row: something actually traded today and both prices exist
    .filter((r) => r.volume > 0 && r.turnover > 0 && r.turnover >= cfg.minTurnover && r.ltp > 0 && r.inav > 0)
    .filter((r) => {
      // Feed guard: a gap this large between iNAV and the declared NAV means one
      // of the two is stale or the scheme was re-issued - not a tradable signal.
      if (r.inavVsNav !== null && Math.abs(r.inavVsNav) > cfg.sanityMaxPct) {
        anomalies++;
        return false;
      }
      return true;
    });

  // the liquid universe: most-traded names first, capped at TOP_LIQUID_N
  const ranked = rows.slice().sort((a, b) => b.turnover - a.turnover);
  const universe = cfg.topLiquidN > 0 ? ranked.slice(0, cfg.topLiquidN) : ranked;
  const cutoff = universe.length ? universe[universe.length - 1].turnover : 0;

  // fresh-iNAV categories only, so a "discount" is not a stale-feed artefact
  const eligible = universe.filter((r) => cfg.cheapCategories.includes(r.category));

  const has = (v) => v !== null && Number.isFinite(v);
  const byAsc = (k) => (a, b) => a[k] - b[k];

  const cheap = eligible
    .filter((r) => has(r.vsInav) && r.vsInav <= -cfg.minDiscountPct)
    .sort(byAsc("vsInav"));
  const navGap = eligible
    .filter((r) => has(r.inavVsNav) && r.inavVsNav <= -cfg.minNavGapPct)
    .sort(byAsc("inavVsNav"));

  const measured = eligible.filter((r) => has(r.vsInav));
  const tightest = measured.slice().sort(byAsc("vsInav"))[0] || null;

  return {
    checked: snapshot.data.length,
    universeSize: universe.length,
    cutoff,
    eligible: eligible.length,
    skippedStatic: universe.length - eligible.length,
    cheap,
    navGap,
    tightest,
    anomalies,
    anyCheap: measured.filter((r) => r.vsInav < 0).length,
    anyNavGap: eligible.filter((r) => has(r.inavVsNav) && r.inavVsNav < 0).length,
  };
}

/* ---------------------------------------------------------------- message */

function table(items, cell, key) {
  const symW = Math.max(6, ...items.map((r) => r.symbol.length));
  const cellW = Math.max(...items.map((r) => cell(r).length));
  const moneyW = Math.max(6, ...items.map((r) => money(r.turnover).length));
  const nameW = 22;
  const lines = items.map((r) => {
    // the index name (subCatagory) is the informative part; companyName is long
    // and mostly repeats the AMC, which the symbol already encodes
    const label = (r.sub || r.name).trim();
    const nm = label.length > nameW ? `${label.slice(0, nameW - 1)}\u2026` : label;
    return `${pad(r.symbol, symW)}  ${pad(cell(r), cellW)}  ${pad(pct(r[key]), 8)}  ${pad(money(r.turnover), moneyW)}  ${nm}`;
  });
  return `<pre>${esc(lines.join("\n"))}</pre>`;
}

function buildMessage(a, snapshot, confirm) {
  const head = `\ud83d\udcc9 <b>ETF iNAV discount alert</b> \u2014 ${esc(istNow())} IST`;
  const meta = `NSE snapshot <b>${esc(snapshot.timestamp || "?")}</b> \u00b7 declared NAV as of <b>${esc(snapshot.navDate || "?")}</b>`;

  const blocks = [head, meta, ""];
  let hits = 0;

  if (a.cheap.length) {
    hits += a.cheap.length;
    const shown = a.cheap.slice(0, cfg.maxRows);
    blocks.push(
      `\ud83d\udfe2 <b>A. Below live iNAV \u2014 genuinely cheap \u2014 ${a.cheap.length}</b>`,
      table(shown, (r) => `LTP ${r.ltp} vs ${r.inav}`, "vsInav"),
    );
    if (a.cheap.length > shown.length) blocks.push(`\u2026 and ${a.cheap.length - shown.length} more`);
    blocks.push("");
  }

  if (a.navGap.length) {
    hits += a.navGap.length;
    const shown = a.navGap.slice(0, cfg.maxRows);
    blocks.push(
      `<b>B. iNAV below last declared NAV \u2014 ${a.navGap.length}</b>`,
      `<i>context only: the declared NAV is one session old, so most of this gap is the market move since then</i>`,
      table(shown, (r) => `iNAV ${r.inav} vs ${r.nav}`, "inavVsNav"),
    );
    if (a.navGap.length > shown.length) blocks.push(`\u2026 and ${a.navGap.length - shown.length} more`);
    blocks.push("");
  }

  if (!hits) {
    if (!cfg.alwaysSummary) return null;
    const t = a.tightest;
    blocks.push(
      `\u2705 <b>No genuine discount right now.</b>`,
      `${a.eligible} equity/gold ETFs measurable \u00b7 ${a.anyCheap} trading below iNAV \u00b7 ${a.anyNavGap} below last NAV`,
      t ? `Closest: <code>${esc(t.symbol)}</code> at ${pct(t.vsInav)} (LTP ${t.ltp} vs iNAV ${t.inav})` : "",
    );
  }

  const foot = [
    cfg.topLiquidN > 0
      ? `Top ${a.universeSize} liquid ETFs by traded value \u00b7 cutoff ${money(a.cutoff)}`
      : `All ${a.universeSize} traded ETFs`,
    `${a.eligible} checked (equity + gold/silver) \u00b7 ${a.skippedStatic} debt/global skipped (static iNAV)`,
    confirm > 0 ? `discount confirmed over ${confirm}s` : "",
    `${a.checked} listed ETFs scanned${a.anomalies ? ` \u00b7 ${a.anomalies} bad-data rows dropped` : ""}`,
  ]
    .filter(Boolean)
    .join(" \u00b7 ");
  blocks.push("", `<i>${foot}</i>`);
  return blocks.filter((l) => l !== undefined).join("\n");
}

/* ------------------------------------------------------------------- send */

async function send(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const chat = process.env.TELEGRAM_CHAT_ID || "";
  if (!token || !chat) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chat,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`Telegram sendMessage failed: ${body.description}`);
  return body.result.message_id;
}

/* ------------------------------------------------------------------- main */

(async () => {
  const snap1 = await fetchEtfs();
  console.log(
    `NSE snapshot ${snap1.timestamp} | NAV date ${snap1.navDate} | ${snap1.data.length} ETFs | market: ${snap1.marketStatus?.marketStatus}`,
  );

  const snapshotDay = stampDateKey(snap1.timestamp);
  const today = istDateKey();
  const stale = snapshotDay && snapshotDay !== today;
  if (stale && !cfg.staleOk && !cfg.dryRun) {
    console.log(
      `Snapshot is from ${snapshotDay}, today is ${today} (IST) \u2014 market closed/holiday, nothing sent. Use STALE_OK=1 to override.`,
    );
    return;
  }

  // second sample: keep only discounts that are still there after N seconds,
  // so one stale LTP print cannot trigger an alert
  let snap2 = snap1;
  let confirm = 0;
  if (cfg.confirmSeconds > 0 && !stale) {
    confirm = cfg.confirmSeconds;
    await sleep(confirm * 1000);
    try {
      snap2 = await fetchEtfs();
    } catch (err) {
      console.log(`confirmation fetch failed (${err.message}) - falling back to a single sample`);
      snap2 = snap1;
      confirm = 0;
    }
  }

  const a1 = analyse(snap1);
  const a = analyse(snap2);

  const firstPass = new Set(a1.cheap.map((r) => r.symbol));
  const unconfirmed = a.cheap.filter((r) => !firstPass.has(r.symbol));
  if (confirm > 0) a.cheap = a.cheap.filter((r) => firstPass.has(r.symbol));

  const message = buildMessage(a, snap2, confirm);

  if (!message) {
    console.log(`No qualifying discounts; ALWAYS_SEND_SUMMARY=false, nothing sent.`);
    console.log(`cheap=${a.cheap.length} navGap=${a.navGap.length} eligible=${a.eligible} universe=${a.universeSize}`);
    return;
  }

  console.log(
    `cheap=${a.cheap.length}${confirm ? ` (+${unconfirmed.length} unconfirmed dropped)` : ""} ` +
      `navGap=${a.navGap.length} eligible=${a.eligible} universe=${a.universeSize} cutoff=Rs${Math.round(a.cutoff)} checked=${a.checked}`,
  );

  if (cfg.dryRun) {
    console.log("--- DRY RUN, message preview ---");
    console.log(message);
    return;
  }

  const id = await send(message);
  console.log(`Telegram message ${id} sent to chat ${process.env.TELEGRAM_CHAT_ID}.`);
})().catch(async (err) => {
  console.error("FAILED:", err.message);
  // Best-effort heads-up so a broken run does not fail silently.
  try {
    await send(`\u26a0\ufe0f <b>ETF discount alert run failed</b>\n<code>${esc(err.message)}</code>`);
  } catch {
    /* the token is probably the thing that is broken */
  }
  process.exit(1);
});
