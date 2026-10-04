#!/usr/bin/env node
// US Stock Market Report: refresh live prices -> us/data.json
// Node 20+, no npm dependencies. Data: Yahoo Finance spark + chart endpoints.
// Usage: node scripts/us-prices.mjs        (writes ../us/data.json only if prices changed)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'us');
const DATA = join(ROOT, 'data.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

async function getJson(path, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const url = HOSTS[i % HOSTS.length] + path;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) { lastErr = e; await sleep(1500 * (i + 1)); }
  }
  throw lastErr;
}

// ---------- symbol universe ----------
const INDICES = [
  ['^GSPC', 'S&P 500'], ['^DJI', 'Dow Jones'], ['^IXIC', 'Nasdaq Composite'], ['^NDX', 'Nasdaq 100'],
  ['^RUT', 'Russell 2000'], ['^VIX', 'CBOE VIX'],
];
const SECTORS = [
  ['XLK', 'Technology'], ['XLF', 'Financials'], ['XLV', 'Health Care'], ['XLE', 'Energy'], ['XLY', 'Consumer Discretionary'],
  ['XLP', 'Consumer Staples'], ['XLI', 'Industrials'], ['XLB', 'Materials'], ['XLU', 'Utilities'], ['XLRE', 'Real Estate'],
  ['XLC', 'Communication Services'],
];
const GLOBAL = [
  ['^FTSE', 'FTSE 100', 'UK'], ['^GDAXI', 'DAX', 'Germany'], ['^FCHI', 'CAC 40', 'France'], ['^N225', 'Nikkei 225', 'Japan'],
  ['^HSI', 'Hang Seng', 'Hong Kong'], ['000001.SS', 'Shanghai', 'China'], ['^KS11', 'KOSPI', 'Korea'],
  ['^NSEI', 'Nifty 50', 'India'], ['^BSESN', 'Sensex', 'India'],
];
const ASSETS = [
  ['GC=F', 'Gold', '$/oz'], ['SI=F', 'Silver', '$/oz'], ['BZ=F', 'Brent', '$/bbl'], ['CL=F', 'Crude (WTI)', '$/bbl'],
  ['NG=F', 'Natural gas', '$/MMBtu'], ['BTC-USD', 'Bitcoin', '$'], ['ETH-USD', 'Ethereum', '$'],
  ['DX-Y.NYB', 'US Dollar Index', 'index'], ['EURUSD=X', 'EUR/USD', '$ per €'], ['JPY=X', 'USD/JPY', '¥ per $'], ['INR=X', 'USD/INR', '₹ per $'],
];
// Yahoo quotes these as the yield in percent (e.g. 4.25 = 4.25%)
const YIELDS = [['^IRX', '13-week T-bill'], ['^FVX', '5-year Treasury'], ['^TNX', '10-year Treasury'], ['^TYX', '30-year Treasury']];
// S&P 100 + popular liquid names. Unknown symbols are skipped automatically.
const STOCKS = `AAPL MSFT NVDA AMZN GOOGL META AVGO TSLA BRK-B JPM LLY V MA UNH XOM JNJ WMT PG HD COST ORCL ABBV BAC KO NFLX
CVX MRK PEP AMD CRM ADBE TMO LIN ACN MCD CSCO ABT WFC IBM GE DHR QCOM TXN INTU AMGN PM CAT ISRG VZ NOW GS DIS AXP
SPGI RTX T MS NEE LOW PFE UNP BKNG HON CMCSA C BLK SCHW PLTR UBER COP DE LMT GILD SBUX BA MDT ADP MO BMY CVS
TMUS SO DUK MMM GD UPS FDX TGT NKE INTC MU AMAT LRCX KLAC PANW CRWD ANET SNOW SHOP COIN MSTR SMCI ARM HOOD
PYPL XYZ SOFI RIVN F GM USB PNC COF MET AIG BK SPG AMT CL MDLZ KHC CHTR EMR DELL APP ABNB DASH TSM MRVL
DDOG NET ZS RBLX CVNA RDDT`.split(/\s+/).filter(Boolean);

// ---------- New York time + NYSE calendar ----------
const NY = 'America/New_York';
const NYSE_HOLIDAYS = new Set(['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
  '2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05',
  '2027-09-06', '2027-11-25', '2027-12-24']);
const NYSE_EARLY = new Set(['2026-11-27', '2026-12-24', '2027-11-26']); // 1:00 PM ET close
const fmtNY = new Intl.DateTimeFormat('en-US', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
function etParts(ms) {
  const p = Object.fromEntries(fmtNY.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const h = +p.hour % 24, mi = +p.minute;
  return { date: `${p.year}-${p.month}-${p.day}`, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), min: h * 60 + mi,
    hhmm: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` };
}
// UTC epoch (s) for a New York wall-clock time on a given date (handles EDT/EST)
function etEpoch(date, hh, mm) {
  const guess = Date.parse(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: NY, timeZoneName: 'shortOffset' }).formatToParts(new Date(guess + 5 * 3600e3))
    .find((x) => x.type === 'timeZoneName').value; // e.g. GMT-4
  const h = +(off.match(/GMT([+-]\d+)/)?.[1] ?? -5);
  return Math.round((guess - h * 3600e3) / 1000);
}
const isTradingDay = (date, dow) => dow >= 1 && dow <= 5 && !NYSE_HOLIDAYS.has(date);

async function spark(symbols) {
  const out = {};
  for (let i = 0; i < symbols.length; i += 20) {
    const chunk = symbols.slice(i, i + 20);
    try {
      const j = await getJson('/v7/finance/spark?range=1d&interval=5m&symbols=' + encodeURIComponent(chunk.join(',')));
      for (const r of j?.spark?.result ?? []) {
        const m = r.response?.[0]?.meta; if (!m || m.regularMarketPrice == null) continue;
        const prev = m.chartPreviousClose ?? m.previousClose, last = m.regularMarketPrice;
        out[r.symbol] = {
          last, prev, chg: prev ? last - prev : null, pct: prev ? (last - prev) / prev * 100 : null,
          high: m.regularMarketDayHigh ?? null, low: m.regularMarketDayLow ?? null,
          hi52: m.fiftyTwoWeekHigh ?? null, lo52: m.fiftyTwoWeekLow ?? null,
          vol: m.regularMarketVolume ?? null, time: m.regularMarketTime ?? null, name: m.shortName ?? m.longName ?? null,
        };
      }
    } catch (e) { errors.push('spark ' + chunk[0] + '..: ' + e.message); }
    await sleep(350);
  }
  return out;
}

// Intraday series for the most recent regular session (works on holidays/weekends too)
async function intraday(sym) {
  const j = await getJson(`/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=5m`);
  const r = j?.chart?.result?.[0]; if (!r?.timestamp) return null;
  const c = r.indicators?.quote?.[0]?.close ?? [];
  const pts = r.timestamp.map((t, i) => [t, c[i]]).filter(([, v]) => v != null);
  if (!pts.length) return null;
  const lastDate = etParts(pts.at(-1)[0] * 1000).date;
  const day = pts.filter(([t]) => etParts(t * 1000).date === lastDate);
  const before = pts.filter(([t]) => etParts(t * 1000).date < lastDate);
  const prev = before.length ? before.at(-1)[1] : r.meta?.previousClose ?? null;
  const open = etEpoch(lastDate, 9, 30), close = NYSE_EARLY.has(lastDate) ? etEpoch(lastDate, 13, 0) : etEpoch(lastDate, 16, 0);
  return { date: lastDate, prev: r2(prev), open, close, points: day.map(([t, v]) => [t, r2(v)]) };
}

// ---------- main ----------
const errors = [];
const prevData = readJson(DATA) ?? {};
const ySyms = [...new Set([...INDICES, ...SECTORS, ...GLOBAL, ...ASSETS, ...YIELDS].map((x) => x[0]))];

const q = await spark([...ySyms, ...STOCKS]);
const fmt = (s, name, extra = {}, d = 2) => { const x = q[s]; const z = (v) => (v ? r2(v, d) : null);
  return x && { name, symbol: s, last: r2(x.last, d), chg: r2(x.chg, d), pct: r2(x.pct), high: z(x.high), low: z(x.low), prev: r2(x.prev, d), ...extra }; };

const spx = q['^GSPC'];
if (!spx) errors.push('S&P 500 quote missing');

const indices = INDICES.map(([s, n]) => fmt(s, n, { hi52: r2(q[s]?.hi52), lo52: r2(q[s]?.lo52) })).filter(Boolean);
const sectors = SECTORS.map(([s, n]) => fmt(s, n)).filter(Boolean).sort((a, b) => b.pct - a.pct);
const global = GLOBAL.map(([s, n, region]) => fmt(s, n, { region })).filter(Boolean);
const assets = ASSETS.map(([s, n, unit]) => fmt(s, n, { unit }, s === 'EURUSD=X' ? 4 : s === 'NG=F' ? 3 : 2)).filter(Boolean);
const yields = YIELDS.map(([s, n]) => { const x = fmt(s, n, { unit: '%' }, 3); if (x) x.bp = x.chg == null ? null : r2(x.chg * 100, 1); return x; }).filter(Boolean);

const now = Date.now();
const nowEt = etParts(now);
const sessionDate = spx?.time ? etParts(spx.time * 1000).date : null;

const stocks = STOCKS.map((s) => {
  const x = q[s]; if (!x || x.pct == null) return null;
  if (sessionDate && x.time && etParts(x.time * 1000).date !== sessionDate) return null; // stale quote
  return { symbol: s, name: x.name, ltp: r2(x.last), chg: r2(x.chg), pct: r2(x.pct), high: r2(x.high), low: r2(x.low), prev: r2(x.prev),
    hi52: r2(x.hi52), lo52: r2(x.lo52), vol: x.vol, valueM: x.vol ? r2(x.vol * x.last / 1e6, 0) : null };
}).filter(Boolean);
const gainers = stocks.filter((s) => s.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, 10);
const losers = stocks.filter((s) => s.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, 10);
const mostActive = [...stocks].filter((s) => s.valueM).sort((a, b) => b.valueM - a.valueM).slice(0, 10);
const near52High = stocks.filter((s) => s.hi52 && s.ltp >= s.hi52 * 0.98).sort((a, b) => b.ltp / b.hi52 - a.ltp / a.hi52).slice(0, 10);
const near52Low = stocks.filter((s) => s.lo52 && s.ltp <= s.lo52 * 1.02).sort((a, b) => a.ltp / a.lo52 - b.ltp / b.lo52).slice(0, 10);

const intra = {};
for (const [s, key] of [['^GSPC', 'sp500'], ['^DJI', 'dow'], ['^IXIC', 'nasdaq']]) {
  try { intra[key] = await intraday(s); } catch (e) { errors.push('chart ' + s + ': ' + e.message); intra[key] = prevData.intraday?.[key] ?? null; }
  await sleep(300);
}

// Market status: NYSE 9:30-16:00 ET (13:00 on early-close days), Mon-Fri, minus NYSE holidays
const trading = isTradingDay(nowEt.date, nowEt.dow);
const early = NYSE_EARLY.has(nowEt.date);
const closeMin = early ? 780 : 960;
let status = 'closed', note;
if (trading && nowEt.min >= 570 && nowEt.min < closeMin) { status = 'open'; note = early ? 'Market open (early close 1:00 PM ET)' : 'Market open'; }
else if (trading && nowEt.min >= 240 && nowEt.min < 570) { status = 'pre'; note = 'Pre-market: regular session opens 9:30 AM ET'; }
else if (trading && nowEt.min >= closeMin && nowEt.min < 1200) { status = 'post'; note = 'After-hours trading: regular session closed'; }
else if (nowEt.dow === 0 || nowEt.dow === 6) note = 'Weekend: market closed';
else if (!trading) note = 'NYSE holiday: market closed';
else if (nowEt.min < 240) note = 'Market closed: opens 9:30 AM ET';
else note = 'Market closed for the day';

const payload = {
  market: { status, note, sessionDate, earlyClose: NYSE_EARLY.has(sessionDate ?? ''), hours: '9:30 AM–4:00 PM ET, Mon–Fri' },
  indices, sectors, gainers, losers, mostActive, near52High, near52Low, stocks, global, assets, yields, intraday: intra,
  source: 'Yahoo Finance (prices, may be delayed)',
};

const strip = (o) => { const { updated, updatedEt, errors: _e, ...rest } = o ?? {}; return JSON.stringify(rest); };
if (!(indices.length > 0 && stocks.length > 0)) {
  console.error('No usable data fetched; data.json left unchanged.', errors.join(' | '));
  process.exit(1);
}
if (strip(payload) === strip(prevData)) {
  console.log('No price changes; us/data.json unchanged.');
} else {
  mkdirSync(ROOT, { recursive: true });
  const out = { updated: new Date(now).toISOString(), updatedEt: `${nowEt.date} ${nowEt.hhmm}`, ...payload, errors };
  writeFileSync(DATA, JSON.stringify(out) + '\n');
  console.log(`Wrote us/data.json: ${indices.length} indices, ${sectors.length} sectors, ${stocks.length}/${STOCKS.length} stocks, ` +
    `S&P ${intra.sp500?.points?.length ?? 0} pts, status=${status}${errors.length ? ', errors: ' + errors.join(' | ') : ''}`);
}
