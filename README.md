# ETF NAV / iNAV discount alert

Twice every trading day, this job scans **every ETF listed on NSE India** and
pings a Telegram bot when one is trading at a discount.

Two independent measures are reported in the same message:

| | Condition | What it means |
|---|---|---|
| **A** | `LTP < iNAV` by ≥ 0.25% | The ETF is trading **below its fair value** — the classic "ETF at a discount" case |
| **B** | `iNAV < declared NAV` by ≥ 0.25% | Today's indicative fair value sits **below the last published NAV** |

Sample message:

```
📉 ETF discount alert — Mon, 19 Oct, 10:00 IST
NSE snapshot 19-Oct-2026 09:59:51 · declared NAV as of 16-Oct-2026
Flags: LTP below iNAV ≥ 0.25%  ·  iNAV below NAV ≥ 0.25%

A. Trading below iNAV (fair value) — 3
SYMBOL      LTP vs iNAV            GAP      NAME
GOLDBEES    LTP 119.8 vs iNAV 120.2  −0.33%  NIPPON INDIA ETF GOLD BEES
...

B. iNAV below declared NAV — 1
...

268 liquid of 356 listed ETFs checked · traded value ≥ ₹5.00 L
```

## Schedule

| IST | UTC | Cron |
|---|---|---|
| 10:00 Mon–Fri | 04:30 | `30 4 * * 1-5` |
| 14:30 Mon–Fri | 09:00 | `0 9 * * 1-5` |

NSE holidays need no special handling: the script compares the snapshot date in
the feed with today's date in IST and stays silent when they differ (i.e. the
market has not traded today). Set `STALE_OK=1` to override.

## Data source

`https://www.nseindia.com/api/NextApi/apiClient/marketWatchApi?functionName=getETFData&parent=all&child=null`

This is the feed behind NSE's own *Exchange Traded Funds* market-watch page. Per
ETF it returns `symbol`, `companyName`, `lastPrice`, **`inav`** (the indicative
NAV the AMC publishes through the session), **`nav`** (last declared NAV, with
the feed's `navDate`) and traded volume/value. No API key, no cookies.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Bot API token from @BotFather (repo secret) |
| `TELEGRAM_CHAT_ID` | — | Destination chat (repo secret) |
| `MIN_DISCOUNT_PCT` | `0.25` | Section A threshold |
| `MIN_NAV_GAP_PCT` | `0.25` | Section B threshold |
| `MIN_TURNOVER_RS` | `500000` | Ignore ETFs traded below ₹5 L today |
| `SANITY_MAX_PCT` | `25` | Drop rows where iNAV and NAV differ by more than this (stale/re-issued NAVs) |
| `MAX_ROWS` | `15` | Rows listed per section |
| `ALWAYS_SEND_SUMMARY` | `true` | `false` → send only when something qualifies |
| `STALE_OK` | unset | `1` → send even if the snapshot is not from today |
| `DRY_RUN` | unset | `1` → print the message instead of sending |

## Setup (already done for `sachin5678/etf-nav-alert`)

1. Bot created via @BotFather (`@etf_nav_discount_bot`); the owner pressed
   `/start` so the bot may DM them.
2. Repo secrets set: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
3. Actions enabled; trigger manually from **Actions → ETF discount alert → Run
   workflow** (`stale_ok` defaults to true for manual runs).

## Local usage

```powershell
cd etf-nav-alert
Copy-Item .env.example .env      # fill in token + chat id
npm test                         # dry run: prints the message
npm start                        # real send
$env:STALE_OK="1"; npm start     # send even on a holiday / weekend
```

## Caveats worth knowing

* **iNAV quality varies by AMC.** Thin ETFs sometimes carry a stale iNAV, which
  shows up as a large, fake discount. `MIN_TURNOVER_RS` and `SANITY_MAX_PCT`
  filter the worst of it; raise `MIN_DISCOUNT_PCT` (e.g. 0.5) for a quieter feed.
* **Section B is dominated by the day's market move**, since the declared NAV is
  one session behind. Read it as "yesterday's NAV is stale", not as a discount.
* **GitHub cron can be late** (5–30 min at busy times) and scheduled workflows in
  an inactive repo are disabled after 60 days — any push or manual run resets
  that, or dispatch the workflow from an external cron (cron-job.org) with
  `POST /repos/sachin5678/etf-nav-alert/actions/workflows/etf-nav-alert.yml/dispatches`.
* This is a **screener, not trade advice**: an ETF at a discount can be illiquid
  or hard to exit at that price.
