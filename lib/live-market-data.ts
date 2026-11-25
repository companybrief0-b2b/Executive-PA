import type { StoredSparkline, StoredDataPoint } from './types'
import { fetchStockCandle, fetchForexCandle } from './finnhub'
import { fetchFREDSparkline } from './fred'

// Live market series for a brief: macro indicators, the company's own stock, its
// competitors and customers, the commodities it depends on, and the countries it
// is exposed to.
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

/** Daily closes for any equity or ETF from FMP's stable API. */
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

async function fetchAVCommodity(fn: string, label: string, ticker: string, unit: string, diag: Diag): Promise<StoredSparkline | null> {
  if (!AV_KEY) return null
  const url = `https://www.alphavantage.co/query?function=${fn}&interval=daily&apikey=${AV_KEY}`
  await avGate()
  const json = (await getJson(url, diag, `AlphaVantage ${fn}`)) as { data?: Array<Record<string, string>> } | null
  const entries = (json?.data ?? [])
    .filter(d => d.value !== '.' && Number.isFinite(parseFloat(d.value)))
    .slice(0, 30).reverse()
    .map(d => toDataPoint(d.date, parseFloat(d.value)))
  return entries.length >= 2 ? buildSparkline(label, ticker, unit, entries) : null
}

/** FMP first, then (optionally) Alpha Vantage, then Finnhub candles (premium on most plans). */
async function fetchEquity(
  symbol: string, label: string, ticker: string, diag: Diag, opts: { alphaVantage?: boolean } = {},
): Promise<StoredSparkline | null> {
  const fromFmp = await fetchFMPEod(symbol, label, ticker, diag)
  if (fromFmp) return fromFmp
  if (opts.alphaVantage) {
    const fromAv = await fetchAVDaily(symbol, label, ticker, diag)
    if (fromAv) return fromAv
  }
  const fromFinnhub = await fetchStockCandle(symbol, label, ticker)
  if (!fromFinnhub) note(diag, `Finnhub ${symbol}: no candle data`)
  return fromFinnhub
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

interface CommodityDef {
  names: string[]
  av?: { fn: string; label: string; ticker: string; unit: string }
  etf?: { symbol: string; label: string; ticker: string }
}

// Order matters: the first definition whose name appears in a profile entry wins.
const COMMODITIES: CommodityDef[] = [
  { names: ['brent'],                       av: { fn: 'BRENT',       label: 'Brent Oil', ticker: 'BRENT', unit: '$/bbl'    }, etf: { symbol: 'BNO',  label: 'Brent (BNO)',        ticker: 'BNO'  } },
  { names: ['oil', 'crude', 'petroleum'],   av: { fn: 'WTI',         label: 'WTI Oil',   ticker: 'WTI',   unit: '$/bbl'    }, etf: { symbol: 'USO',  label: 'Oil (USO)',          ticker: 'USO'  } },
  { names: ['natural gas', 'natgas', 'lng'],av: { fn: 'NATURAL_GAS', label: 'Nat. Gas',  ticker: 'NG',    unit: '$/MMBtu'  }, etf: { symbol: 'UNG',  label: 'Nat. Gas (UNG)',     ticker: 'UNG'  } },
  { names: ['copper'],                      av: { fn: 'COPPER',      label: 'Copper',    ticker: 'HG',    unit: '$/t'      }, etf: { symbol: 'CPER', label: 'Copper (CPER)',      ticker: 'CPER' } },
  { names: ['aluminium', 'aluminum'],       av: { fn: 'ALUMINUM',    label: 'Aluminium', ticker: 'ALI',   unit: '$/t'      } },
  { names: ['wheat'],                       av: { fn: 'WHEAT',       label: 'Wheat',     ticker: 'ZW',    unit: ''         }, etf: { symbol: 'WEAT', label: 'Wheat (WEAT)',       ticker: 'WEAT' } },
  { names: ['corn', 'maize'],               av: { fn: 'CORN',        label: 'Corn',      ticker: 'ZC',    unit: ''         }, etf: { symbol: 'CORN', label: 'Corn (CORN)',        ticker: 'CORN' } },
  { names: ['cotton'],                      av: { fn: 'COTTON',      label: 'Cotton',    ticker: 'CT',    unit: ''         }, etf: { symbol: 'BAL',  label: 'Cotton (BAL)',       ticker: 'BAL'  } },
  { names: ['sugar'],                       av: { fn: 'SUGAR',       label: 'Sugar',     ticker: 'SB',    unit: ''         }, etf: { symbol: 'CANE', label: 'Sugar (CANE)',       ticker: 'CANE' } },
  { names: ['coffee'],                      av: { fn: 'COFFEE',      label: 'Coffee',    ticker: 'KC',    unit: ''         }, etf: { symbol: 'JO',   label: 'Coffee (JO)',        ticker: 'JO'   } },
  { names: ['gold'],                        etf: { symbol: 'GLD',  label: 'Gold (GLD)',          ticker: 'GLD'  } },
  { names: ['silver'],                      etf: { symbol: 'SLV',  label: 'Silver (SLV)',        ticker: 'SLV'  } },
  { names: ['platinum'],                    etf: { symbol: 'PPLT', label: 'Platinum (PPLT)',     ticker: 'PPLT' } },
  { names: ['palladium'],                   etf: { symbol: 'PALL', label: 'Palladium (PALL)',    ticker: 'PALL' } },
  { names: ['steel', 'rebar', 'iron ore'],  etf: { symbol: 'SLX',  label: 'Steel (SLX)',         ticker: 'SLX'  } },
  { names: ['lithium'],                     etf: { symbol: 'LIT',  label: 'Lithium (LIT)',       ticker: 'LIT'  } },
  { names: ['silicon', 'semiconductor', 'semiconductors', 'chips', 'wafer'], etf: { symbol: 'SOXX', label: 'Semis (SOXX)', ticker: 'SOXX' } },
  { names: ['rare earth', 'neodymium'],     etf: { symbol: 'REMX', label: 'Rare earth (REMX)',   ticker: 'REMX' } },
  { names: ['nickel'],                      etf: { symbol: 'NIKL', label: 'Nickel miners (NIKL)', ticker: 'NIKL' } },
  { names: ['uranium'],                     etf: { symbol: 'URA',  label: 'Uranium (URA)',       ticker: 'URA'  } },
  { names: ['timber', 'lumber', 'wood'],    etf: { symbol: 'WOOD', label: 'Timber (WOOD)',       ticker: 'WOOD' } },
  { names: ['soy', 'soybean', 'soybeans'],  etf: { symbol: 'SOYB', label: 'Soybeans (SOYB)',     ticker: 'SOYB' } },
]

/** "Steel (rebar)" → steel, "Crude Oil (energy costs)" → oil, "Rare earth elements" → rare earth. */
function resolveCommodity(raw: string): CommodityDef | null {
  const text = ` ${raw.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()} `
  return COMMODITIES.find(def => def.names.some(n => text.includes(` ${n} `))) ?? null
}

async function fetchCommodity(def: CommodityDef, diag: Diag): Promise<StoredSparkline | null> {
  if (def.av) {
    const s = await fetchAVCommodity(def.av.fn, def.av.label, def.av.ticker, def.av.unit, diag)
    if (s) return s
  }
  if (def.etf) return fetchEquity(def.etf.symbol, def.etf.label, def.etf.ticker, diag)
  return null
}

// ── Country and sector context ────────────────────────────────────────────────

const COUNTRY_ETF: Record<string, { symbol: string; label: string }> = {
  'japan':       { symbol: 'EWJ',  label: 'Japan (EWJ)'       },
  'japanese':    { symbol: 'EWJ',  label: 'Japan (EWJ)'       },
  'germany':     { symbol: 'EWG',  label: 'Germany (EWG)'     },
  'german':      { symbol: 'EWG',  label: 'Germany (EWG)'     },
  'india':       { symbol: 'INDA', label: 'India (INDA)'      },
  'indian':      { symbol: 'INDA', label: 'India (INDA)'      },
  'france':      { symbol: 'EWQ',  label: 'France (EWQ)'      },
  'french':      { symbol: 'EWQ',  label: 'France (EWQ)'      },
  'south korea': { symbol: 'EWY',  label: 'S.Korea (EWY)'     },
  'korean':      { symbol: 'EWY',  label: 'S.Korea (EWY)'     },
  'taiwan':      { symbol: 'EWT',  label: 'Taiwan (EWT)'      },
  'brazil':      { symbol: 'EWZ',  label: 'Brazil (EWZ)'      },
  'brazilian':   { symbol: 'EWZ',  label: 'Brazil (EWZ)'      },
  'canada':      { symbol: 'EWC',  label: 'Canada (EWC)'      },
  'canadian':    { symbol: 'EWC',  label: 'Canada (EWC)'      },
  'australia':   { symbol: 'EWA',  label: 'Australia (EWA)'   },
  'australian':  { symbol: 'EWA',  label: 'Australia (EWA)'   },
  'mexico':      { symbol: 'EWW',  label: 'Mexico (EWW)'      },
  'swiss':       { symbol: 'EWL',  label: 'Switzerland (EWL)' },
  'switzerland': { symbol: 'EWL',  label: 'Switzerland (EWL)' },
  'israel':      { symbol: 'EIS',  label: 'Israel (EIS)'      },
  'israeli':     { symbol: 'EIS',  label: 'Israel (EIS)'      },
  'china':       { symbol: 'MCHI', label: 'China (MCHI)'      },
  'chinese':     { symbol: 'MCHI', label: 'China (MCHI)'      },
  'singapore':   { symbol: 'EWS',  label: 'Singapore (EWS)'   },
  'united kingdom': { symbol: 'EWU', label: 'UK (EWU)'         },
  'italy':       { symbol: 'EWI',  label: 'Italy (EWI)'       },
  'spain':       { symbol: 'EWP',  label: 'Spain (EWP)'       },
  'netherlands': { symbol: 'EWN',  label: 'Netherlands (EWN)' },
  'poland':      { symbol: 'EPOL', label: 'Poland (EPOL)'     },
  'turkey':      { symbol: 'TUR',  label: 'Turkey (TUR)'      },
  'vietnam':     { symbol: 'VNM',  label: 'Vietnam (VNM)'     },
}

const SIGNAL_SECTOR_ETF: Array<{ keywords: string[]; symbol: string; label: string; key: string }> = [
  { keywords: ['shipping', 'freight', 'container ship', 'maritime', 'logistics disruption'], symbol: 'BDRY', label: 'Dry Freight (BDRY)', key: 'signal_freight'  },
  { keywords: ['defence', 'defense', 'military', 'weapons', 'armed conflict', 'war'],        symbol: 'ITA',  label: 'Defence (ITA)',      key: 'signal_defence'  },
  { keywords: ['semiconductor', 'chip shortage', 'wafer', 'tsmc', 'fab capacity'],           symbol: 'SOXX', label: 'Semis (SOXX)',       key: 'signal_semis'    },
  { keywords: ['solar', 'wind energy', 'renewable', 'clean energy', 'green energy'],         symbol: 'ICLN', label: 'Clean Energy (ICLN)',key: 'signal_clean'    },
  { keywords: ['oil major', 'refinery', 'upstream', 'downstream', 'lng export'],             symbol: 'XLE',  label: 'Energy (XLE)',       key: 'signal_energy'   },
  { keywords: ['interest rate hike', 'central bank rate', 'credit tightening', 'lending'],   symbol: 'XLF',  label: 'Financials (XLF)',   key: 'signal_fin'      },
  { keywords: ['pharma', 'pharmaceutical', 'biotech', 'clinical trial', 'drug approval'],    symbol: 'XLV',  label: 'Healthcare (XLV)',   key: 'signal_health'   },
  { keywords: ['cybersecurity', 'ransomware', 'data breach', 'cyber attack'],                symbol: 'HACK', label: 'Cyber (HACK)',        key: 'signal_cyber'    },
]

/** Country ETFs for the countries a company buys from (up to `max`), by profile name. */
function supplierCountryETFs(countryNames: string[], max: number): Array<{ symbol: string; label: string; key: string }> {
  const picked: Array<{ symbol: string; label: string; key: string }> = []
  const seen = new Set<string>()
  for (const country of countryNames) {
    const lowered = country.toLowerCase()
    const term = Object.keys(COUNTRY_ETF).find(t => lowered.includes(t))
    if (!term) continue
    const etf = COUNTRY_ETF[term]
    if (seen.has(etf.symbol)) continue
    seen.add(etf.symbol)
    picked.push({ ...etf, key: `supplier_${etf.symbol.toLowerCase()}` })
    if (picked.length >= max) break
  }
  return picked
}

function pickSignalDrivenCharts(
  signals: string,
  profileCountriesLower: string[],
  alreadyUsed: Set<string>,
): { countryETFs: Array<{ symbol: string; label: string; key: string }>; sectorETF: { symbol: string; label: string; key: string } | null } {
  const lower = signals.toLowerCase()
  const seenSymbols = new Set(alreadyUsed)
  const countryETFs: Array<{ symbol: string; label: string; key: string }> = []

  for (const [term, etf] of Object.entries(COUNTRY_ETF)) {
    if (seenSymbols.has(etf.symbol)) continue
    if (profileCountriesLower.some(c => c.includes(term.split(' ')[0]))) continue
    if (lower.includes(term)) {
      countryETFs.push({ ...etf, key: `signal_${etf.symbol.toLowerCase()}` })
      seenSymbols.add(etf.symbol)
      if (countryETFs.length >= 2) break
    }
  }

  let sectorETF: { symbol: string; label: string; key: string } | null = null
  for (const entry of SIGNAL_SECTOR_ETF) {
    if (entry.keywords.some(kw => lower.includes(kw))) {
      sectorETF = { symbol: entry.symbol, label: entry.label, key: entry.key }
      break
    }
  }

  return { countryETFs, sectorETF }
}

// ── Peers (competitors, customers) ────────────────────────────────────────────

interface Peer { name: string; ticker?: string }

async function peerChart(kind: 'competitor' | 'customer', peer: Peer, diag: Diag): Promise<[string, StoredSparkline] | null> {
  if (!peer.name) return null
  const symbol = cleanTicker(peer.ticker) ?? (await searchFMPTicker(peer.name, diag))
  if (!symbol) return null
  const series = await fetchEquity(symbol, peer.name, symbol, diag)
  if (!series) return null
  const slug = peer.name.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 20)
  return [`${kind}_${slug}`, series]
}

/** Work through the list in small batches until `want` charts are found. */
async function collectPeers(
  kind: 'competitor' | 'customer', peers: Peer[], want: number, diag: Diag, deadline: number,
): Promise<Record<string, StoredSparkline>> {
  const out: Record<string, StoredSparkline> = {}
  for (let i = 0; i < peers.length && Object.keys(out).length < want; i += 3) {
    if (Date.now() > deadline) { note(diag, `${kind} charts stopped early: time budget used`); break }
    const batch = peers.slice(i, i + 3)
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
  const lower    = allCountries.map(c => c.toLowerCase())
  const hasUK    = lower.some(c => c.includes('uk') || c.includes('united kingdom'))
  const hasJapan = lower.some(c => c.includes('japan'))
  const hasChina = lower.some(c => c.includes('china'))
  const hasIsrael = lower.some(c => c.includes('israel'))

  const snapshots: Record<string, StoredSparkline> = {}

  // ── Wave 1: indices + USD ─────────────────────────────────────────────────
  // The S&P 500 and MSCI World charts are the SPY and URTH ETFs, and are labelled as such.
  const [sp500, dxy, eurusd, oil] = await Promise.all([
    fetchEquity('SPY', 'S&P 500 (SPY)', 'SPY', diag, { alphaVantage: true }),
    firstOf(
      () => fetchForexCandle('OANDA:USD_INDEX', 'USD Index', 'DXY'),
      () => fetchFREDSparkline('dxy'),
    ),
    firstOf(
      () => fetchForexCandle('OANDA:EUR_USD', 'EUR/USD', '€/$'),
      () => fetchFREDSparkline('eurusd'),
      () => fetchAVFX('EUR', 'USD', diag),
    ),
    firstOf(
      () => fetchFREDSparkline('oil'),
      () => fetchAVCommodity('WTI', 'WTI Oil', 'WTI', '$/bbl', diag),
    ),
  ])
  if (sp500) snapshots['sp500'] = sp500
  if (dxy) snapshots['dxy'] = dxy
  if (eurusd) snapshots['eurusd'] = eurusd
  if (oil) snapshots['oil'] = oil

  await sleep(600)

  // ── Wave 2: MSCI, gold, FX for the countries the company touches ──────────
  const [msci, gold, gbpusd, usdjpy, usdcny, usdils] = await Promise.all([
    fetchEquity('URTH', 'MSCI World (URTH)', 'URTH', diag),
    fetchEquity('GLD', 'Gold (GLD)', 'GLD', diag),
    hasUK ? firstOf(
      () => fetchForexCandle('OANDA:GBP_USD', 'GBP/USD', '£/$'),
      () => fetchFREDSparkline('gbpusd'),
      () => fetchAVFX('GBP', 'USD', diag),
    ) : Promise.resolve(null),
    hasJapan ? firstOf(
      () => fetchForexCandle('OANDA:USD_JPY', 'USD/JPY', '$/¥'),
      () => fetchFREDSparkline('usdjpy'),
      () => fetchAVFX('USD', 'JPY', diag),
    ) : Promise.resolve(null),
    hasChina ? firstOf(
      () => fetchForexCandle('OANDA:USD_CNH', 'USD/CNH', '$/CNH'),
      () => fetchFREDSparkline('usdcny'),
      () => fetchAVFX('USD', 'CNY', diag),
    ) : Promise.resolve(null),
    hasIsrael ? firstOf(
      () => fetchForexCandle('OANDA:USD_ILS', 'USD/ILS', '$/₪'),
      () => fetchAVFX('USD', 'ILS', diag),
    ) : Promise.resolve(null),
  ])
  if (msci) snapshots['msci'] = msci
  if (gold) snapshots['gold'] = gold
  if (gbpusd) snapshots['gbpusd'] = gbpusd
  if (usdjpy) snapshots['usdjpy'] = usdjpy
  if (usdcny) snapshots['usdcny'] = usdcny
  if (usdils) snapshots['usdils'] = usdils

  // ── Wave 3: the company itself, competitors, and the commodities it depends on ──
  const { stockTicker, companyName, competitors = [], commodities = [], customers = [], signals = '' } = options

  if (stockTicker && Date.now() < deadline) {
    const s = await fetchEquity(stockTicker, companyName ?? stockTicker, stockTicker, diag, { alphaVantage: true })
    if (s) snapshots['company_stock'] = s
  }

  if (Date.now() < deadline) {
    Object.assign(snapshots, await collectPeers('competitor', competitors.slice(0, 8), 3, diag, deadline))
  }

  // Up to 4 commodity charts, trying up to 8 profile entries (many entries, such as
  // "Concrete" or "Glass", have no public price series).
  const wantedCommodities = new Set<CommodityDef>()
  let commodityAttempts = 0
  for (const name of commodities) {
    if (wantedCommodities.size >= 4 || commodityAttempts >= 8 || Date.now() > deadline) break
    const def = resolveCommodity(name)
    if (!def || wantedCommodities.has(def)) continue
    commodityAttempts++
    // Oil is already charted in the macro wave; gold likewise.
    if (def.av?.fn === 'WTI' && snapshots['oil']) { wantedCommodities.add(def); continue }
    if (def.etf?.symbol === 'GLD' && snapshots['gold']) { wantedCommodities.add(def); continue }
    const s = await fetchCommodity(def, diag)
    if (s) {
      wantedCommodities.add(def)
      snapshots[`commodity_${(def.names[0]).replace(/[^a-z0-9]/g, '_')}`] = s
    } else {
      note(diag, `No price series available for commodity "${name.slice(0, 30)}"`)
    }
  }

  // ── Wave 4: customers, supplier countries, and what the news is about this week ──
  if (Date.now() < deadline) {
    Object.assign(snapshots, await collectPeers('customer', customers.slice(0, 8), 3, diag, deadline))
  }

  const usedEtfSymbols = new Set<string>()
  for (const etf of supplierCountryETFs(options.supplierCountryNames ?? [], 3)) {
    if (Date.now() > deadline) break
    usedEtfSymbols.add(etf.symbol)
    const s = await fetchEquity(etf.symbol, etf.label, etf.symbol, diag)
    if (s) snapshots[etf.key] = s
  }

  if (signals && Date.now() < deadline) {
    const { countryETFs, sectorETF } = pickSignalDrivenCharts(signals, lower, usedEtfSymbols)
    for (const etf of countryETFs) {
      const s = await fetchEquity(etf.symbol, etf.label, etf.symbol, diag)
      if (s) snapshots[etf.key] = s
    }
    if (sectorETF) {
      const s = await fetchEquity(sectorETF.symbol, sectorETF.label, sectorETF.symbol, diag)
      if (s) snapshots[sectorETF.key] = s
    }
  }

  console.log(`[market-data] Fetched ${Object.keys(snapshots).length} live series${diag?.length ? `; ${diag.length} provider notes, e.g. ${diag.slice(0, 3).join(' | ')}` : ''}`)
  return snapshots
}
