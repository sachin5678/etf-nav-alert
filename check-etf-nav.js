#!/usr/bin/env node
/**
 * ETF NAV / iNAV discount alert  (NSE India, all listed ETFs)
 *
 * Pulls the same feed the NSE ETF market-watch page uses and reports ETFs
 * that are trading at a discount, on two independent measures:
 *
 *   A) LTP vs iNAV      lastPrice < iNAV  -> the ETF trades below fair value
 *   B) iNAV vs NAV      iNAV < declared NAV -> today's fair value sits below
 *                                             the last published NAV
 *
 * Sends one Telegram message (Bot API). Designed for GitHub Actions:
 * no dependencies, Node >= 18 (global fetch).
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN      required unless DRY_RUN=1
 *   TELEGRAM_CHAT_ID        required unless DRY_RUN=1
 *   MIN_DISCOUNT_PCT        price-vs-iNAV threshold, default 0.25
 *   MIN_NAV_GAP_PCT         iNAV-vs-NAV threshold, default 0.25
 *   MIN_TURNOVER_RS         skip ETFs traded below this value today, default 500000
 *   SANITY_MAX_PCT          drop rows where |iNAV vs NAV| exceeds this, default 25
 *                           (protects against stale / re-issued NAVs in the feed)
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
  minTurnover: num(process.env.MIN_TURNOVER_RS, 500000),
  sanityMaxPct: num(process.env.SANITY_MAX_PCT, 25),
  maxRows: num(process.env.MAX_ROWS, 15),
  alwaysSummary: process.env.ALWAYS_SEND_SUMMARY !== "false",
  staleOk: process.env.STALE_OK === "1" || process.env.STALE_OK === "true",
  dryRun: process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true",
};

/* ------------------------------------------------------------------ utils */

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
  return `\u20b9${Math.round(n).toLocaleString("en-IN")}`;
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
      if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw new Error(`NSE ETF feed failed after ${attempts} attempts: ${lastErr.message}`);
}

/* ------------------------------------------------------------------ score */

function analyse(snapshot) {
  const anomalies = [];
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
        category: r.subCatagory || r.mainCatagory || "",
        ltp,
        inav,
        nav,
        turnover,
        volume,
        vsInav: inav > 0 && ltp > 0 ? ((ltp - inav) / inav) * 100 : null,
        inavVsNav: nav > 0 && inav > 0 ? ((inav - nav) / nav) * 100 : null,
      };
    })
    .filter((r) => r.volume > 0 && r.turnover >= cfg.minTurnover)
    .filter((r) => {
      // Feed guard: a gap this large between iNAV and the declared NAV means one
      // of the two is stale or the scheme was re-issued — not a tradable signal.
      if (r.inavVsNav !== null && Math.abs(r.inavVsNav) > cfg.sanityMaxPct) {
        anomalies.push(r);
        return false;
      }
      return true;
    });

  const has = (v) => v !== null && Number.isFinite(v);
  const byAsc = (k) => (a, b) => a[k] - b[k];

  const cheap = rows
    .filter((r) => has(r.vsInav) && r.vsInav <= -cfg.minDiscountPct)
    .sort(byAsc("vsInav"));
  const navGap = rows
    .filter((r) => has(r.inavVsNav) && r.inavVsNav <= -cfg.minNavGapPct)
    .sort(byAsc("inavVsNav"));

  const measured = rows.filter((r) => has(r.vsInav));
  const tightest = measured.slice().sort(byAsc("vsInav"))[0] || null;

  return {
    checked: snapshot.data.length,
    liquid: rows.length,
    measured: measured.length,
    cheap,
    navGap,
    tightest,
    anomalies: anomalies.length,
    anyCheap: measured.filter((r) => r.vsInav < 0).length,
    anyNavGap: rows.filter((r) => has(r.inavVsNav) && r.inavVsNav < 0).length,
  };
}

/* ---------------------------------------------------------------- message */

function table(items, key, valueFmt) {
  const symW = Math.max(6, ...items.map((r) => r.symbol.length));
  const nameW = 30;
  const lines = items.map((r) => {
    const nm = r.name.length > nameW ? `${r.name.slice(0, nameW - 1)}\u2026` : r.name;
    return `${pad(r.symbol, symW)}  ${pad(valueFmt(r), 26)}  ${pad(pct(r[key]), 8)} ${nm}`;
  });
  return `<pre>${esc(lines.join("\n"))}</pre>`;
}

function buildMessage(a, snapshot) {
  const head = `\ud83d\udcc9 <b>ETF discount alert</b> \u2014 ${esc(istNow())} IST`;
  const meta = `NSE snapshot <b>${esc(snapshot.timestamp || "?")}</b> \u00b7 declared NAV as of <b>${esc(snapshot.navDate || "?")}</b>`;
  const rules = `Flags: LTP below iNAV \u2265 ${cfg.minDiscountPct}%  \u00b7  iNAV below NAV \u2265 ${cfg.minNavGapPct}%`;

  const blocks = [head, meta, rules, ""];
  let hits = 0;

  if (a.cheap.length) {
    hits += a.cheap.length;
    const shown = a.cheap.slice(0, cfg.maxRows);
    blocks.push(
      `<b>A. Trading below iNAV (fair value) \u2014 ${a.cheap.length}</b>`,
      table(shown, "vsInav", (r) => `LTP ${r.ltp} vs iNAV ${r.inav}`),
    );
    if (a.cheap.length > shown.length) blocks.push(`\u2026 and ${a.cheap.length - shown.length} more`);
    blocks.push("");
  }

  if (a.navGap.length) {
    hits += a.navGap.length;
    const shown = a.navGap.slice(0, cfg.maxRows);
    blocks.push(
      `<b>B. iNAV below declared NAV \u2014 ${a.navGap.length}</b>`,
      table(shown, "inavVsNav", (r) => `iNAV ${r.inav} vs NAV ${r.nav}`),
    );
    if (a.navGap.length > shown.length) blocks.push(`\u2026 and ${a.navGap.length - shown.length} more`);
    blocks.push("");
  }

  if (!hits) {
    if (!cfg.alwaysSummary) return null;
    const t = a.tightest;
    blocks.push(
      `\u2705 <b>No ETF at a discount right now.</b>`,
      `${a.measured} of ${a.liquid} liquid ETFs measurable \u00b7 ${a.anyCheap} trading below iNAV \u00b7 ${a.anyNavGap} with iNAV below NAV`,
      t ? `Closest: <code>${esc(t.symbol)}</code> at ${pct(t.vsInav)} (LTP ${t.ltp} vs iNAV ${t.inav})` : "",
    );
  }

  blocks.push(
    "",
    `<i>${a.liquid} liquid of ${a.checked} listed ETFs checked \u00b7 traded value \u2265 ${money(cfg.minTurnover)}${a.anomalies ? ` \u00b7 ${a.anomalies} skipped as bad data` : ""}</i>`,
  );
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
  const snapshot = await fetchEtfs();
  console.log(
    `NSE snapshot ${snapshot.timestamp} | NAV date ${snapshot.navDate} | ${snapshot.data.length} ETFs | market: ${snapshot.marketStatus?.marketStatus}`,
  );

  const snapshotDay = stampDateKey(snapshot.timestamp);
  const today = istDateKey();
  if (snapshotDay && snapshotDay !== today && !cfg.staleOk && !cfg.dryRun) {
    console.log(
      `Snapshot is from ${snapshotDay}, today is ${today} (IST) \u2014 market closed/holiday, nothing sent. Use STALE_OK=1 to override.`,
    );
    return;
  }

  const a = analyse(snapshot);
  const message = buildMessage(a, snapshot);

  if (!message) {
    console.log(`No qualifying discounts; ALWAYS_SEND_SUMMARY=false, nothing sent.`);
    console.log(`cheap=${a.cheap.length} navGap=${a.navGap.length} liquid=${a.liquid}`);
    return;
  }

  console.log(
    `cheap=${a.cheap.length} navGap=${a.navGap.length} liquid=${a.liquid} checked=${a.checked}`,
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
