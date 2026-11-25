'use client'

import type { StoredSparkline } from '@/lib/types'
import MarketMiniChart from '@/components/brief/MarketMiniChart'
import { orderSnapshots, MARKET_GROUP_LABEL, type MarketGroup } from '@/lib/market-order'

interface Props {
  snapshots?: Record<string, StoredSparkline>
}

const GROUP_ORDER: MarketGroup[] = ['company', 'peers', 'inputs', 'macro']

export default function DashboardMarketSignals({ snapshots }: Props) {
  const ordered = orderSnapshots(snapshots, 14)

  if (ordered.length === 0) {
    return (
      <p className="text-xs text-gray-500">
        No market data was captured for this brief. The next brief will try again.
      </p>
    )
  }

  const groups = GROUP_ORDER
    .map(group => ({ group, items: ordered.filter(o => o.group === group) }))
    .filter(g => g.items.length > 0)

  return (
    <div className="space-y-5">
      {groups.map(({ group, items }) => (
        <div key={group}>
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">
            {MARKET_GROUP_LABEL[group]}
          </p>
          <div className="grid grid-cols-2 gap-3">
            {items.map(({ key, series }) => (
              <MarketMiniChart
                key={key}
                sparkline={series as Parameters<typeof MarketMiniChart>[0]['sparkline']}
                compact
              />
            ))}
          </div>
        </div>
      ))}
      <p className="text-[10px] text-gray-400">
        Live data, fetched when the brief was generated. Charts show the last 30 days.
      </p>
    </div>
  )
}
