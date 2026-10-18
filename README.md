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

| IST (Mon–Fri) | cron-job.org job | GitHub trigger |
|---|---|---|
| 10:00 | `ETF NAV Alert \| Discount check (10:00 IST)` — id 8671236 | `workflow_dispatch` |
| 14:30 | `ETF NAV Alert \| Discount check (14:30 IST)` — id 8671237 | `workflow_dispatch` |

Scheduling is done by **cron-job.org** (both jobs use timezone `Asia/Kolkata`),
not by GitHub's own cron. Each job is a single HTTPS request:

```
POST https://api.github.com/repos/sachin5678/etf-nav-alert/actions/workflows/etf-nav-alert.yml/dispatches
Authorization: Bearer <fine-grained PAT: Actions: read & write>
Accept: application/vnd.github+json
Content-Type: application/json
X-GitHub-Api-Version: 2022-11-28

{"ref":"main","inputs":{"stale_ok":false}}
```

`stale_ok:false` is passed explicitly on purpose: a bare `workflow_dispatch`
would apply the input's default (`true`) and alert on holidays too.

Why not GitHub's built-in `schedule:`? It fires 5–30 minutes late at busy times
and, worse, scheduled workflows are silently disabled after 60 days without repo
activity. cron-job.org fires on the minute and emails you when a dispatch fails
(notify-on-failure is enabled on both jobs). The UTC cron lines are left
commented out in the workflow — re-enable them only if you abandon cron-job.org,
otherwise every run would fire twice.

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
* **Scheduling lives outside GitHub** (see [Schedule](#schedule)). If the two
  cron-job.org jobs are ever disabled, nothing runs. Both jobs email on failure,
  and GitHub keeps the workflow file even if it is never auto-triggered. The
  built-in cron fallback is commented out in the workflow file.
* This is a **screener, not trade advice**: an ETF at a discount can be illiquid
  or hard to exit at that price.
