'use client'

import { useMemo, useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import type { BriefContent, Story, StoredSparkline } from '@/lib/types'
import { buildRadar, type RadarItem } from '@/lib/stories'
import { orderSnapshots } from '@/lib/market-order'
import MarketMiniChart from './MarketMiniChart'
import SWOTPanel from './SWOTPanel'
import BriefToolbar from './BriefToolbar'
import FeedbackButtons from '@/components/internal/FeedbackButtons'
import DashboardVisuals from '@/components/dashboard/DashboardVisuals'

// The brief, told as stories: each event of the week appears once, with what happened,
// why it matters, what to do, and (behind a click) the decision and the downside.
// Everything else is one line on the radar, the markets, or the collapsed deep-dive.

const IMPACT = {
  high:   { bar: 'bg-red-500',   chip: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800/40',         label: 'High impact' },
  medium: { bar: 'bg-amber-400', chip: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-800/40', label: 'Medium impact' },
  low:    { bar: 'bg-slate-300', chip: 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-white/5 dark:text-slate-300 dark:border-white/10',        label: 'Low impact' },
} as const

const KIND = {
  risk:        { label: 'Risk',        cls: 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300' },
  opportunity: { label: 'Opportunity', cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300' },
  watch:       { label: 'Watch',       cls: 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300' },
} as const

const TIMEFRAME = { immediate: 'This week', 'near-term': 'Next 1–3 months', 'long-term': 'Longer term' } as const

const OWNER_COLORS: Record<string, string> = {
  CEO:     'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300',
  CFO:     'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  CMO:     'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  CTO:     'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300',
  CBPO:    'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  'VP HR': 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300',
  All:     'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300',
}

const URGENCY = {
  'act-now':   { label: 'Act now',   cls: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800/40',             dot: 'bg-red-500' },
  monitor:     { label: 'Monitor',   cls: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-800/40', dot: 'bg-amber-500' },
  awareness:   { label: 'Awareness', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800/40', dot: 'bg-emerald-500' },
} as const

function RichText({ text }: { text: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1
          ? <strong key={i} className="font-semibold text-gray-900 dark:text-white">{part}</strong>
          : part,
      )}
    </>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  )
}

// ── Ticked-off actions ───────────────────────────────────────────────────────
// Stored in the browser under the same key the action tracker uses (action i is story i),
// so a tick here shows there. If storage is blocked, ticks last for the visit.

const DONE_EVENT = 'brief-actions-done'
const memoryStore = new Map<string, string>()

function subscribeDone(onChange: () => void) {
  window.addEventListener('storage', onChange)
  window.addEventListener(DONE_EVENT, onChange)
  return () => {
    window.removeEventListener('storage', onChange)
    window.removeEventListener(DONE_EVENT, onChange)
  }
}

function readDone(key: string): string {
  try { return localStorage.getItem(key) ?? '[]' } catch { return memoryStore.get(key) ?? '[]' }
}

function writeDone(key: string, value: string) {
  memoryStore.set(key, value)
  try { localStorage.setItem(key, value) } catch { /* kept in memory */ }
  window.dispatchEvent(new Event(DONE_EVENT))
}

// ── One story ────────────────────────────────────────────────────────────────

function StoryCard({
  story, index, briefId, done, onToggleDone, defaultOpen,
}: {
  story: Story
  index: number
  briefId: string
  done: boolean
  onToggleDone: () => void
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const impact = IMPACT[story.impact] ?? IMPACT.medium
  const kind = KIND[story.kind] ?? KIND.watch
  const hasMore = !!story.decision || !!story.downside
  const moreLabel = [story.decision && 'the decision', story.downside && 'the downside'].filter(Boolean).join(' and ').replace(/^t/, 'T')

  return (
    <article
      id={story.id}
      className="relative scroll-mt-6 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-white/10 dark:bg-gray-800"
    >
      <span className={`absolute inset-y-0 left-0 w-1.5 ${impact.bar}`} aria-hidden />
      <div className="py-5 pl-6 pr-5 sm:py-6 sm:pl-8 sm:pr-8">
        {/* Header chips */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-2xl font-black leading-none tabular-nums text-gray-200 dark:text-white/15">{index + 1}</span>
          <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">{story.kicker}</span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${kind.cls}`}>{kind.label}</span>
          <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${impact.chip}`}>{impact.label}</span>
          <span className="text-[11px] text-gray-400 dark:text-gray-500">{TIMEFRAME[story.timeframe] ?? story.timeframe}</span>
        </div>

        <h2 className="mt-3 text-xl font-bold leading-snug tracking-tight text-gray-900 dark:text-white sm:text-[23px]">
          {story.title}
        </h2>

        <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-gray-700 dark:text-gray-300">
          <p><RichText text={story.what} /></p>
          <p>
            <span className="font-semibold text-gray-900 dark:text-white">Why it matters. </span>
            <RichText text={story.why} />
          </p>
        </div>

        {/* The one thing to do */}
        <div className={`mt-5 flex items-start gap-3 rounded-xl border px-4 py-3.5 transition-colors ${
          done
            ? 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-800/40 dark:bg-emerald-900/10'
            : 'border-blue-100 bg-blue-50/70 dark:border-blue-800/30 dark:bg-blue-900/10'
        }`}>
          <button
            type="button"
            onClick={onToggleDone}
            aria-label={done ? 'Mark as not done' : 'Mark as done'}
            aria-pressed={done}
            className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition-colors ${
              done ? 'border-emerald-500 bg-emerald-500' : 'border-blue-300 bg-white hover:border-blue-500 dark:border-blue-700 dark:bg-transparent'
            }`}
          >
            {done && (
              <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-black uppercase tracking-[0.16em] text-blue-700 dark:text-blue-300">Do this</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${OWNER_COLORS[story.owner] ?? OWNER_COLORS.All}`}>{story.owner}</span>
              {story.by_when && <span className="text-[11px] text-gray-500 dark:text-gray-400">· {story.by_when}</span>}
            </div>
            <p className={`mt-1 text-sm font-medium leading-snug ${done ? 'text-gray-400 line-through dark:text-gray-500' : 'text-gray-900 dark:text-white'}`}>
              {story.action}
            </p>
          </div>
        </div>

        {/* Decision and downside, one click away */}
        {hasMore && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setOpen(v => !v)}
              aria-expanded={open}
              className="flex w-full items-center justify-between gap-2 rounded-lg px-1 py-1.5 text-left text-xs font-semibold text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
            >
              <span>{moreLabel}</span>
              <Chevron open={open} />
            </button>
            {open && (
              <div className="mt-2 space-y-4">
                {story.decision && (
                  <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-4 dark:border-white/10 dark:bg-white/5">
                    <p className="text-sm font-bold text-gray-900 dark:text-white">{story.decision.question}</p>
                    <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                      {story.decision.options.map((o, i) => (
                        <li key={i} className="rounded-lg border border-gray-200 bg-white p-3 text-xs leading-snug dark:border-white/10 dark:bg-gray-800">
                          <p className="font-semibold text-gray-900 dark:text-white">{o.label}</p>
                          {o.trade_off && <p className="mt-1 text-gray-500 dark:text-gray-400">{o.trade_off}</p>}
                        </li>
                      ))}
                    </ul>
                    {story.decision.lean && (
                      <p className="mt-3 text-xs leading-relaxed text-gray-700 dark:text-gray-300">
                        <span className="font-bold text-gray-900 dark:text-white">Our read: </span>{story.decision.lean}
                      </p>
                    )}
                  </div>
                )}
                {story.downside && (
                  <p className="text-sm leading-relaxed text-gray-700 dark:text-gray-300">
                    <span className="font-semibold text-gray-900 dark:text-white">If ignored. </span>
                    {story.downside}
                    {story.downside_likelihood && (
                      <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:bg-white/10 dark:text-gray-400">
                        {story.downside_likelihood} likelihood
                      </span>
                    )}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Sources and feedback */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-3 dark:border-white/5">
          <div className="flex flex-wrap items-center gap-1.5">
            {(story.sources ?? []).map(src => (
              <a
                key={src.url}
                href={src.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-full border border-gray-200 px-2 py-0.5 text-[11px] text-blue-600 hover:border-blue-300 hover:text-blue-800 dark:border-white/10 dark:text-blue-400"
              >
                <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                {src.label}
              </a>
            ))}
            {(story.sources ?? []).length === 0 && (
              <span className="text-[11px] italic text-gray-400 dark:text-gray-500">Drawn from several signals this week</span>
            )}
          </div>
          <FeedbackButtons briefId={briefId} section="stories" itemIndex={index} compact />
        </div>
      </div>
    </article>
  )
}

// ── The radar: everything else, one line each ─────────────────────────────────

const RADAR_INITIAL = 8

function Radar({ items, briefId }: { items: RadarItem[]; briefId: string }) {
  const [all, setAll] = useState(false)
  const [openKey, setOpenKey] = useState<string | null>(null)
  if (items.length === 0) return null
  const shown = all ? items : items.slice(0, RADAR_INITIAL)

  return (
    <section aria-labelledby="radar-heading">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="radar-heading" className="text-[11px] font-black uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
          Also on the radar
        </h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">{items.length} more signal{items.length === 1 ? '' : 's'}</span>
      </div>
      <ul className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:divide-white/5 dark:border-white/10 dark:bg-gray-800">
        {shown.map(item => {
          const key = `${item.section}:${item.index}`
          const isOpen = openKey === key
          return (
            <li key={key}>
              <button
                type="button"
                onClick={() => setOpenKey(isOpen ? null : key)}
                aria-expanded={isOpen}
                className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-white/5"
              >
                <span className="mt-0.5 w-24 shrink-0 text-[10px] font-bold uppercase tracking-wide text-gray-400 dark:text-gray-500">
                  {item.label}
                </span>
                <span className="min-w-0 flex-1 text-sm font-medium leading-snug text-gray-900 dark:text-white">
                  {item.level === 'high' && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-red-500 align-middle" />}
                  {item.headline}
                </span>
                <Chevron open={isOpen} />
              </button>
              {isOpen && (
                <div className="space-y-2 px-4 pb-4 pl-[7.75rem] text-[13px] leading-relaxed text-gray-600 dark:text-gray-300">
                  {item.detail && <p><RichText text={item.detail} /></p>}
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    {item.url && (
                      <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">
                        {item.source ?? 'Source'} ↗
                      </a>
                    )}
                    <Link href={`/briefs/${briefId}/article/${item.section}/${item.index}`} className="font-semibold text-blue-700 hover:underline dark:text-blue-300">
                      Full analysis →
                    </Link>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {items.length > RADAR_INITIAL && (
        <button
          type="button"
          onClick={() => setAll(v => !v)}
          className="mt-2 text-xs font-semibold text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
        >
          {all ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </section>
  )
}

// ── Markets strip ────────────────────────────────────────────────────────────

function MarketsStrip({ snapshots }: { snapshots: Record<string, StoredSparkline> | undefined }) {
  const [charts, setCharts] = useState(false)
  const ordered = useMemo(() => orderSnapshots(snapshots, 12).map(o => o.series), [snapshots])
  if (ordered.length === 0) return null

  return (
    <section aria-labelledby="markets-heading" className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-white/10 dark:bg-gray-800">
      <button
        type="button"
        onClick={() => setCharts(v => !v)}
        aria-expanded={charts}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-white/5"
      >
        <div className="min-w-0">
          <h2 id="markets-heading" className="text-[11px] font-black uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">Markets</h2>
          <div className="mt-1 flex items-center gap-4 overflow-hidden">
            {ordered.slice(0, 6).map(s => (
              <span key={s.ticker} className="flex shrink-0 items-center gap-1.5 text-xs">
                <span className="font-semibold text-gray-700 dark:text-gray-200">{s.ticker}</span>
                <span className={s.pct >= 0 ? 'text-emerald-600' : 'text-red-500'}>
                  {s.pct >= 0 ? '▲' : '▼'}{Math.abs(s.pct).toFixed(2)}%
                </span>
              </span>
            ))}
          </div>
        </div>
        <Chevron open={charts} />
      </button>
      {charts && (
        <div className="grid grid-cols-2 gap-3 border-t border-gray-100 p-4 dark:border-white/5 sm:grid-cols-3 md:grid-cols-4">
          {ordered.map((s, i) => (
            <MarketMiniChart key={`${s.ticker}-${i}`} sparkline={s as Parameters<typeof MarketMiniChart>[0]['sparkline']} />
          ))}
        </div>
      )}
    </section>
  )
}

// ── Capital impact (shown in the deep-dive) ──────────────────────────────────

function CapitalImpact({ capital }: { capital: BriefContent['capital_impact'] }) {
  if (!capital) return null
  const fields = [
    { label: 'Revenue exposure', text: capital.revenue_exposure },
    { label: 'Margin pressure', text: capital.margin_pressure },
    { label: 'Capex considerations', text: capital.capex_considerations },
  ].filter(f => f.text)
  if (fields.length === 0) return null
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-white/10 dark:bg-gray-800">
      <p className="mb-3 text-[11px] font-black uppercase tracking-[0.16em] text-blue-700 dark:text-blue-300">Capital impact</p>
      <div className="grid gap-3 md:grid-cols-3">
        {fields.map(f => (
          <div key={f.label} className="rounded-lg border border-gray-100 bg-gray-50 p-3 dark:border-white/10 dark:bg-white/5">
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-400 dark:text-gray-500">{f.label}</p>
            <p className="text-xs leading-relaxed text-gray-700 dark:text-gray-300">{f.text}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function StoryBrief({
  briefId, content, weekOf, generatedAt, companyName,
}: {
  briefId: string
  content: BriefContent
  weekOf: string
  generatedAt?: string | null
  companyName?: string | null
}) {
  const stories = content.stories ?? []
  const radar = useMemo(() => buildRadar(content), [content])
  const [deep, setDeep] = useState(false)
  const storageKey = `actions-done-${briefId}`
  const rawDone = useSyncExternalStore(subscribeDone, () => readDone(storageKey), () => '[]')
  const done = useMemo(() => {
    try { return new Set<string>(JSON.parse(rawDone) as string[]) } catch { return new Set<string>() }
  }, [rawDone])

  function toggleDone(index: number) {
    const id = `ai-${index}`
    const next = new Set(done)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    writeDone(storageKey, JSON.stringify([...next]))
  }

  const urgency = content.urgency ? URGENCY[content.urgency] : null
  const hasFrameworks =
    ((content.swot?.strengths?.length ?? 0) + (content.swot?.weaknesses?.length ?? 0) +
      (content.swot?.opportunities?.length ?? 0) + (content.swot?.threats?.length ?? 0)) > 0

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-4 sm:p-6">
      <BriefToolbar briefId={briefId} weekOf={weekOf} generatedAt={generatedAt} />

      {/* Masthead */}
      <header>
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400 dark:text-gray-500">
          <span>Week of {weekOf}</span>
          {companyName && <><span aria-hidden>·</span><span>{companyName}</span></>}
          {urgency && (
            <span className={`ml-1 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-bold normal-case tracking-normal ${urgency.cls}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${urgency.dot}`} />{urgency.label}
            </span>
          )}
        </div>
        <h1 className="mt-3 text-3xl font-bold leading-tight tracking-tight text-gray-900 dark:text-white sm:text-4xl">
          {content.headline}
        </h1>
        {content.tldr && (
          <p className="mt-4 max-w-3xl text-lg leading-relaxed text-gray-600 dark:text-gray-300">{content.tldr}</p>
        )}
        <p className="mt-3 text-xs text-gray-400 dark:text-gray-500">
          {stories.length} {stories.length === 1 ? 'story' : 'stories'}
          {radar.length > 0 && ` · ${radar.length} more on the radar`}
          {content.read_time ? ` · about ${content.read_time} min` : ''}
        </p>

        {stories.length > 1 && (
          <nav aria-label="Stories in this brief" className="mt-4 flex gap-2 overflow-x-auto pb-1">
            {stories.map((s, i) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="flex max-w-[16rem] shrink-0 items-center gap-2 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 hover:border-gray-400 dark:border-white/10 dark:bg-gray-800 dark:text-gray-300"
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${(IMPACT[s.impact] ?? IMPACT.medium).bar}`} />
                <span className="font-semibold text-gray-900 dark:text-white">{i + 1}</span>
                <span className="truncate">{s.kicker}</span>
              </a>
            ))}
          </nav>
        )}
      </header>

      {/* Stories */}
      <div className="space-y-5">
        {stories.map((story, i) => (
          <StoryCard
            key={story.id}
            story={story}
            index={i}
            briefId={briefId}
            done={done.has(`ai-${i}`)}
            onToggleDone={() => toggleDone(i)}
            defaultOpen={i === 0}
          />
        ))}
      </div>

      <Radar items={radar} briefId={briefId} />

      <MarketsStrip snapshots={content.market_snapshots} />

      {/* Deep-dive, closed by default */}
      {(hasFrameworks || content.capital_impact) && (
        <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-white/10 dark:bg-gray-800">
          <button
            type="button"
            onClick={() => setDeep(v => !v)}
            aria-expanded={deep}
            className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left hover:bg-gray-50 dark:hover:bg-white/5"
          >
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">Deeper analysis</p>
              <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">SWOT, capital impact and strategic visuals</p>
            </div>
            <Chevron open={deep} />
          </button>
          {deep && (
            <div className="space-y-5 border-t border-gray-100 p-4 dark:border-white/5">
              {hasFrameworks && <SWOTPanel swot={content.swot} />}
              <CapitalImpact capital={content.capital_impact} />
              <DashboardVisuals briefId={briefId} />
            </div>
          )}
        </section>
      )}

      <Link
        href={`/briefs/${briefId}/full`}
        className="group flex items-center justify-between rounded-2xl border border-gray-200 bg-white px-5 py-4 shadow-sm transition-all hover:border-blue-200 hover:shadow-md dark:border-white/10 dark:bg-gray-800"
      >
        <div>
          <p className="text-sm font-semibold text-gray-900 transition-colors group-hover:text-blue-700 dark:text-white">All intelligence by section</p>
          <p className="mt-0.5 text-xs text-gray-400">The full reference: every signal, filtered by role, with in-depth analysis</p>
        </div>
        <svg className="h-5 w-5 shrink-0 text-gray-300 transition-colors group-hover:text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </Link>
    </div>
  )
}
