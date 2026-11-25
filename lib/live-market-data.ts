import type { StoredSparkline, StoredDataPoint } from './types'
import { fetchFREDSeries, fetchFREDSparkline } from './fred'

// Live market series for a brief: macro indicators, the company's own stock, its
// competitors and customers, the commodities it depends on, and the currencies of
// the countries it is exposed to.
//
// Which source serves what (each verified against the production keys on 2026-11-25):
//   FRED            indices (S&P 500, Nasdaq, VIX, Nikkei), the dollar, oil and gas, most
//                   currencies, and the IMF monthly commodity prices (copper, aluminium,
//                   nickel, zinc, iron ore, tin, uranium, grains, sugar, coffee, cotton,
//                   rubber) plus the US steel price index. Free and reliable.
//   FMP (free plan) a handful of large US stocks only; most symbols answer HTTP 402.
//   Alpha Vantage   daily closes for individual stocks (25 requests a day, 1 a second),
//                   so it is reserved for the company, competitors and customers.
//   Finnhub         its candle endpoints are premium (403), so they are not used here.
//
// Every provider failure is recorded in the optional `diag` list (short, key-free
// messages) so a missing chart can be explained instead of guessed at. Nothing in
// here ever invents a number: if a series cannot be fetched it is simply absent.

const AV_KEY  = process.env.ALPHA_VANTAGE_KEY
const FMP_KEY = process.env.FMP_API_KEY
// FMP retired its old /api/v3 endpoints for accounts created after Aug 2025; the
// "stable" API below is the supported replacement.
const FMP_BASE = 'https://financialmodelingprep.com/stable'

type Diag = string[] | undefined

function note(diag: Diag, message: string) {
  if (!diag || diag.length >= 40) return
  diag.push(message.replace(/(apikey|api_key|token)=[^&\s"]+/gi, '$1=***').slice(0, 160))
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// Alpha Vantage's free tier answers bursts (more than about one request a second) with
// "please spread out your requests". Calls take turns, 1.2 seconds apart.
let avQueue: Promise<void> = Promise.resolve()
function avGate(): Promise<void> {
  const turn = avQueue.then(() => sleep(1_200))
  avQueue = turn
  return turn
}

async function getJson(url: string, diag: Diag, label: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(12_000) })
    if (!res.ok) { note(diag, `${label}: HTTP ${res.status}`); return null }
    const json = (await res.json()) as unknown
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      const o = json as Record<string, unknown>
      const msg = o['Error Message'] ?? o['Note'] ?? o['Information'] ?? o['message'] ?? o['error']
      if (msg) { note(diag, `${label}: ${String(msg)}`); return null }
    }
    return json
  } catch (err) {
    note(diag, `${label}: ${err instanceof Error ? err.message : 'request failed'}`)
    return null
  }
}

function toDataPoint(date: string, value: number): StoredDataPoint {
  return {
    date: new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
    value,
  }
}

function buildSparkline(label: string, ticker: string, unit: string, data: StoredDataPoint[]): StoredSparkline {
  const current = data[data.length - 1]?.value ?? 0
  const open    = data[0]?.value ?? current
  const pct     = open !== 0 ? Math.round(((current - open) / open) * 10000) / 100 : 0
  return { label, ticker, unit, data, current, open, pct, up: current >= open }
}

// ── Providers ─────────────────────────────────────────────────────────────────

interface FmpEodRow { date?: string; close?: number | string; price?: number | string }

/** Daily closes from FMP's stable API (free plan: a handful of large US stocks only). */
async function fetchFMPEod(symbol: string, label: string, ticker: string, diag: Diag): Promise<StoredSparkline | null> {
  if (!FMP_KEY) { note(diag, 'FMP: no API key configured'); return null }
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const from = iso(new Date(Date.now() - 45 * 86_400_000))
  const to   = iso(new Date())
  const url  = `${FMP_BASE}/historical-price-eod/light?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&apikey=${FMP_KEY}`
  const json = await getJson(url, diag, `FMP ${symbol}`)
  if (!Array.isArray(json)) return null
  const rows = (json as FmpEodRow[])
    .map(r => ({ date: String(r.date ?? ''), value: Number(r.close ?? r.price) }))
    .filter(r => r.date && Number.isFinite(r.value))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30)
  if (rows.length < 2) { note(diag, `FMP ${symbol}: no price history returned`); return null }
  return buildSparkline(label, ticker, '', rows.map(r => toDataPoint(r.date, r.value)))
}

/** Alpha Vantage daily closes (free tier: 25 requests a day, so used sparingly). */
async function fetchAVDaily(symbol: string, label: string, ticker: string, diag: Diag): Promise<StoredSparkline | null> {
  if (!AV_KEY) return null
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=compact&apikey=${AV_KEY}`
  await avGate()
  const json = (await getJson(url, diag, `AlphaVantage ${symbol}`)) as Record<string, Record<string, Record<string, string>>> | null
  const series = json?.['Time Series (Daily)']
  if (!series) return null
  const data = Object.entries(series)
    .slice(0, 30).reverse()
    .map(([date, v]) => ({ date, value: parseFloat(v['4. close']) }))
    .filter(p => Number.isFinite(p.value))
    .map(p => toDataPoint(p.date, p.value))
  return data.length >= 2 ? buildSparkline(label, ticker, '', data) : null
}

async function fetchAVFX(from: string, to: string, diag: Diag): Promise<StoredSparkline | null> {
  if (!AV_KEY) return null
  const url = `https://www.alphavantage.co/query?function=FX_DAILY&from_symbol=${from}&to_symbol=${to}&outputsize=compact&apikey=${AV_KEY}`
  await avGate()
  const json = (await getJson(url, diag, `AlphaVantage ${from}/${to}`)) as Record<string, Record<string, Record<string, string>>> | null
  const series = json?.['Time Series FX (Daily)']
  if (!series) return null
  const data = Object.entries(series)
    .slice(0, 30).reverse()
    .map(([date, v]) => toDataPoint(date, parseFloat(v['4. close'])))
  return buildSparkline(`${from}/${to}`, `${from}/${to}`, '', data)
}

/** FMP first, then (optionally) Alpha Vantage. Used for individual stocks and ETFs. */
async function fetchEquity(
  symbol: string, label: string, ticker: string, diag: Diag, opts: { alphaVantage?: boolean } = {},
): Promise<StoredSparkline | null> {
  const fromFmp = await fetchFMPEod(symbol, label, ticker, diag)
  if (fromFmp) return fromFmp
  if (opts.alphaVantage) return fetchAVDaily(symbol, label, ticker, diag)
  return null
}

/** Try each async factory in order, return first non-null result */
async function firstOf<T>(...fns: (() => Promise<T | null>)[]): Promise<T | null> {
  for (const fn of fns) {
    const result = await fn()
    if (result !== null) return result
  }
  return null
}

// ── Ticker lookup ─────────────────────────────────────────────────────────────

const GENERIC_NAME_WORDS = new Set([
  'inc', 'corp', 'corporation', 'ltd', 'limited', 'plc', 'llc', 'co', 'company', 'group', 'holdings',
  'holding', 'technologies', 'technology', 'international', 'partners', 'the', 'and', 'ag', 'sa', 'nv', 'se',
])

function significantWords(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !GENERIC_NAME_WORDS.has(w))
}

/** A ticker the profile supplied, cleaned up ("NYSE:ST" → "ST"), or null. */
function cleanTicker(raw: string | undefined | null): string | null {
  if (!raw) return null
  const t = raw.trim().replace(/^[A-Za-z]+:/, '').toUpperCase()
  return /^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(t) ? t : null
}

interface FmpSearchRow { symbol?: string; name?: string; exchange?: string; exchangeFullName?: string }

/**
 * Look up a listed company by name. Only a name that really matches is accepted:
 * charting the wrong company under a competitor's name is worse than no chart.
 */
async function searchFMPTicker(companyName: string, diag: Diag): Promise<string | null> {
  if (!FMP_KEY) return null
  const words = significantWords(companyName)
  const primary = words[0]
  if (!primary || primary.length <= 3) {
    note(diag, `Ticker lookup skipped for "${companyName.slice(0, 40)}": name too short to match safely (add a ticker in the profile)`)
    return null
  }
  const url = `${FMP_BASE}/search-name?query=${encodeURIComponent(primary)}&limit=15&apikey=${FMP_KEY}`
  const json = await getJson(url, diag, `FMP search "${primary}"`)
  if (!Array.isArray(json)) return null
  const rows = (json as FmpSearchRow[]).filter(r => r.symbol && r.name)
  const matches = rows.filter(r => {
    const candidate = significantWords(r.name ?? '')
    return candidate[0] === primary && (words.length < 2 || candidate.includes(words[1]) || candidate.length === 1)
  })
  const isUS = (r: FmpSearchRow) => /NASDAQ|NYSE|AMEX/i.test(`${r.exchange ?? ''} ${r.exchangeFullName ?? ''}`)
  const hit = matches.find(isUS) ?? matches[0]
  if (!hit) note(diag, `Ticker lookup: no listed company named "${companyName.slice(0, 40)}"`)
  return hit?.symbol ?? null
}

// ── Commodities ───────────────────────────────────────────────────────────────

interface FredSeriesDef { id: string; label: string; ticker: string; unit: string; monthly?: boolean }

interface CommodityDef {
  names: string[]
  fred?: FredSeriesDef
  /** Last resort for things FRED has no price for (an ETF on FMP's free plan, which mostly refuses). */
  etf?: { symbol: string; label: string; ticker: string }
}

// Order matters: the first definition whose name appears in a profile entry wins.
// IMF monthly prices come through FRED (series P…USDM); each chart shows 12 months.
const COMMODITIES: CommodityDef[] = [
  { names: ['brent'],                        fred: { id: 'DCOILBRENTEU', label: 'Brent oil',        ticker: 'BRENT', unit: '$/bbl' } },
  { names: ['oil', 'crude', 'petroleum'],    fred: { id: 'DCOILWTICO',   label: 'WTI oil',          ticker: 'WTI',   unit: '$/bbl' } },
  { names: ['natural gas', 'natgas', 'lng'], fred: { id: 'DHHNGSP',      label: 'Natural gas (Henry Hub)', ticker: 'NG', unit: '$/MMBtu' } },
  { names: ['copper'],                       fred: { id: 'PCOPPUSDM',    label: 'Copper (monthly)',    ticker: 'CU',  unit: '$/t', monthly: true } },
  { names: ['aluminium', 'aluminum'],        fred: { id: 'PALUMUSDM',    label: 'Aluminium (monthly)', ticker: 'AL',  unit: '$/t', monthly: true } },
  { names: ['nickel'],                       fred: { id: 'PNICKUSDM',    label: 'Nickel (monthly)',    ticker: 'NI',  unit: '$/t', monthly: true } },
  { names: ['zinc'],                         fred: { id: 'PZINCUSDM',    label: 'Zinc (monthly)',      ticker: 'ZN',  unit: '$/t', monthly: true } },
  { names: ['tin'],                          fred: { id: 'PTINUSDM',     label: 'Tin (monthly)',       ticker: 'SN',  unit: '$/t', monthly: true } },
  { names: ['iron ore'],                     fred: { id: 'PIORECRUSDM',  label: 'Iron ore (monthly)',  ticker: 'FE',  unit: '$/t', monthly: true } },
  { names: ['steel', 'rebar'],               fred: { id: 'WPU101',       label: 'Steel prices, US index (monthly)', ticker: 'STEEL', unit: 'index', monthly: true } },
  { names: ['uranium'],                      fred: { id: 'PURANUSDM',    label: 'Uranium (monthly)',   ticker: 'U',   unit: '$/lb', monthly: true } },
  { names: ['wheat'],                        fred: { id: 'PWHEAMTUSDM',  label: 'Wheat (monthly)',     ticker: 'WHEAT', unit: '$/t', monthly: true } },
  { names: ['corn', 'maize'],                fred: { id: 'PMAIZMTUSDM',  label: 'Corn (monthly)',      ticker: 'CORN', unit: '$/t', monthly: true } },
  { names: ['sugar'],                        fred: { id: 'PSUGAISAUSDM', label: 'Sugar (monthly)',     ticker: 'SUGAR', unit: '¢/lb', monthly: true } },
  { names: ['coffee'],                       fred: { id: 'PCOFFOTMUSDM', label: 'Coffee (monthly)',    ticker: 'COFFEE', unit: '¢/lb', monthly: true } },
  { names: ['cotton'],                       fred: { id: 'PCOTTINDUSDM', label: 'Cotton (monthly)',    ticker: 'COTTON', unit: '¢/lb', monthly: true } },
  { names: ['rubber'],                       fred: { id: 'PRUBBUSDM',    label: 'Rubber (monthly)',    ticker: 'RUBBER', unit: '¢/kg', monthly: true } },
  { names: ['gold'],                         etf: { symbol: 'GLD',  label: 'Gold (GLD)',        ticker: 'GLD'  } },
  { names: ['silver'],                       etf: { symbol: 'SLV',  label: 'Silver (SLV)',      ticker: 'SLV'  } },
  { names: ['platinum'],                     etf: { symbol: 'PPLT', label: 'Platinum (PPLT)',   ticker: 'PPLT' } },
  { names: ['palladium'],                    etf: { symbol: 'PALL', label: 'Palladium (PALL)',  ticker: 'PALL' } },
  { names: ['lithium'],                      etf: { symbol: 'LIT',  label: 'Lithium (LIT)',     ticker: 'LIT'  } },
  { names: ['silicon', 'semiconductor', 'semiconductors', 'chips', 'wafer'], etf: { symbol: 'SOXX', label: 'Semis (SOXX)', ticker: 'SOXX' } },
  { names: ['rare earth', 'neodymium'],      etf: { symbol: 'REMX', label: 'Rare earth (REMX)', ticker: 'REMX' } },
]

/** "Steel (rebar)" → steel, "Crude Oil (energy costs)" → oil, "Rare earth elements" → rare earth. */
function resolveCommodity(raw: string): CommodityDef | null {
  const text = ` ${raw.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()} `
  return COMMODITIES.find(def => def.names.some(n => text.includes(` ${n} `))) ?? null
}

async function fetchCommodity(def: CommodityDef, diag: Diag): Promise<StoredSparkline | null> {
  if (def.fred) {
    const f = def.fred
    const s = await fetchFREDSeries(f.id, f.label, f.ticker, f.unit, { points: f.monthly ? 12 : 30, monthly: f.monthly })
    if (s) return s
    note(diag, `FRED ${f.id}: no data returned`)
  }
  if (def.etf) return fetchEquity(def.etf.symbol, def.etf.label, def.etf.ticker, diag)
  return null
}

// ── Currencies of the countries a company touches ─────────────────────────────

interface FxDef {
  key: string
  match: RegExp
  fred?: FredSeriesDef
  /** Alpha Vantage pair, for currencies FRED does not carry (it holds 25 requests a day, so only these). */
  av?: [string, string]
  label: string
  ticker: string
}

// DEX… series from FRED's H.10 release: local currency per US dollar, except the
// pound and euro which are dollars per unit.
const FX: FxDef[] = [
  { key: 'gbpusd', match: /\buk\b|united kingdom|britain|england/, fred: { id: 'DEXUSUK', label: 'GBP/USD', ticker: '£/$', unit: '' }, label: 'GBP/USD', ticker: '£/$' },
  { key: 'usdjpy', match: /japan/,                      fred: { id: 'DEXJPUS', label: 'USD/JPY', ticker: '$/¥', unit: '' }, label: 'USD/JPY', ticker: '$/¥' },
  { key: 'usdcny', match: /china|hong kong/,            fred: { id: 'DEXCHUS', label: 'USD/CNY', ticker: '$/¥', unit: '' }, label: 'USD/CNY', ticker: '$/CNY' },
  { key: 'usdmxn', match: /mexico/,                     fred: { id: 'DEXMXUS', label: 'USD/MXN', ticker: '$/MXN', unit: '' }, label: 'USD/MXN', ticker: '$/MXN' },
  { key: 'usdkrw', match: /korea/,                      fred: { id: 'DEXKOUS', label: 'USD/KRW', ticker: '$/KRW', unit: '' }, label: 'USD/KRW', ticker: '$/KRW' },
  { key: 'usdinr', match: /india/,                      fred: { id: 'DEXINUS', label: 'USD/INR', ticker: '$/INR', unit: '' }, label: 'USD/INR', ticker: '$/INR' },
  { key: 'usdchf', match: /switzerland|swiss/,          fred: { id: 'DEXSZUS', label: 'USD/CHF', ticker: '$/CHF', unit: '' }, label: 'USD/CHF', ticker: '$/CHF' },
  { key: 'usdcad', match: /canada/,                     fred: { id: 'DEXCAUS', label: 'USD/CAD', ticker: '$/CAD', unit: '' }, label: 'USD/CAD', ticker: '$/CAD' },
  { key: 'usdbrl', match: /brazil/,                     fred: { id: 'DEXBZUS', label: 'USD/BRL', ticker: '$/BRL', unit: '' }, label: 'USD/BRL', ticker: '$/BRL' },
  { key: 'usdils', match: /israel/,                     av: ['USD', 'ILS'], label: 'USD/ILS', ticker: '$/₪' },
]

// ── Peers (competitors, customers) ────────────────────────────────────────────

interface Peer { name: string; ticker?: string }

async function peerChart(kind: 'competitor' | 'customer', peer: Peer, diag: Diag): Promise<[string, StoredSparkline] | null> {
  if (!peer.name) return null
  const symbol = cleanTicker(peer.ticker) ?? (await searchFMPTicker(peer.name, diag))
  if (!symbol) return null
  const series = await fetchEquity(symbol, peer.name, symbol, diag, { alphaVantage: true })
  if (!series) return null
  const slug = peer.name.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 20)
  return [`${kind}_${slug}`, series]
}

/** Work through the list in small batches until `want` charts are found. */
async function collectPeers(
  kind: 'competitor' | 'customer', peers: Peer[], want: number, diag: Diag, deadline: number,
): Promise<Record<string, StoredSparkline>> {
  const out: Record<string, StoredSparkline> = {}
  for (let i = 0; i < peers.length && Object.keys(out).length < want; i += 2) {
    if (Date.now() > deadline) { note(diag, `${kind} charts stopped early: time budget used`); break }
    const batch = peers.slice(i, i + 2)
    const results = await Promise.all(batch.map(p => peerChart(kind, p, diag).catch(() => null)))
    for (const r of results) {
      if (r && Object.keys(out).length < want) out[r[0]] = r[1]
    }
  }
  return out
}

// ── Main export ───────────────────────────────────────────────────────────────

interface MarketDataOptions {
  stockTicker?: string | null
  companyName?: string
  competitors?: Array<{ name: string; ticker?: string }>
  commodities?: string[]
  locationCountryNames?: string[]
  supplierCountryNames?: string[]
  customers?: Array<{ name: string; ticker?: string }>
  signals?: string
  /** Collects short, key-free provider messages explaining any missing series. */
  diag?: string[]
}

export async function fetchLiveMarketData(
  revenueCountryNames: string[],
  options: MarketDataOptions = {}
): Promise<Record<string, StoredSparkline>> {
  const diag = options.diag
  const deadline = Date.now() + 90_000
  const allCountries = [...revenueCountryNames, ...(options.locationCountryNames ?? []), ...(options.supplierCountryNames ?? [])]
  const lower = allCountries.map(c => c.toLowerCase())

  const snapshots: Record<string, StoredSparkline> = {}

  // ── Wave 1: indices, the dollar, oil (all FRED, no rate limit worth noting) ──
  const [sp500, nasdaq, vix, dxy, eurusd, oil, nikkei] = await Promise.all([
    fetchFREDSeries('SP500', 'S&P 500', 'SPX'),
    fetchFREDSeries('NASDAQCOM', 'Nasdaq Composite', 'IXIC'),
    fetchFREDSeries('VIXCLS', 'VIX (market volatility)', 'VIX'),
    fetchFREDSparkline('dxy'),
    firstOf(() => fetchFREDSparkline('eurusd'), () => fetchAVFX('EUR', 'USD', diag)),
    firstOf(() => fetchFREDSparkline('oil')),
    lower.some(c => c.includes('japan'))
      ? fetchFREDSeries('NIKKEI225', 'Nikkei 225', 'N225')
      : Promise.resolve(null),
  ])
  if (sp500) snapshots['sp500'] = sp500
  if (nasdaq) snapshots['nasdaq'] = nasdaq
  if (vix) snapshots['vix'] = vix
  if (dxy) snapshots['dxy'] = dxy
  if (eurusd) snapshots['eurusd'] = eurusd
  if (oil) snapshots['oil'] = oil
  if (nikkei) snapshots['nikkei'] = nikkei
  if (!sp500) note(diag, 'FRED SP500: no data returned')

  // ── Wave 2: currencies for the countries the company sells to, buys from or operates in ──
  const fxWanted = FX.filter(def => lower.some(c => def.match.test(c)))
  const fxResults = await Promise.all(fxWanted.map(async def => {
    const series = def.fred
      ? await fetchFREDSeries(def.fred.id, def.fred.label, def.fred.ticker, def.fred.unit)
      : null
    return [def, series ?? (def.av ? await fetchAVFX(def.av[0], def.av[1], diag) : null)] as const
  }))
  for (const [def, series] of fxResults) {
    if (series) snapshots[def.key] = { ...series, label: def.label, ticker: def.ticker }
    else note(diag, `No ${def.label} series available`)
  }

  // ── Wave 3: the company itself, competitors, and the commodities it depends on ──
  const { stockTicker, companyName, competitors = [], commodities = [], customers = [] } = options

  if (stockTicker && Date.now() < deadline) {
    const s = await fetchEquity(stockTicker, companyName ?? stockTicker, stockTicker, diag, { alphaVantage: true })
    if (s) snapshots['company_stock'] = s
  }

  if (Date.now() < deadline) {
    Object.assign(snapshots, await collectPeers('competitor', competitors.slice(0, 6), 3, diag, deadline))
  }

  // Up to 4 commodity charts, looking through up to 10 profile entries (many entries,
  // such as "Concrete" or "Glass", have no public price series).
  const seenDefs = new Set<CommodityDef>()
  let charted = 0
  for (const name of commodities.slice(0, 10)) {
    if (charted >= 4 || Date.now() > deadline) break
    const def = resolveCommodity(name)
    if (!def || seenDefs.has(def)) continue
    seenDefs.add(def)
    // WTI oil is already charted in wave 1.
    if (def.fred?.id === 'DCOILWTICO' && snapshots['oil']) { charted++; continue }
    const s = await fetchCommodity(def, diag)
    if (s) {
      charted++
      snapshots[`commodity_${def.names[0].replace(/[^a-z0-9]/g, '_')}`] = s
    } else {
      note(diag, `No price series available for commodity "${name.slice(0, 30)}"`)
    }
  }

  // ── Wave 4: customers ──
  if (Date.now() < deadline) {
    Object.assign(snapshots, await collectPeers('customer', customers.slice(0, 6), 3, diag, deadline))
  }

  console.log(`[market-data] Fetched ${Object.keys(snapshots).length} live series${diag?.length ? `; ${diag.length} provider notes, e.g. ${diag.slice(0, 3).join(' | ')}` : ''}`)
  return snapshots
}
