// Chart types shared by the market components.
//
// This file used to contain generated, seeded-random "sparklines" (a fake S&P 500,
// gold, MSCI and so on) that the UI showed whenever a live series was missing, and
// labelled as live. They have been removed: a market chart is only ever shown from
// real data stored on the brief (see lib/live-market-data.ts and lib/market-order.ts).

export interface DataPoint {
  date: string
  value: number
}

export interface Sparkline {
  label: string
  ticker: string
  unit: string
  data: DataPoint[]
  current: number
  open: number // 30 days ago
  pct: number
  up: boolean
}

// Map CFO signal categories to the stored series that illustrates them.
export const CFO_CHART_MAP: Record<string, string> = {
  'fx risk': 'eurusd',
  'commodity pricing': 'oil',
  'equity sentiment': 'sp500',
  'interest rates': 'dxy',
  'credit markets': 'sp500',
}
