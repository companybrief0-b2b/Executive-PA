import type { StoredSparkline } from './types'

// Decides which of a brief's stored market series to show, and in what order.
// Company-specific series come first (your stock, competitors, customers, the
// commodities and countries you are exposed to); broad macro indicators fill the
// rest. Only real stored series are ever returned: nothing is simulated.

export type MarketGroup = 'company' | 'peers' | 'inputs' | 'macro'

export interface OrderedSeries {
  key: string
  group: MarketGroup
  series: StoredSparkline
}

export const MARKET_GROUP_LABEL: Record<MarketGroup, string> = {
  company: 'Your company',
  peers: 'Competitors and customers',
  inputs: 'Inputs and exposure',
  macro: 'Macro',
}

const FX_KEYS = ['eurusd', 'gbpusd', 'usdjpy', 'usdcny', 'usdils', 'usdmxn', 'usdkrw', 'usdinr', 'usdchf', 'usdcad', 'usdbrl']
// 'msci' and 'gold' only exist on briefs generated before the data sources changed.
const MACRO_KEYS = ['sp500', 'nasdaq', 'vix', 'nikkei', 'dxy', 'oil', 'msci', 'gold']

function usable(s: StoredSparkline | undefined): s is StoredSparkline {
  return !!s && Array.isArray(s.data) && s.data.length >= 2 && Number.isFinite(s.current)
}

/** All usable series, grouped and ordered. `limit` caps the total. */
export function orderSnapshots(
  snapshots: Record<string, StoredSparkline> | null | undefined,
  limit = 12,
): OrderedSeries[] {
  const snaps = snapshots ?? {}
  const out: OrderedSeries[] = []
  const seen = new Set<string>()

  const add = (key: string, group: MarketGroup) => {
    const series = snaps[key]
    if (!usable(series) || seen.has(key)) return
    seen.add(key)
    out.push({ key, group, series })
  }
  const addPrefix = (prefix: string, group: MarketGroup) => {
    Object.keys(snaps).filter(k => k.startsWith(prefix)).sort().forEach(k => add(k, group))
  }

  add('company_stock', 'company')
  addPrefix('competitor_', 'peers')
  addPrefix('customer_', 'peers')
  addPrefix('commodity_', 'inputs')
  addPrefix('supplier_', 'inputs')
  FX_KEYS
    .filter(k => usable(snaps[k]))
    .sort((a, b) => Math.abs(snaps[b].pct) - Math.abs(snaps[a].pct))
    .forEach(k => add(k, 'inputs'))
  addPrefix('signal_', 'inputs')
  MACRO_KEYS.forEach(k => add(k, 'macro'))

  return out.slice(0, limit)
}
