// Stories: every event of the week is written once.
//
// The narrative call returns "stories" (what happened, why it matters, what to do, an
// optional decision, the downside, sources). Everything that used to be a separate,
// re-written list (risk register, weekly actions, decision framing, scenarios, summary)
// is derived from the stories here, in code. The radar sections written by the other
// calls are checked against the stories so an event that already has a story is not
// shown a second time.
//
// Relative imports only, so the logic can be tested without the app's path aliases.

import { normaliseUrl } from './citations'
import type {
  BriefContent, Story, StoryDecision, StoryKind, StorySource,
  RiskItem, WeeklyAction, DecisionFrame, Scenario,
} from './types'

export const MAX_STORIES = 5

const OWNERS: Story['owner'][] = ['CEO', 'CFO', 'CMO', 'CTO', 'CBPO', 'VP HR', 'All']
const LEVELS = ['high', 'medium', 'low'] as const
const TIMEFRAMES = ['immediate', 'near-term', 'long-term'] as const
const KINDS: StoryKind[] = ['risk', 'opportunity', 'watch']

/** A story as the model wrote it, before its reference ids become real links. */
export type StoryDraft = Story & { source_ids?: string[] }

function text(v: unknown, max = 600): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof v !== 'string') return fallback
  const wanted = v.trim().toLowerCase()
  return allowed.find(a => a.toLowerCase() === wanted) ?? fallback
}

function owner(v: unknown): Story['owner'] {
  const raw = text(v, 20)
  if (/^(vp\s*)?(hr|chro|people)$/i.test(raw)) return 'VP HR'
  return pick(raw, OWNERS, 'All')
}

function decision(v: unknown): StoryDecision | undefined {
  if (!v || typeof v !== 'object') return undefined
  const raw = v as Record<string, unknown>
  const question = text(raw.question, 300)
  const options = (Array.isArray(raw.options) ? raw.options : [])
    .map(o => {
      if (typeof o === 'string') return { label: text(o, 240), trade_off: '' }
      const r = (o ?? {}) as Record<string, unknown>
      return { label: text(r.label, 160), trade_off: text(r.trade_off, 280) }
    })
    .filter(o => o.label)
    .slice(0, 3)
  if (!question || options.length < 2) return undefined
  const lean = text(raw.lean, 300)
  return { question, options, ...(lean ? { lean } : {}) }
}

/**
 * Validate what the model returned. Anything that is not a usable story is dropped,
 * enums are coerced to the allowed values, and at most MAX_STORIES are kept (the
 * model ranks them most important first).
 */
export function normaliseStories(raw: unknown): StoryDraft[] {
  if (!Array.isArray(raw)) return []
  const out: StoryDraft[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const r = entry as Record<string, unknown>
    const title = text(r.title, 200)
    const what = text(r.what)
    const why = text(r.why)
    const action = text(r.action, 400)
    if (!title || !what || !why || !action) continue

    const ids = Array.isArray(r.source_ids) ? r.source_ids : typeof r.source_ids === 'string' ? [r.source_ids] : []
    const downside = text(r.downside, 400)
    const story: StoryDraft = {
      id: `s${out.length + 1}`,
      kind: pick(r.kind, KINDS, 'watch'),
      kicker: text(r.kicker, 40) || 'This week',
      title, what, why, action,
      owner: owner(r.owner),
      impact: pick(r.impact, LEVELS, 'medium'),
      timeframe: pick(r.timeframe, TIMEFRAMES, 'near-term'),
      source_ids: ids.filter((i): i is string => typeof i === 'string'),
    }
    const by = text(r.by_when, 40)
    if (by) story.by_when = by
    const d = decision(r.decision)
    if (d) story.decision = d
    if (downside) {
      story.downside = downside
      story.downside_likelihood = pick(r.downside_likelihood, LEVELS, 'medium')
    }
    out.push(story)
    if (out.length >= MAX_STORIES) break
  }
  return out
}

/** "www.reuters.com" → "reuters.com" */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.slice(0, 40)
  }
}

/**
 * Turn the reference ids a story cited ("S12") into real links. Ids that were not in
 * the fetched signals are ignored: a story is never given a link the model made up.
 * Returns how many stories ended up with at least one verified link.
 */
export function resolveStorySources(
  content: BriefContent,
  refs: { byId: Record<string, string> },
): { stories: number; withSources: number } {
  const stories = (content.stories ?? []) as StoryDraft[]
  let withSources = 0
  for (const story of stories) {
    const seen = new Set<string>()
    const sources: StorySource[] = []
    for (const raw of story.source_ids ?? []) {
      const m = String(raw).match(/S\d+/i)
      const url = m ? refs.byId[m[0].toUpperCase()] : undefined
      if (!url || seen.has(normaliseUrl(url))) continue
      seen.add(normaliseUrl(url))
      sources.push({ url, label: hostLabel(url) })
      if (sources.length >= 4) break
    }
    delete story.source_ids
    if (sources.length > 0) { story.sources = sources; withSources++ } else delete story.sources
  }
  return { stories: stories.length, withSources }
}

// ── Derived lists ─────────────────────────────────────────────────────────────

/**
 * Fill the older fields from the stories, so the dashboard, history, emails and the
 * assistant keep working without the model writing every event five times.
 */
export function deriveFromStories(content: BriefContent): void {
  const stories = content.stories ?? []
  if (stories.length === 0) return
  const lead = stories[0]

  const risks: RiskItem[] = stories
    .filter(s => s.kind === 'risk')
    .map(s => ({ title: s.title, detail: s.why, severity: s.impact, timeframe: s.timeframe }))
  content.risk_summary = risks

  const actions: WeeklyAction[] = stories.map(s => ({
    action: s.action, owner: s.owner, priority: s.impact, section: s.kicker,
  }))
  content.weekly_actions = actions

  const decisions: DecisionFrame[] = stories
    .filter((s): s is Story & { decision: StoryDecision } => !!s.decision)
    .map(s => ({
      question: s.decision.question,
      context: s.decision.lean ? `${s.why} Our read: ${s.decision.lean}` : s.why,
      options: s.decision.options.map(o => (o.trade_off ? `${o.label} — ${o.trade_off}` : o.label)),
    }))
  content.decision_framing = decisions

  const scenarios: Scenario[] = stories
    .filter(s => !!s.downside)
    .map(s => ({
      title: s.title,
      probability: s.downside_likelihood ?? 'medium',
      trigger: s.what,
      impact: s.downside as string,
      response: s.action,
    }))
  content.scenario_modeling = scenarios

  const also = stories.slice(1, 4).map(s => s.title.replace(/[.\s]+$/, ''))
  const tldr = content.tldr?.trim() ?? ''
  content.executive_summary = [tldr, also.length ? `Also this week: ${also.join('; ')}.` : '']
    .filter(Boolean).join(' ') || lead.what
  content.so_what = `${lead.why} First move: ${lead.action}`
}

// ── Radar de-duplication ──────────────────────────────────────────────────────

const STOP = new Set([
  'about', 'after', 'amid', 'also', 'announces', 'announced', 'being', 'could', 'from', 'have', 'into',
  'more', 'over', 'says', 'said', 'than', 'that', 'their', 'them', 'there', 'these', 'this', 'what',
  'will', 'with', 'week', 'year', 'new', 'company', 'market', 'markets', 'report', 'reports', 'amid',
  'while', 'under', 'between', 'against', 'across', 'plans', 'plan', 'sees', 'seen', 'update',
])

function tokenSet(input: string, ignore: Set<string>): Set<string> {
  const out = new Set<string>()
  for (const word of input.toLowerCase().replace(/\*\*/g, '').split(/[^a-z0-9]+/)) {
    if (word.length < 4 || STOP.has(word) || /^\d+$/.test(word)) continue
    const stem = word.length > 5 && word.endsWith('s') ? word.slice(0, -1) : word
    if (ignore.has(stem)) continue
    out.add(stem)
  }
  return out
}

const URL_SECTIONS = [
  'financial_news', 'geopolitical_news', 'competitor_intelligence', 'ma_watch',
  'customer_intelligence', 'company_news', 'hr_intelligence', 'tech_intelligence',
] as const
// Sections with no source link: matched on wording only.
const TEXT_SECTIONS: { key: string; field: string }[] = [
  { key: 'financial_signals', field: 'headline' },
  { key: 'operational_intelligence', field: 'headline' },
  { key: 'marketing_opportunities', field: 'opportunity' },
]

/**
 * Record which radar items repeat an event that already has a story, so the reading
 * view can show each event once. Nothing is deleted: article pages are addressed by
 * index, and the full list stays available behind a toggle.
 *
 * An item counts as covered when it cites the same source link as a story, or when its
 * headline shares most of its meaningful words with the story (company name excluded).
 */
export function markCoveredItems(content: BriefContent, opts: { companyName?: string } = {}): number {
  const stories = content.stories ?? []
  if (stories.length === 0) return 0
  const ignore = tokenSet(opts.companyName ?? '', new Set())

  const prepared = stories.map(s => ({
    id: s.id,
    urls: new Set((s.sources ?? []).map(x => normaliseUrl(x.url))),
    words: tokenSet(`${s.title} ${s.what}`, ignore),
  }))

  const record = content as unknown as Record<string, unknown>
  const coverage: Record<string, string> = {}

  function test(headline: string, extra: string, url?: string): string | null {
    const normUrl = url ? normaliseUrl(url) : ''
    const words = tokenSet(`${headline} ${extra}`, ignore)
    for (const story of prepared) {
      if (normUrl && story.urls.has(normUrl)) return story.id
      if (words.size === 0) continue
      let shared = 0
      for (const w of words) if (story.words.has(w)) shared++
      const ratio = shared / words.size
      if ((shared >= 3 && ratio >= 0.5) || (shared >= 2 && words.size <= 4 && ratio >= 0.75)) return story.id
    }
    return null
  }

  for (const section of URL_SECTIONS) {
    const list = record[section]
    if (!Array.isArray(list)) continue
    list.forEach((item, i) => {
      if (!item || typeof item !== 'object') return
      const it = item as Record<string, unknown>
      const headline = typeof it.headline === 'string' ? it.headline : ''
      const subject = typeof it.competitor === 'string' ? it.competitor : typeof it.customer === 'string' ? it.customer : ''
      const hit = test(headline, subject, typeof it.source_url === 'string' ? it.source_url : undefined)
      if (hit) coverage[`${section}:${i}`] = hit
    })
  }
  for (const { key, field } of TEXT_SECTIONS) {
    const list = record[key]
    if (!Array.isArray(list)) continue
    list.forEach((item, i) => {
      const value = (item as Record<string, unknown> | null)?.[field]
      if (typeof value !== 'string') return
      const hit = test(value, '')
      if (hit) coverage[`${key}:${i}`] = hit
    })
  }

  content.story_coverage = coverage
  return Object.keys(coverage).length
}

/** Number of items in a section that are not already told as a story. */
export function uncoveredCount(content: BriefContent, section: string): number {
  const list = (content as unknown as Record<string, unknown>)[section]
  if (!Array.isArray(list)) return 0
  return list.filter((_, i) => !content.story_coverage?.[`${section}:${i}`]).length
}

// ── Radar ─────────────────────────────────────────────────────────────────────

export interface RadarItem {
  section: string
  index: number
  /** Short topic label, e.g. "Competitor". */
  label: string
  headline: string
  detail: string
  url?: string
  source?: string
  level?: 'high' | 'medium' | 'low'
}

type Loose = Record<string, unknown>
const s = (v: unknown): string => (typeof v === 'string' ? v : '')

const RADAR_SECTIONS: { key: string; label: string; read: (it: Loose) => Omit<RadarItem, 'section' | 'index' | 'label'> }[] = [
  { key: 'competitor_intelligence', label: 'Competitor', read: it => ({
    headline: s(it.competitor) ? `${s(it.competitor)}: ${s(it.headline)}` : s(it.headline), detail: s(it.detail),
    url: s(it.source_url) || undefined, source: s(it.source) || undefined,
    level: ['high', 'medium', 'low'].includes(s(it.threat_level)) ? (s(it.threat_level) as RadarItem['level']) : undefined }) },
  { key: 'customer_intelligence', label: 'Customer', read: it => ({
    headline: s(it.customer) ? `${s(it.customer)}: ${s(it.headline)}` : s(it.headline), detail: s(it.detail),
    url: s(it.source_url) || undefined, source: s(it.source) || undefined }) },
  { key: 'geopolitical_news', label: 'Geopolitics', read: it => ({
    headline: s(it.headline), detail: s(it.detail), url: s(it.source_url) || undefined, source: s(it.source) || undefined }) },
  { key: 'financial_news', label: 'Markets', read: it => ({
    headline: s(it.headline), detail: s(it.detail), url: s(it.source_url) || undefined, source: s(it.source) || undefined }) },
  { key: 'ma_watch', label: 'M&A', read: it => ({
    headline: s(it.headline), detail: s(it.detail), url: s(it.source_url) || undefined, source: s(it.source) || undefined }) },
  { key: 'company_news', label: 'Company', read: it => ({
    headline: s(it.headline), detail: s(it.summary), url: s(it.source_url) || undefined, source: s(it.source) || undefined }) },
  { key: 'tech_intelligence', label: 'Technology', read: it => ({
    headline: s(it.headline), detail: s(it.detail), url: s(it.source_url) || undefined, source: s(it.source) || undefined }) },
  { key: 'hr_intelligence', label: 'People', read: it => ({
    headline: s(it.headline), detail: s(it.detail), url: s(it.source_url) || undefined, source: s(it.source) || undefined }) },
  { key: 'financial_signals', label: 'Capital markets', read: it => ({ headline: s(it.headline), detail: s(it.detail) }) },
  { key: 'operational_intelligence', label: 'Operations', read: it => ({ headline: s(it.headline), detail: s(it.detail) }) },
  { key: 'marketing_opportunities', label: 'Opportunity', read: it => ({ headline: s(it.opportunity), detail: s(it.rationale) }) },
]

/**
 * One-line items for the "on the radar" list: everything the other sections found that
 * is not already told as a story. Item numbers match the article pages.
 */
export function buildRadar(content: BriefContent): RadarItem[] {
  const out: RadarItem[] = []
  const record = content as unknown as Record<string, unknown>
  for (const { key, label, read } of RADAR_SECTIONS) {
    const list = record[key]
    if (!Array.isArray(list)) continue
    list.forEach((item, index) => {
      if (!item || typeof item !== 'object') return
      if (content.story_coverage?.[`${key}:${index}`]) return
      const r = read(item as Loose)
      if (!r.headline) return
      out.push({ section: key, index, label, ...r })
    })
  }
  return out
}
