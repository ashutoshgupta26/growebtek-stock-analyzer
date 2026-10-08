#!/usr/bin/env node
// US Stock Market Report: refresh news + commentary -> us/news.json
// Runs right after us-prices.mjs. No AI, no paid services: headlines come from public RSS feeds;
// summary, mood, levels and risks are computed from us/data.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'us');
const DATA = join(ROOT, 'data.json');
const NEWS = join(ROOT, 'news.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nf = (x, d = 2) => x == null ? '–' : Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const sg = (x, d = 2) => (x > 0 ? '+' : x < 0 ? '−' : '') + nf(Math.abs(x), d);
const pc = (x) => sg(x) + '%';
const errors = [];

async function get(url, opts = {}, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers ?? {}) }, signal: AbortSignal.timeout(15000) });
      if (r.ok) return r;
      if (r.status < 500 && r.status !== 429) return null;
    } catch {}
    await sleep(800 * (i + 1));
  }
  return null;
}

// ---------- RSS ----------
const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/\s+/g, ' ').trim();
const tag = (block, name) => { const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : ''; };

async function rss(url, src) {
  const r = await get(url);
  if (!r) { errors.push('feed ' + src); return []; }
  const xml = await r.text();
  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)].map(([b]) => {
    let title = tag(b, 'title'), source = src;
    const gsrc = tag(b, 'source');
    if (gsrc) { source = gsrc; title = title.replace(new RegExp('\\s+-\\s+' + gsrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), ''); }
    const ts = Date.parse(tag(b, 'pubDate')) || 0;
    let link = tag(b, 'link'); if (!/^https?:/.test(link)) link = (b.match(/<link[^>]*href="([^"]+)"/) || [])[1] || link;
    return { title, url: link, src: source, ts };
  }).filter((x) => x.title && x.title.length > 15);
}
const gnews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
const cnbc = (id) => `https://www.cnbc.com/id/${id}/device/rss/rss.html`;
const FEEDS = {
  stocks: [[cnbc(100003114), 'CNBC'], [cnbc(10000664), 'CNBC'], ['https://feeds.content.dowjones.io/public/rss/mw_topstories', 'MarketWatch'],
    ['https://seekingalpha.com/market_currents.xml', 'Seeking Alpha'], ['https://www.nasdaq.com/feed/rssoutbound?category=Markets', 'Nasdaq'],
    ['https://finance.yahoo.com/news/rssindex', 'Yahoo Finance']],
  econ: [[cnbc(20910258), 'CNBC Economy'], [gnews('(Fed OR FOMC OR Powell OR CPI OR "jobs report" OR payrolls OR "Treasury yields" OR inflation) economy when:2d'), 'Google News']],
  earnings: [[cnbc(15839135), 'CNBC Earnings'], [gnews('(earnings OR "quarterly results") (beats OR misses OR guidance) stock when:3d'), 'Google News']],
  analyst: [[gnews('(upgrades OR downgrades OR "price target" OR "initiates coverage") stock analyst when:2d'), 'Google News']],
  ipo: [[gnews('IPO (prices OR files OR debut OR "shares jump" OR "shares fall") NYSE OR Nasdaq when:7d'), 'Google News']],
  commod: [[gnews('(bitcoin OR ether OR gold OR silver OR oil OR crude OR OPEC) prices when:2d'), 'Google News']],
};

const MAX_AGE = 3 * 864e5;
// Low-quality or off-topic sources and headline patterns (non-US markets, personal finance, auto-generated forecasts)
const JUNK_SRC = /ad-hoc-news|scanx|Nyasa|thefinancetoday|Moneycontrol|Economic Times|Business Standard|Livemint|Yahoo! Finance Canada|OilPrice\.com|Startup Fortune|middle-east-online|USA Today/i;
const JUNK = /Social Security|retire(?:ment|d)?\b|Dalal|Sensex|Nifty|\bRBI\b|Stock Forecast & Price Target|\| Opinion|Which .*Better Buy|Is It Too Late|Should You Buy|Millionaire|Passive Income|Dividend Stocks? to Buy|Stocks? to Buy (?:Now|and Hold)/i;
const US_ECON = /\b(Fed|FOMC|Powell|Warsh|Treasury|U\.?S\.?|US|American|Wall Street|jobs report|payrolls|jobless|CPI|PCE|GDP|tariffs?|White House|Trump|Hassett|Bessent|mortgage rates|consumer)\b/;
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').slice(0, 8).join(' ');
function pick(items, n, seen, filter = () => true, maxAge = MAX_AGE) {
  const out = [];
  for (const it of [...items].sort((a, b) => b.ts - a.ts)) {
    if (out.length >= n) break;
    if (!it.ts || Date.now() - it.ts > maxAge || JUNK_SRC.test(it.src) || JUNK.test(it.title)) continue;
    const k = norm(it.title);
    if (seen.has(k) || !filter(it)) continue;
    seen.add(k); out.push(it);
  }
  return out;
}
const slim = (it) => ({ title: it.title, url: it.url, src: it.src, ts: it.ts || null });

// ---------- calendar (New York time) ----------
const NY = 'America/New_York';
const NYSE_HOLIDAYS = { '2026-01-01': "New Year's Day", '2026-01-19': 'Martin Luther King Jr. Day', '2026-02-16': "Washington's Birthday", '2026-04-03': 'Good Friday',
  '2026-05-25': 'Memorial Day', '2026-06-19': 'Juneteenth', '2026-07-03': 'Independence Day (observed)', '2026-09-07': 'Labor Day', '2026-11-26': 'Thanksgiving Day',
  '2026-12-25': 'Christmas Day', '2027-01-01': "New Year's Day", '2027-01-18': 'Martin Luther King Jr. Day', '2027-02-15': "Washington's Birthday",
  '2027-03-26': 'Good Friday', '2027-05-31': 'Memorial Day', '2027-06-18': 'Juneteenth (observed)', '2027-07-05': 'Independence Day (observed)',
  '2027-09-06': 'Labor Day', '2027-11-25': 'Thanksgiving Day', '2027-12-24': 'Christmas Day (observed)' };
const NYSE_EARLY = { '2026-11-27': 'Day after Thanksgiving', '2026-12-24': 'Christmas Eve', '2027-11-26': 'Day after Thanksgiving' };
// Federal Reserve FOMC meetings (second day = decision, 2:00 PM ET). * = with Summary of Economic Projections
const FOMC = ['2026-01-28', '2026-03-18*', '2026-04-29', '2026-06-17*', '2026-07-29', '2026-09-16*', '2026-10-28', '2026-12-09*',
  '2027-01-27', '2027-03-17*', '2027-04-28', '2027-06-09*', '2027-07-28', '2027-09-15*', '2027-10-27', '2027-12-08*'];
const fmtNY = new Intl.DateTimeFormat('en-US', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const etNow = (() => { const p = Object.fromEntries(fmtNY.formatToParts(new Date()).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute }; })();
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dlabel = (iso) => { const d = new Date(iso + 'T12:00:00Z'); return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };
const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const isTrading = (iso) => { const w = new Date(iso + 'T12:00:00Z').getUTCDay(); return w > 0 && w < 6 && !NYSE_HOLIDAYS[iso]; };
const clock = (min) => { const h = Math.floor(min / 60), m = min % 60; return `${(h + 11) % 12 + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

function nextSession() {
  let d = etNow.date;
  if (!isTrading(d) || etNow.min >= 570) d = addDays(d, 1); // today's session already started or no session today
  for (let i = 0; i < 10 && !isTrading(d); i++) d = addDays(d, 1);
  return dlabel(d) + (NYSE_EARLY[d] ? ' (early close 1:00 PM ET)' : '');
}
function upcomingEvents() {
  const ev = [];
  const until = addDays(etNow.date, 75);
  for (const f of FOMC) {
    const d = f.replace('*', ''); if (d < etNow.date || d > until) continue;
    ev.push({ date: d, label: `Fed (FOMC) rate decision, 2:00 PM ET${f.endsWith('*') ? ' + economic projections' : ''}` });
  }
  for (const [d, n] of Object.entries(NYSE_HOLIDAYS)) if (d >= etNow.date && d <= until) ev.push({ date: d, label: `NYSE closed: ${n}` });
  for (const [d, n] of Object.entries(NYSE_EARLY)) if (d >= etNow.date && d <= until) ev.push({ date: d, label: `Early close 1:00 PM ET: ${n}` });
  return ev.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6).map((e) => ({ ...e, when: dlabel(e.date) }));
}

// ---------- main ----------
const D = readJson(DATA);
const prev = readJson(NEWS) ?? {};
if (!D?.indices?.length) { console.error('us/data.json missing; news.json left unchanged.'); process.exit(0); }

const feeds = {};
for (const [k, list] of Object.entries(FEEDS)) feeds[k] = (await Promise.all(list.map(([u, s]) => rss(u, s)))).flat();
const all = Object.values(feeds).flat();
const seen = new Set();
const ANALYST = /\b(price target|target to \\$|upgrades?|upgraded|downgrades?|downgraded|overweight|underweight|outperform|underperform|initiates? coverage|reiterates? (?:buy|sell|hold|outperform|overweight|neutral)|buy rating|sell rating|neutral rating|analysts? (?:say|see|says))\b/i;
const EARN = /\b(earnings|quarter|quarterly|Q[1-4]|results|EPS|revenue|guidance|profit)\b/i;
const IPO = /\bIPO|initial public offering|debut|goes public|going public\b/i;
const analyst = pick([...feeds.analyst, ...feeds.stocks], 8, seen, (it) => ANALYST.test(it.title));
const earnings = pick([...feeds.earnings, ...feeds.stocks], 8, seen, (it) => EARN.test(it.title));
const ipoNews = pick([...feeds.ipo, ...feeds.stocks], 6, seen, (it) => IPO.test(it.title), 7 * 864e5);
const econNews = pick(feeds.econ, 8, seen, (it) => it.src.startsWith("CNBC") || US_ECON.test(it.title));
const commodNews = pick(feeds.commod, 6, seen);
const stockNews = pick(feeds.stocks, 10, seen);

// ---------- computed commentary ----------
const idx = (n) => D.indices.find((i) => i.name === n);
const asset = (n) => (D.assets ?? []).find((a) => a.name === n);
const yld = (n) => (D.yields ?? []).find((a) => a.name === n);
const spx = idx('S&P 500'), dow = idx('Dow Jones'), nas = idx('Nasdaq Composite'), rut = idx('Russell 2000'), vix = idx('CBOE VIX');
const secs = [...(D.sectors ?? [])].sort((a, b) => b.pct - a.pct);
const open = D.market?.status === 'open';
const sd = D.market?.sessionDate ?? etNow.date;
const sdLabel = dlabel(sd).replace(/^\w+ /, '');
const closeLbl = D.market?.earlyClose ? '1:00 PM ET' : '4:00 PM ET';
const tracked = D.stocks ?? [];
const adv = tracked.filter((s) => s.pct > 0).length, dec = tracked.filter((s) => s.pct < 0).length;

const p = spx.pct;
const mood = p >= 0.75 ? 'Bullish' : p >= 0.2 ? 'Mildly bullish' : p <= -0.75 ? 'Bearish' : p <= -0.2 ? 'Mildly bearish' : 'Neutral';
const verb = open ? (p >= 0 ? 'is up' : 'is down') : (p >= 0 ? 'closed up' : 'closed down');
const top = secs[0], bot = secs[secs.length - 1];
const g1 = D.gainers?.[0], l1 = D.losers?.[0];
const tnx = yld('10-year Treasury');

const parts = [
  `The S&P 500 ${verb} ${nf(Math.abs(p))}% at ${nf(spx.last)} (range ${nf(spx.low)}–${nf(spx.high)})`,
  dow && nas && `Dow ${sg(dow.chg)} pts (${pc(dow.pct)}), Nasdaq ${pc(nas.pct)}`,
  top && bot && `${top.name} leads (${pc(top.pct)}), ${bot.name} lags (${pc(bot.pct)})`,
  g1 && l1 && `Top gainer ${g1.symbol} (${pc(g1.pct)}), top loser ${l1.symbol} (${pc(l1.pct)})`,
  tnx && `10-year Treasury yield ${nf(tnx.last, 2)}% (${tnx.bp > 0 ? '+' : tnx.bp < 0 ? '−' : ''}${nf(Math.abs(tnx.bp ?? 0), 0)} bp)`,
].filter(Boolean);
const summary = parts.join('. ') + '.';

// Classic floor pivots from the session's high / low / last
const P = (spx.high + spx.low + spx.last) / 3;
const R1 = 2 * P - spx.low, S1 = 2 * P - spx.high, R2 = P + (spx.high - spx.low), S2 = P - (spx.high - spx.low);
const r0 = (x) => Math.round(x / 5) * 5;
const bull = { level: `Above ${nf(r0(R1), 0)}`, text: `A sustained move above the pivot resistance ${nf(r0(R1), 0)} would put buyers in control; next resistance ${nf(r0(R2), 0)}. Session high: ${nf(spx.high)}.` };
const bear = { level: `Below ${nf(r0(S1), 0)}`, text: `Slipping under the pivot support ${nf(r0(S1), 0)} would favor sellers; next support ${nf(r0(S2), 0)}. Session low: ${nf(spx.low)}.` };
const pivots = { P: Math.round(P), R1: r0(R1), R2: r0(R2), S1: r0(S1), S2: r0(S2) };

const events = upcomingEvents();
const risks = [];
if (vix) risks.push(vix.pct > 5 ? `VIX jumped ${nf(vix.pct)}% to ${nf(vix.last)}: expect bigger swings` : vix.last > 20 ? `VIX elevated at ${nf(vix.last)}` : `VIX at ${nf(vix.last)} (${pc(vix.pct)})`);
if (tnx && (tnx.bp >= 7 || tnx.last >= 4.75)) risks.push(`10-year Treasury yield at ${nf(tnx.last)}% (${tnx.bp >= 0 ? '+' : '−'}${nf(Math.abs(tnx.bp), 0)} bp): high yields pressure valuations`);
const nextFed = events.find((e) => /FOMC/.test(e.label));
if (nextFed && (Date.parse(nextFed.date) - Date.parse(etNow.date)) / 864e5 <= 14) risks.push(`Fed decision on ${nextFed.when}: rate-sensitive stocks may swing`);
const brent = asset('Brent'); if (brent && (brent.last > 90 || Math.abs(brent.pct) > 2)) risks.push(`Brent crude at $${nf(brent.last)} (${pc(brent.pct)}) feeds inflation worries`);
const dxy = asset('US Dollar Index'); if (dxy && Math.abs(dxy.pct) > 0.5) risks.push(`Dollar index ${pc(dxy.pct)} to ${nf(dxy.last)}: watch multinationals' earnings`);
if (dec > adv * 1.5) risks.push(`Weak breadth: ${dec} of ${tracked.length} tracked stocks are down`);
if (rut && spx && rut.pct < spx.pct - 1) risks.push(`Small caps lag: Russell 2000 ${pc(rut.pct)} vs S&P 500 ${pc(spx.pct)}`);
if (spx.hi52 && spx.last < spx.hi52 * 0.9) risks.push(`S&P 500 ${nf((1 - spx.last / spx.hi52) * 100, 1)}% below its 52-week high of ${nf(spx.hi52)}`);
const btc = asset('Bitcoin'); if (btc && Math.abs(btc.pct) > 5) risks.push(`Bitcoin ${pc(btc.pct)}: crypto-linked stocks (COIN, MSTR, HOOD) may be volatile`);

const conclusion = `The S&P 500 ${verb} ${nf(Math.abs(p))}% at ${nf(spx.last)}${nas ? `, Nasdaq ${pc(nas.pct)}` : ''}. ` +
  `Breadth: ${adv} up, ${dec} down among ${tracked.length} tracked stocks. ` +
  `Watch ${nf(r0(S1), 0)} support and ${nf(r0(R1), 0)} resistance${open ? '' : ' next session'}.`;

// ---------- reasons: only real headlines that clearly name the company ----------
// Case-sensitive name patterns. Short or common-word tickers (A, T, ON, ALL, NOW, ...) are never matched as plain words.
const KEYS = {
  AAPL: 'Apple', MSFT: 'Microsoft', NVDA: 'Nvidia|NVIDIA', AMZN: 'Amazon', GOOGL: 'Alphabet|Google', META: 'Meta(?! ?[a-z])|Facebook|Instagram',
  AVGO: 'Broadcom', TSLA: 'Tesla', 'BRK-B': 'Berkshire', JPM: '!JPMorgan|JP Morgan|Dimon', LLY: 'Eli Lilly|Lilly', V: "Visa(?:'s)? (?:Inc|shares|stock|earnings|profit|revenue|CEO)|Visa,? (?:and )?Mastercard",
  MA: 'Mastercard', UNH: 'UnitedHealth', XOM: 'Exxon', JNJ: 'Johnson & Johnson|J&J', WMT: 'Walmart', PG: 'Procter|P&G', HD: 'Home Depot', COST: 'Costco',
  ORCL: 'Oracle', ABBV: 'AbbVie', BAC: '!Bank of America|BofA', KO: 'Coca-Cola|Coke', NFLX: 'Netflix', CVX: 'Chevron', MRK: 'Merck', PEP: 'PepsiCo|Pepsi',
  AMD: 'AMD|Advanced Micro', CRM: 'Salesforce', ADBE: 'Adobe', TMO: 'Thermo Fisher', LIN: 'Linde', ACN: 'Accenture', MCD: "McDonald's", CSCO: 'Cisco',
  ABT: 'Abbott', WFC: '!Wells Fargo', IBM: 'IBM', GE: 'GE Aerospace', DHR: 'Danaher', QCOM: 'Qualcomm', TXN: 'Texas Instruments', INTU: 'Intuit',
  AMGN: 'Amgen', PM: 'Philip Morris', CAT: 'Caterpillar', ISRG: 'Intuitive Surgical', VZ: 'Verizon', NOW: 'ServiceNow', GS: '!Goldman', DIS: 'Disney',
  AXP: 'American Express|Amex', SPGI: 'S&P Global', RTX: 'RTX|Raytheon', T: 'AT&T', MS: '!Morgan Stanley', NEE: 'NextEra', LOW: "Lowe's", PFE: 'Pfizer',
  UNP: 'Union Pacific', BKNG: 'Booking Holdings', HON: 'Honeywell', CMCSA: 'Comcast', C: '!Citigroup|Citi', BLK: '!BlackRock', SCHW: 'Schwab',
  PLTR: 'Palantir', UBER: 'Uber', COP: 'ConocoPhillips', DE: 'Deere', LMT: 'Lockheed', GILD: 'Gilead', SBUX: 'Starbucks', BA: 'Boeing', MDT: 'Medtronic',
  ADP: 'Automatic Data Processing', MO: 'Altria', BMY: 'Bristol[- ]Myers', CVS: 'CVS', TMUS: 'T-Mobile', SO: 'Southern Co(?:mpany)?\\b', DUK: 'Duke Energy',
  MMM: '3M', GD: 'General Dynamics', UPS: 'UPS', FDX: 'FedEx', TGT: "Target(?:'s| Corp| stock| shares| earnings| sales| CEO)", NKE: 'Nike', INTC: 'Intel',
  MU: 'Micron', AMAT: 'Applied Materials', LRCX: 'Lam Research', KLAC: 'KLA', PANW: 'Palo Alto Networks', CRWD: 'CrowdStrike', ANET: 'Arista',
  SNOW: 'Snowflake', SHOP: 'Shopify', COIN: 'Coinbase', MSTR: 'MicroStrategy|Strategy Inc|Saylor', SMCI: 'Super Micro|Supermicro',
  ARM: "Arm Holdings|Arm(?:'s)? (?:shares|stock|CEO)", HOOD: 'Robinhood', PYPL: 'PayPal', XYZ: 'Block Inc|Cash App', SOFI: 'SoFi', RIVN: 'Rivian',
  F: 'Ford', GM: 'General Motors|GM', USB: 'U\\.?S\\.? Bancorp', PNC: 'PNC', COF: 'Capital One', MET: 'MetLife', AIG: 'AIG', BK: 'BNY|Bank of New York',
  SPG: 'Simon Property', AMT: 'American Tower', CL: 'Colgate', MDLZ: 'Mondelez', KHC: 'Kraft Heinz', CHTR: 'Charter Communications', EMR: 'Emerson',
  DELL: 'Dell', APP: 'AppLovin', ABNB: 'Airbnb', DASH: 'DoorDash', TSM: 'TSMC|Taiwan Semiconductor', MRVL: 'Marvell', DDOG: 'Datadog',
  NET: 'Cloudflare', ZS: 'Zscaler', RBLX: 'Roblox', CVNA: 'Carvana', RDDT: 'Reddit',
};
// Banks and asset managers appear constantly as analysts; for them a headline must be about the company itself.
const BANK_CTX = /\b(earnings|profit|results|quarter|revenue|CEO|layoffs?|job cuts|fined?|settle\w*|lawsuit|shares (?:rise|fall|jump|drop|slide|gain|sink|surge)|stock (?:rises|falls|jumps|drops|slides|gains|sinks|surges))\b/i;
const COMMON = new Set(['ALL', 'NOW', 'LOW', 'CAT', 'NET', 'APP', 'ARM', 'DASH', 'HOOD', 'SNOW', 'COST', 'ADP', 'DELL', 'UBER', 'META', 'SHOP', 'COIN', 'TGT']);
const escRe = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function matcher(sym) {
  let k = KEYS[sym]; let ctx = false;
  if (k && k.startsWith('!')) { ctx = true; k = k.slice(1); }
  const pats = [];
  if (k) pats.push('\\b(?:' + k + ')');
  // explicit ticker forms: "(NVDA)", "NASDAQ:NVDA", "$NVDA"; bare ticker only when long and not a common word
  const t = escRe(sym);
  pats.push(`\\((?:NYSE|NASDAQ|Nasdaq)?:? ?${t}\\)`, `(?:NYSE|NASDAQ|Nasdaq): ?${t}\\b`, `\\$${t}\\b`);
  if (sym.length >= 3 && !COMMON.has(sym) && !KEYS[sym]?.includes(sym)) pats.push(`\\b${t}\\b`);
  const re = new RegExp(pats.join('|')); // case-sensitive on purpose
  return (title) => re.test(title) && (!ctx || BANK_CTX.test(title));
}
const recent = [...all].sort((a, b) => b.ts - a.ts).filter((it) => it.ts && Date.now() - it.ts < 2 * 864e5 && !JUNK_SRC.test(it.src) && !JUNK.test(it.title));
function headlineFor(s) { const m = matcher(s.symbol); const hit = recent.find((it) => m(it.title)); return hit ? hit.title : null; }
const short = (s, n = 90) => s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
const reasons = (list) => Object.fromEntries((list ?? []).slice(0, 10).map((s) => { const h = headlineFor(s); return [s.symbol, h ? 'In news: ' + short(h) : '']; }).filter(([, v]) => v));
const gainerReasons = reasons(D.gainers), loserReasons = reasons(D.losers);

const trending = [];
const addT = (s, why) => { if (s && !trending.some((t) => t.symbol === s.symbol)) { const h = headlineFor(s); trending.push({ symbol: s.symbol, reason: why + (h ? '. In news: ' + short(h, 70) : '') }); } };
(D.gainers ?? []).slice(0, 3).forEach((s, i) => addT(s, `Up ${nf(s.pct)}%${i === 0 ? ', top gainer' : ''}`));
(D.losers ?? []).slice(0, 3).forEach((s, i) => addT(s, `Down ${nf(Math.abs(s.pct))}%${i === 0 ? ', top loser' : ''}`));
(D.mostActive ?? []).slice(0, 4).forEach((s) => addT(s, `Most traded: $${nf(s.valueM >= 1000 ? s.valueM / 1000 : s.valueM, s.valueM >= 1000 ? 1 : 0)}${s.valueM >= 1000 ? 'B' : 'M'} (${pc(s.pct)})`));

const day1 = recent.filter((it) => Date.now() - it.ts < 864e5);
const firstHit = (re) => { const h = day1.find((it) => re.test(it.title)); return h ? 'In news: ' + short(h.title, 80) : ''; };
const SECTOR_KEYS = {
  Technology: /\b(tech stocks|tech shares|chip ?stocks|chipmakers?|semiconductors?|Nvidia|Apple|Microsoft|Broadcom)\b/i,
  Financials: /\b(bank stocks|bank shares|regional banks|lenders|financials|financial stocks)\b/i,
  'Health Care': /\b(health ?care|drugmakers?|pharma\w*|biotech|FDA|UnitedHealth|Eli Lilly|Pfizer|Merck)\b/i,
  Energy: /\b(oil|crude|OPEC|energy stocks|Exxon|Chevron|natural gas)\b/i,
  'Consumer Discretionary': /\b(retailers?|consumer spending|Amazon|Tesla|Home Depot|Nike|automakers?)\b/i,
  'Consumer Staples': /\b(consumer staples|Walmart|Costco|Procter|PepsiCo|Coca-Cola|grocer)\b/i,
  Industrials: /\b(industrials|Boeing|Caterpillar|airlines?|railroads?|defen[cs]e stocks|GE Aerospace)\b/i,
  Materials: /\b(materials|copper|steel|mining stocks|miners|chemicals?)\b/i,
  Utilities: /\b(utilities|power demand|NextEra|Duke Energy)\b/i,
  'Real Estate': /\b(REITs?|real estate stocks|commercial real estate)\b/i,
  'Communication Services': /\b(Alphabet|Google|Meta|Netflix|Disney|telecom|streaming)\b/,
};
const sectorReasons = Object.fromEntries(secs.map((s) => [s.name, SECTOR_KEYS[s.name] ? firstHit(SECTOR_KEYS[s.name]) : '']).filter(([, v]) => v));
const ASSET_KEYS = { Gold: /\bgold\b/i, Silver: /\bsilver\b/i, Brent: /\b(oil|crude|Brent|OPEC)\b/i, 'Crude (WTI)': /\b(oil|crude|WTI|OPEC)\b/i,
  'Natural gas': /\bnatural gas\b/i, Bitcoin: /\bbitcoin\b/i, Ethereum: /\b(ether|ethereum)\b/i, 'US Dollar Index': /\b(dollar index|U\.?S\.? dollar|greenback)\b/i,
  'EUR/USD': /\beuro\b/i, 'USD/JPY': /\byen\b/i, 'USD/INR': /\brupee\b/i };
const assetReasons = Object.fromEntries(Object.entries(ASSET_KEYS).map(([k, re]) => [k, firstHit(re)]).filter(([, v]) => v));

// ---------- IPOs, dividends and stock splits (Nasdaq calendars) ----------
// Nasdaq may refuse Google's servers; then the copy published on GitHub Pages (refreshed by the workflow) is used.
const NQ = 'https://api.nasdaq.com/api';
const NQH = { headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' } };
const PUB = 'https://ashutoshgupta26.github.io/growebtek-stock-analyzer/us/news.json';
let pubCache;
async function pubNews() { if (pubCache === undefined) { pubCache = null; try { const r = await get(PUB + '?t=' + Math.floor(Date.now() / 6e5), { headers: { Accept: 'application/json' } }, 1); if (r) pubCache = await r.json(); } catch {} } return pubCache; }
async function nq(path) { try { const r = await get(NQ + path, NQH, 2); if (!r) return null; const j = await r.json(); return j?.data ?? null; } catch { return null; } }
const mdy = (s) => { const m = String(s ?? '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };
const num = (s) => { const x = parseFloat(String(s ?? '').replace(/[$,]/g, '')); return Number.isFinite(x) ? x : null; };
const ym = (iso) => iso.slice(0, 7);
const months = [ym(addDays(etNow.date, -20)), ym(etNow.date), ym(addDays(etNow.date, 25))].filter((m, i, a) => a.indexOf(m) === i);
const divDays = []; for (let i = 0; divDays.length < 10 && i < 20; i++) { const d = addDays(etNow.date, i); if (isTrading(d)) divDays.push(d); }
typeof prefetch === 'function' && prefetch([...months.map((m) => NQ + '/ipo/calendar?date=' + m), ...divDays.map((d) => NQ + '/calendar/dividends?date=' + d), NQ + '/calendar/splits'].map((u) => [u, NQH]));
const ipoCal = await Promise.all(months.map((m) => nq('/ipo/calendar?date=' + m)));
const divCal = await Promise.all(divDays.map((d) => nq('/calendar/dividends?date=' + d)));
const splitCal = await nq('/calendar/splits');
const ipoOk = ipoCal.some(Boolean), divOk = divCal.some(Boolean);
const ipoName = (s) => String(s ?? '').replace(/\s+(Common Stock.*|Class [A-Z] (?:Common|Ordinary).*|Ordinary Shares.*|American Depositary Shares.*)$/i, '').trim();
const SPAC = /Acquisition|SPAC|Capital Corp\.? [IVX]+\b|Merger Corp/i;
const ipoBase = (r) => ({ symbol: r.proposedTickerSymbol || null, name: ipoName(r.companyName), exchange: r.proposedExchange || null, spac: SPAC.test(r.companyName ?? ''),
  shares: num(r.sharesOffered), sizeM: num(r.dollarValueOfSharesOffered) != null ? Math.round(num(r.dollarValueOfSharesOffered) / 1e5) / 10 : null,
  url: r.proposedTickerSymbol ? `https://www.nasdaq.com/market-activity/ipos/overview?dealId=${r.dealID}` : null });
const seenDeal = new Set();
const once = (r) => { if (seenDeal.has(r.dealID)) return false; seenDeal.add(r.dealID); return true; };
let usIpoPriced = ipoCal.flatMap((c) => c?.priced?.rows ?? []).filter(once)
  .map((r) => ({ ...ipoBase(r), price: num(r.proposedSharePrice), date: mdy(r.pricedDate) }))
  .filter((r) => r.date && r.date >= addDays(etNow.date, -21) && r.date <= etNow.date).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15);
let usIpoUpcoming = ipoCal.flatMap((c) => c?.upcoming?.upcomingTable?.rows ?? []).filter(once)
  .map((r) => ({ ...ipoBase(r), priceRange: r.proposedSharePrice || null, date: mdy(r.expectedPriceDate) }))
  .filter((r) => !r.date || r.date >= addDays(etNow.date, -1)).sort((a, b) => (a.date ?? '9').localeCompare(b.date ?? '9')).slice(0, 15);
let usIpoFiled = ipoCal.flatMap((c) => c?.filed?.rows ?? []).filter(once)
  .map((r) => ({ ...ipoBase(r), date: mdy(r.filedDate) })).filter((r) => r.date).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
const trackedSet = new Set(tracked.map((s) => s.symbol));
const NOT_COMMON = /Preferred|Depositary Shares? Represent|Notes? due|\bNotes\b|Debentures|Perpetual|Senior|Subordinated|Trust Preferred|Warrant|\bUnits?\b|Baby Bond|Fixed[- ]to[- ]Floating|Series [A-Z]\b/i;
const FUND = /\bETF\b|\bFund\b|Trust\b.*(?:Income|Municipal|Opportunit)|Shares Trust|Strategy|Portfolio|Closed[- ]End|BDC|Municipal|Income Fund|Calamos|Strategic Total Return|Income Builder|Long\/Short|Opportunit(?:y|ies)\b|Dynamic Income|Covered Call|Closed End/i;
let usDividends = divCal.flatMap((c) => c?.calendar?.rows ?? [])
  .filter((r) => r.symbol && !/[\^\/.]/.test(r.symbol) && !NOT_COMMON.test(r.companyName ?? '') && !FUND.test(r.companyName ?? '') && r.dividend_Rate > 0)
  .map((r) => ({ symbol: r.symbol, name: ipoName(r.companyName), exDate: mdy(r.dividend_Ex_Date), payDate: mdy(r.payment_Date), recDate: mdy(r.record_Date),
    annDate: mdy(r.announcement_Date), amount: r.dividend_Rate, annual: r.indicated_Annual_Dividend > 0 ? r.indicated_Annual_Dividend : null, tracked: trackedSet.has(r.symbol) }))
  .filter((r, i, a) => r.exDate && a.findIndex((x) => x.symbol === r.symbol) === i);
let usSplits = (splitCal?.rows ?? []).map((r) => {
  const m = String(r.ratio ?? '').match(/([\d.]+)\s*:\s*([\d.]+)/); const a = m ? +m[1] : null, b = m ? +m[2] : null;
  return { symbol: r.symbol, name: ipoName(r.name), ratio: a && b ? `${a}-for-${b}` : r.ratio, kind: a && b ? (a > b ? 'Forward split' : a < b ? 'Reverse split' : 'Split') : 'Split',
    date: mdy(r.executionDate), tracked: trackedSet.has(r.symbol), url: `https://www.nasdaq.com/market-activity/stocks/${String(r.symbol).toLowerCase()}` };
}).filter((r) => r.symbol && r.date && r.date >= addDays(etNow.date, -7)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 15);
// Live prices: yield for dividend payers, return since IPO price for new listings
const YQ = 'https://query1.finance.yahoo.com/v7/finance/spark?range=1d&interval=5m&symbols=';
const pxOf = {};
for (const s of tracked) if (s.ltp) pxOf[s.symbol] = s.ltp;
const needPx = [...new Set([...usDividends.map((r) => r.symbol), ...usIpoPriced.map((r) => r.symbol), ...usSplits.map((r) => r.symbol)].filter((s) => s && !pxOf[s]))].slice(0, 100);
const pxUrls = []; for (let i = 0; i < needPx.length; i += 20) pxUrls.push(YQ + encodeURIComponent(needPx.slice(i, i + 20).join(',')));
typeof prefetch === 'function' && prefetch(pxUrls.map((u) => [u, { headers: { 'User-Agent': UA, Accept: 'application/json' } }]));
const pxPct = {};
for (const u of pxUrls) {
  try {
    const r = await get(u, { headers: { Accept: 'application/json' } }, 1); if (!r) continue;
    const j = await r.json();
    for (const x of j?.spark?.result ?? []) { const m = x.response?.[0]?.meta; if (m?.regularMarketPrice != null) { pxOf[x.symbol] = m.regularMarketPrice; const p = m.chartPreviousClose ?? m.previousClose; if (p) pxPct[x.symbol] = (m.regularMarketPrice - p) / p * 100; } }
  } catch {}
}
for (const s of tracked) if (s.pct != null) pxPct[s.symbol] = s.pct;
const r2 = (x) => x == null ? null : Math.round(x * 100) / 100;
usIpoPriced = usIpoPriced.map((r) => ({ ...r, last: pxOf[r.symbol] ?? null, gainPct: pxOf[r.symbol] && r.price ? r2((pxOf[r.symbol] - r.price) / r.price * 100) : null }));
usDividends = usDividends.map((r) => ({ ...r, price: pxOf[r.symbol] ?? null, pctChg: r2(pxPct[r.symbol]), yieldPct: pxOf[r.symbol] && r.annual ? r2(r.annual / pxOf[r.symbol] * 100) : null }))
  .filter((r) => r.tracked || (r.price != null && r.price >= 5))
  .sort((a, b) => a.exDate.localeCompare(b.exDate) || (b.tracked - a.tracked) || ((b.yieldPct ?? 0) - (a.yieldPct ?? 0))).slice(0, 30);
usSplits = usSplits.map((r) => ({ ...r, price: pxOf[r.symbol] ?? null }));
// Fall back to the last good copy if Nasdaq did not answer
if (!ipoOk || !divOk || !splitCal) {
  const pub = await pubNews();
  const live = (a, k = 'date') => (a ?? []).filter((r) => !r[k] || r[k] >= addDays(etNow.date, -21));
  if (!ipoOk) { errors.push('ipo calendar'); usIpoPriced = live(pub?.usIpoPriced ?? prev.usIpoPriced); usIpoUpcoming = live(pub?.usIpoUpcoming ?? prev.usIpoUpcoming); usIpoFiled = pub?.usIpoFiled ?? prev.usIpoFiled ?? []; }
  if (!divOk) { errors.push('dividend calendar'); usDividends = (pub?.usDividends ?? prev.usDividends ?? []).filter((r) => r.exDate >= etNow.date); }
  if (!splitCal) { errors.push('split calendar'); usSplits = live(pub?.usSplits ?? prev.usSplits); }
}

const hhmm = clock(etNow.min);
const out = {
  asOf: D.market?.sessionDate ?? null,
  asOfLabel: open ? `${sdLabel}, ${hhmm} ET` : `${sdLabel}, ${closeLbl}`,
  session: open ? `Live · ${hhmm} ET` : D.market?.status === 'pre' ? 'Pre-market · last session report'
    : (D.market?.sessionDate === etNow.date ? `Closing Report · ${closeLbl}` : 'Last session report'),
  mood, summary, conclusion, bull, bear, pivots, risks: risks.slice(0, 6), events,
  trending, gainerReasons, loserReasons, sectorReasons, assetReasons,
  stockNews: stockNews.map(slim), econNews: econNews.map(slim), earnings: earnings.map(slim), analyst: analyst.map(slim),
  ipoNews: ipoNews.map(slim), commodNews: commodNews.map(slim),
  usIpoPriced, usIpoUpcoming, usIpoFiled, usDividends, usSplits,
  nextSession: nextSession(),
  generated: 'Automatic: headlines from CNBC, MarketWatch, Seeking Alpha, Nasdaq, Yahoo Finance and Google News RSS; IPO, dividend and split calendars from Nasdaq; summary, mood and levels computed from prices.',
};
// Keep the previous headlines for any section that came back empty this run
for (const k of ['stockNews', 'econNews', 'earnings', 'analyst', 'ipoNews', 'commodNews']) if (!out[k].length && prev[k]?.length) out[k] = prev[k];

const strip = (o) => { const { asOfLabel, session, updated, errors: _e, ...rest } = o ?? {}; return JSON.stringify(rest); };
if (strip(out) === strip(prev) && out.session === prev.session) { console.log('No news changes; us/news.json unchanged.'); process.exit(0); }
out.updated = new Date().toISOString();
out.errors = errors;
writeFileSync(NEWS, JSON.stringify(out, null, 1) + '\n');
console.log(`Wrote us/news.json: ${stockNews.length} stock, ${econNews.length} econ, ${earnings.length} earnings, ${analyst.length} analyst, ` +
  `${ipoNews.length} IPO, ${commodNews.length} commodities headlines; ${usIpoPriced.length}/${usIpoUpcoming.length} IPOs, ${usDividends.length} dividends, ${usSplits.length} splits; mood=${mood}${errors.length ? '; errors: ' + errors.join(', ') : ''}`);
