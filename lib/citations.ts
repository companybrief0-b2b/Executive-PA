// Source citations for the weekly brief.
//
// The model never writes a web address. Every fetched source line gets a short
// reference ("S12") before the signals go to the model; the model cites by that id,
// and the id is turned back into the real URL here. This replaces asking the model to
// copy long URLs exactly: on a real brief, 19 of 20 copied links failed verification
// (altered or invented), so almost nothing carried a source.

import type { BriefContent } from './types'

/** Sections whose items may carry a source link. */
export const CITED_SECTIONS = [
  'financial_news', 'geopolitical_news', 'competitor_intelligence', 'ma_watch',
  'customer_intelligence', 'company_news', 'hr_intelligence', 'tech_intelligence',
] as const

const URL_TOKEN = /\[URL:\s*([^\]\s]+)\s*\]/g

export function normaliseUrl(url: string): string {
  return url.trim().replace(/[)\].,;]+$/, '').replace(/\/+$/, '').toLowerCase()
}

/** Trailing sentence punctuation is not part of a link ("…/page)." → "…/page"). */
function tidyUrl(raw: string): string {
  let url = raw.trim().replace(/[.,;]+$/, '')
  if (url.endsWith(')') && !url.includes('(')) url = url.slice(0, -1).replace(/[.,;]+$/, '')
  return url
}

export interface SourceRefs {
  /** "S12" → the real URL */
  byId: Record<string, string>
}

/**
 * Replace every "[URL: …]" token in the signals with "[REF: S#]" and remember the
 * mapping. The same URL always gets the same id.
 */
export function assignSourceRefs(signals: string): { text: string; refs: SourceRefs } {
  const byId: Record<string, string> = {}
  const idByUrl = new Map<string, string>()
  let next = 1
  const text = signals.replace(URL_TOKEN, (_whole, rawUrl: string) => {
    const url = tidyUrl(rawUrl)
    const key = normaliseUrl(url)
    let id = idByUrl.get(key)
    if (!id) {
      id = `S${next++}`
      idByUrl.set(key, id)
      byId[id] = url
    }
    return `[REF: ${id}]`
  })
  return { text, refs: { byId } }
}

export interface CitationStats { items: number; cited: number; removed: number }

/**
 * Turn the ids the model cited back into real URLs. Anything that is not a known id
 * (or a full URL that appeared in the signals) is removed; the insight stays, without
 * a link. Returns coverage numbers that are stored on the brief.
 */
export function resolveSourceRefs(content: BriefContent, refs: SourceRefs): CitationStats {
  const knownUrls = new Set(Object.values(refs.byId).map(normaliseUrl))
  let items = 0, cited = 0, removed = 0
  const record = content as unknown as Record<string, unknown>

  for (const section of CITED_SECTIONS) {
    const list = record[section]
    if (!Array.isArray(list)) continue
    for (const item of list as Record<string, unknown>[]) {
      if (!item || typeof item !== 'object') continue
      items++
      const value = typeof item.source_url === 'string' ? item.source_url.trim() : ''
      if (!value) { delete item.source_excerpt; continue }

      const idMatch = value.match(/^\[?\s*(?:REF:\s*)?(S\d+)\s*\]?$/i)
      if (idMatch) {
        const url = refs.byId[idMatch[1].toUpperCase()]
        if (url) { item.source_url = url; cited++; continue }
      } else if (/^https?:\/\//i.test(value) && knownUrls.has(normaliseUrl(value))) {
        cited++
        continue
      }
      delete item.source_url
      delete item.source_excerpt
      removed++
    }
  }
  return { items, cited, removed }
}

// ── Filler items ──────────────────────────────────────────────────────────────

const FILLER = /\b(no (new|major|significant|material|notable) (development|news|update|activity|change|story)s?|nothing new|ongoing,? no new|no recent news|no fresh news)\b/i

const FILLER_SECTIONS = [...CITED_SECTIONS] as const

/**
 * Drop list items that only say nothing happened ("ongoing, no new development this
 * week"). The prompt already forbids them; this enforces it. Returns how many went.
 */
export function dropFillerItems(content: BriefContent): number {
  let dropped = 0
  const record = content as unknown as Record<string, unknown>
  for (const section of FILLER_SECTIONS) {
    const list = record[section]
    if (!Array.isArray(list)) continue
    const kept = (list as Record<string, unknown>[]).filter(item => {
      const text = [item?.headline, item?.summary].filter(v => typeof v === 'string').join(' ')
      const isFiller = FILLER.test(text) && text.length < 220
      if (isFiller) dropped++
      return !isFiller
    })
    record[section] = kept
  }
  return dropped
}
