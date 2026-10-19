# ETF iNAV discount alert

Twice every trading day (10:00 and 14:30 IST, Mon–Fri) this job scans **every
ETF listed on NSE India** and pings a Telegram bot when one of the **top 100
most liquid ETFs is trading below its live fair value**.

The alert answers one question — *is this ETF genuinely cheap right now?* — and
deliberately ignores the comparison that looks interesting but says nothing
about cheapness:

| Section | Comparison | Meaning |
|---|---|---|
| **A** | `LTP < iNAV` by ≥ 0.25% | **Genuine discount** — the exchange price is below the live value of the basket |
| **B** | `iNAV < NAV` by ≥ 0.25% | Context — the declared NAV is one session old, so most of this gap is simply the market move since then |

A real message (dry run, current logic, 19 Oct 2026 10:09 IST):

```
📉 ETF iNAV discount alert — Mon, 19 Oct, 10:09 IST
NSE snapshot 19-Oct-2026 10:09:09 · declared NAV as of 18-Oct-2026

🟢 A. Below live iNAV — genuinely cheap — 5
HDFCSILVER  LTP 198.2 vs 199.72   −0.76%    ₹22.33 Cr  SILVER
TATSILV     LTP 20.18 vs 20.31    −0.64%    ₹11.17 Cr  SILVER
SILVERCASE  LTP 20.99 vs 21.1     −0.52%    ₹3.50 Cr   SILVER
SILVERAXIS  LTP 206.46 vs 207.45  −0.48%    ₹58.39 L   SILVER
GROWWSLVR   LTP 20.36 vs 20.43    −0.34%    ₹62.06 L   SILVER

B. iNAV below last declared NAV — 37
PVTBANIETF  iNAV 27.56 vs 28.0252    −1.66%    ₹1.44 Cr   Nifty Private Bank
SBISILVER   iNAV 202.69 vs 204.8763  −1.07%    ₹1.74 Cr   SILVER
SETFGOLD    iNAV 122.44 vs 123.7496  −1.06%    ₹4.61 Cr   GOLD
… and 34 more

Top 100 liquid ETFs by traded value · cutoff ₹31.48 L · 80 checked (equity +
gold/silver) · 20 debt/global skipped (static iNAV) · discount confirmed over
60s · 355 listed ETFs scanned
```

Read the [measured behaviour](#what-the-feed-actually-did-measured-19-oct-2026)
below before trusting section A's silver names — most of them were *not*
transient discounts that day.

## When is an ETF genuinely cheap?

Three prices exist for every ETF, and only one comparison answers the question:

| | What it is | How fresh |
|---|---|---|
| **LTP** | last traded price on NSE | live (updates on every trade) |
| **iNAV** | indicative NAV — live value of the ETF's basket | seconds … hours, see the table below |
| **NAV** | the AMC's official end-of-day NAV | one session behind |

**1. Compare the price to iNAV, never to NAV.** An ETF trading below its iNAV
means the basket is worth more than the asking price — that is a discount.
An iNAV below the declared NAV just means the market has moved down since the
previous session's close; the NAV was struck *before* that move. Section B is
kept in the message because it is genuinely interesting, but it is labelled as
context, not as a discount.

**2. A "discount" is only as real as the iNAV behind it.** SEBI's May-2022
passive-funds circular sets the disclosure clock for iNAV per category, and the
NSE feed cannot be fresher than what the AMC publishes:

| Category | iNAV freshness | What a "discount" really is |
|---|---|---|
| **Equity ETFs** | ≤ 15 seconds behind the underlying market | live and meaningful |
| **Debt / liquid ETFs** | **4 times a day** (90-minute gaps) | mostly a stale-iNAV artefact |
| **Gold / silver ETFs** | live when the metal price is available | meaningful during Indian hours |
| **International ETFs** | static while the foreign market is closed | the expected gap move; with subscriptions capped (RBI overseas limit) premiums/discounts can be structural for months |

This is why section A only ever reports **EQUITY and COMMODITY** ETFs
(`CHEAP_CATEGORIES`). Debt and global ETFs are counted in the footer and
skipped — their intraday "discounts" are not tradable information.

**3. You have to be able to actually buy it.** The universe is the **top 100
ETFs by traded value so far today** (`TOP_LIQUID_N`). A 0.3% "discount" in a
fund that traded ₹2 lakh all day is inside its own bid/ask spread — nobody is
selling that cheap, and if you get filled you are the market. For the most
traded ETFs the spread is a few paise (roughly 0.02–0.10%); for mid-caps it can
be 0.2–0.5%. Paperwork costs are negligible by comparison — STT 0.001% on sale
only, stamp duty 0.005% on purchase, exchange + SEBI + GST ~0.003% round trip,
about 0.01% in total. **The spread, not the tax, is the real cost**, which is
why the alert restricts itself to liquid names and why you should still check
the ask before buying: a discount measured at the *last traded price* evaporates
the moment the ask sits back at iNAV.

**4. It must survive a second look.** The job pulls the feed twice,
`CONFIRM_SECONDS` (default 60 s) apart, and only alerts if the discount is still
there in the second snapshot. In a fast tape a stale last-trade print or a
15-second iNAV lag looks like a 0.3% discount for a few seconds and then
disentangles — too fast for a human to act on, but very good at generating false
alerts. A discount that is still present 60 seconds later, with real turnover
behind it, is a tradeable candidate.

**5. Sanity bounds.** Rows where iNAV and the declared NAV differ by more than
`SANITY_MAX_PCT` (25%) are dropped as bad data — that is a stale or re-issued
NAV, not an opportunity.

Why the category rule matters — one live observation (19 Oct 2026):

```
MAFANG   LTP 274.80   iNAV 177.82   ->  +54.6% vs iNAV   (international, capped)
LIQUIDBEES LTP 1000.01 iNAV 1000.00  ->  +0.001%          (debt, iNAV is 4x/day)
```

MAFANG's +54% "premium" is not a signal about tomorrow: its iNAV is frozen on
US prices while NSE trades, and RBI's overseas cap blocks the creation trades
that would close the gap. Treating either of these as a cheapness signal would
be wrong for opposite reasons.

## What the feed actually did (measured, 19 Oct 2026)

A sampler polled the feed every ~90 seconds through the first 50 minutes of the
session (34 live samples, top-100 universe recomputed each time):

* **Equity discounts are transient.** Of the top-100 ETFs flagged at ≤ −0.25%
  (LTP vs iNAV), only **44% were still flagged one sample later** (~90 s) and
  the rest had reverted. The first 12 minutes of trading produced 11–20 flags per
  sample (opening-auction noise); after 09:30 the count settled at **5–7**.
* **Silver ETFs look cheap all day — and that is the point.** Six silver ETFs
  sat at a persistent 0.3–0.8% "discount" for the whole window: HDFCSILVER
  (median −0.74%, flagged in **100%** of samples), SILVERAXIS (−0.56%, 88%),
  SILVERCASE (−0.47%, 82%), TATSILV (−0.64%, 97%), SILVERAG (−0.32%, 70%),
  GROWWSLVR (−0.44%, 79%) — while SILVERBEES, the largest, traded at par
  (median −0.03%). A discount that persists *every* sample is not an intraday
  dislocation waiting to converge; it is a structural difference between those
  funds' iNAV and where their market clears. The 60-second confirmation cannot
  filter this out — it was built for transients, not for structure.
* **iNAV freshness followed the SEBI clock:** over the window, 100% of equity
  ETF iNAVs changed at least once, versus 67% for gold, 75% for silver and
  only ~41% for debt ETFs (4 updates/day).
* **Typical-size deviation:** the median |LTP − iNAV| of the top-100 was
  ~0.10%, so the 0.25% threshold sits near the 90th percentile of ordinary
  behaviour — flags are genuinely uncommon, which is why the 60-second check
  matters more than the threshold.

First scheduled run verified: cron-job.org job 8671236 fired at **10:00:13 IST**
(HTTP 204) → GitHub Actions run #5 → `Telegram message 5 sent`.

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
ETF it returns `symbol`, `companyName`, `mainCatagory`/`subCatagory`,
`lastPrice`, **`inav`**, **`nav`** (with the feed's `navDate`), OHLC, and traded
volume/value. No API key, no cookies.

Note: the feed carries **no bid/ask depth**, and NSE's per-symbol quote API is
cookie-gated (HTTP 403 from a bare client), so the alert cannot see the spread.
It compensates with the liquidity universe (point 3 above) and the confirmation
sample (point 4) — but it is a screener, not an execution engine.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Bot API token from @BotFather (repo secret) |
| `TELEGRAM_CHAT_ID` | — | Destination chat (repo secret) |
| `MIN_DISCOUNT_PCT` | `0.25` | Section A threshold (LTP below iNAV) |
| `MIN_NAV_GAP_PCT` | `0.25` | Section B threshold (iNAV below NAV) |
| `TOP_LIQUID_N` | `100` | universe = the N most-traded ETFs by value today (`0` = every ETF) |
| `CONFIRM_SECONDS` | `60` | a discount must survive two feed samples this far apart (`0` = single sample) |
| `CHEAP_CATEGORIES` | `EQUITY,COMMODITY` | `mainCatagory` values eligible for section A |
| `MIN_TURNOVER_RS` | `0` | optional absolute traded-value floor on top of the ranking |
| `SANITY_MAX_PCT` | `25` | drop rows where iNAV and NAV differ by more than this |
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
4. Two cron-job.org jobs (above) dispatch the workflow at 10:00 and 14:30 IST.

## Local usage

```powershell
cd etf-nav-alert
Copy-Item .env.example .env      # fill in token + chat id
npm test                         # dry run: prints the message
npm start                        # real send
$env:STALE_OK="1"; npm start     # send even on a holiday / weekend
$env:DRY_RUN="1"; $env:CONFIRM_SECONDS="0"; node check-etf-nav.js   # fast single-sample dry run
```

## Caveats worth knowing

* **LTP ≠ executable price.** The alert measures the last traded price against
  iNAV. You buy at the ask; check depth before trading any flagged name.
* **iNAV is a calculation, not gospel.** For large-cap baskets it is very
  reliable; for exotic baskets (smallcaps, overseas) the underlying prints are
  thinner and the iNAV inherits that.
* **Section B is context.** It compares today's fair value with a NAV that is up
  to one session old (longer, after holidays). A big gap there is normal after a
  big market day.
* **Scheduling lives outside GitHub** (see [Schedule](#schedule)). If the two
  cron-job.org jobs are ever disabled, nothing runs. Both jobs email on failure.
* This is a **screener, not trade advice**. An ETF at a discount can be illiquid,
  have a wide spread, or be cheap for a reason.

## References

* SEBI, *Circular on development of passive funds*, May 23, 2022 (iNAV
  dissemination frequency per ETF category).
* SEBI, *Norms for base price, price bands, call auction in pre-open session and
  close-out procedure for ETFs*, June 15, 2026 — effective September 7, 2026
  (base price = T-1 close's last-30-minute VWAP; bands: 10%→20% equity/debt,
  5% liquid/overnight, 6% gold/silver).
* NSE, Exchange Traded Funds market-watch page (the feed reproduced here).
