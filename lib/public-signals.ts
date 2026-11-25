// Two keyless, public-sector signal sources for the weekly brief:
//
//  1. US Federal Register: tariff and export-control rules and notices that mention
//     the company's commodities and products.
//  2. Natural-hazard alerts: USGS earthquakes (M5.5+) and GDACS Orange/Red alerts in
//     the countries the company operates in, buys from or sells to.
//
// Both are US/UN public data, free to use, and need no API key. Every line carries a
// "[URL: …]" token so the brief's source-link check can verify citations. A failure in
// either source returns '' and never blocks the brief.

import type { Company, CompanyLocation, CompanyProfile } from '@/lib/types'

const TIMEOUT_MS = 10_000

async function getJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return null
    return (await res.json()) as unknown
  } catch {
    return null
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10)
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)

/** "Germany / EU" → ["germany", "eu"]; "United States" → ["united states"]. */
function countryTerms(names: string[]): string[] {
  const out = new Set<string>()
  for (const name of names) {
    for (const part of name.toLowerCase().split(/[\/,;]| and /)) {
      const t = part.replace(/\([^)]*\)/g, '').trim()
      if (t.length >= 4) out.add(t)
    }
  }
  return [...out]
}

// ── US Federal Register ───────────────────────────────────────────────────────

interface FrDocument {
  title?: string
  type?: string
  abstract?: string | null
  html_url?: string
  publication_date?: string
  document_number?: string
}

function touchesUS(names: string[]): boolean {
  return names.some(n => /united states|\busa\b|u\.s\.|^us$/i.test(n.trim()))
}

/** The profile entries to look up: commodities first, then product keywords. */
function regulatoryTerms(profile: CompanyProfile): string[] {
  const clean = (s: string) => s.replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\p{N}\s\-]/gu, ' ').replace(/\s+/g, ' ').trim()
  const seen = new Set<string>()
  const terms: string[] = []
  for (const raw of [...(profile.commodities ?? []), ...(profile.keywords ?? [])]) {
    const t = clean(String(raw))
    const key = t.toLowerCase()
    if (t.length < 4 || t.split(' ').length > 3 || seen.has(key)) continue
    seen.add(key)
    terms.push(t)
    if (terms.length >= 3) break
  }
  return terms
}

async function frSearch(term: string, trade: 'tariff' | '"export controls"'): Promise<FrDocument[]> {
  const params = new URLSearchParams()
  params.set('conditions[term]', `${term} ${trade}`)
  params.set('conditions[publication_date][gte]', iso(daysAgo(14)))
  for (const f of ['title', 'type', 'abstract', 'html_url', 'publication_date', 'document_number']) params.append('fields[]', f)
  params.set('per_page', '2')
  params.set('order', 'relevance')
  const json = (await getJson(`https://www.federalregister.gov/api/v1/documents.json?${params}`)) as { results?: FrDocument[] } | null
  return json?.results ?? []
}

export async function buildRegulatorySignals(
  company: Company,
  profile: CompanyProfile,
  locations: CompanyLocation[] = [],
): Promise<string> {
  const countries = [
    ...(profile.revenue_countries ?? []).map(r => r.country),
    ...(profile.supplier_countries ?? []).map(s => s.country),
    ...locations.map(l => l.country_name),
  ]
  if (!touchesUS(countries)) return ''

  const terms = regulatoryTerms(profile)
  if (terms.length === 0) return ''

  const batches = await Promise.all(
    terms.flatMap(term => [frSearch(term, 'tariff'), frSearch(term, '"export controls"')]),
  )

  const seen = new Set<string>()
  const lines: string[] = []
  for (const doc of batches.flat()) {
    const id = doc.document_number ?? doc.html_url
    if (!id || seen.has(id) || !doc.title || !doc.html_url) continue
    seen.add(id)
    const abstract = doc.abstract ? ` ${doc.abstract.replace(/\s+/g, ' ').slice(0, 160)}` : ''
    lines.push(`  - Federal Register (${doc.type ?? 'Document'}, ${doc.publication_date ?? ''}): "${doc.title.slice(0, 160)}".${abstract} [URL: ${doc.html_url}]`)
    if (lines.length >= 6) break
  }
  if (lines.length === 0) return ''

  console.log(`[signals] Federal Register: ${lines.length} documents for ${company.name}`)
  return [
    `[US REGULATORY WATCH — Federal Register tariff and export-control documents from the last 14 days that mention ${terms.join(', ')}]`,
    ...lines,
  ].join('\n')
}

// ── Natural hazards ───────────────────────────────────────────────────────────

interface UsgsFeature {
  properties?: { mag?: number; place?: string; url?: string; time?: number; tsunami?: number }
}

interface GdacsFeature {
  properties?: {
    eventtype?: string
    name?: string
    htmldescription?: string
    alertlevel?: string
    country?: string
    fromdate?: string
    todate?: string
    url?: { report?: string }
    affectedcountries?: Array<{ countryname?: string }>
  }
}

const GDACS_TYPE: Record<string, string> = { EQ: 'Earthquake', TC: 'Tropical cyclone', FL: 'Flood', VO: 'Volcano', DR: 'Drought', WF: 'Wildfire' }

export async function buildHazardSignals(countryNames: string[]): Promise<string> {
  const terms = countryTerms(countryNames)
  if (terms.length === 0) return ''
  const mentions = (text: string) => {
    const t = text.toLowerCase()
    return terms.some(term => t.includes(term))
  }

  const [usgs, gdacs] = await Promise.all([
    getJson(
      `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=5.5&starttime=${iso(daysAgo(7))}&orderby=magnitude&limit=30`,
    ) as Promise<{ features?: UsgsFeature[] } | null>,
    getJson(
      `https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?alertlevel=Orange;Red&eventlist=EQ;TC;FL;VO;DR;WF&fromdate=${iso(daysAgo(7))}&todate=${iso(new Date())}`,
    ) as Promise<{ features?: GdacsFeature[] } | null>,
  ])

  const lines: string[] = []

  for (const f of usgs?.features ?? []) {
    const p = f.properties
    if (!p?.place || !p.url || !mentions(p.place)) continue
    const when = p.time ? new Date(p.time).toISOString().slice(0, 10) : ''
    lines.push(`  - USGS: magnitude ${p.mag} earthquake, ${p.place}, ${when}${p.tsunami ? ' (tsunami alert issued)' : ''}. [URL: ${p.url}]`)
    if (lines.length >= 4) break
  }

  for (const f of gdacs?.features ?? []) {
    const p = f.properties
    const report = p?.url?.report
    if (!p || !report) continue
    const where = [p.country ?? '', ...(p.affectedcountries ?? []).map(c => c.countryname ?? '')].join(' ')
    if (!mentions(where)) continue
    const kind = GDACS_TYPE[p.eventtype ?? ''] ?? 'Hazard'
    const dates = `${(p.fromdate ?? '').slice(0, 10)} to ${(p.todate ?? '').slice(0, 10)}`
    lines.push(`  - GDACS ${p.alertlevel} alert: ${kind} "${(p.name ?? '').slice(0, 80)}", ${p.country ?? 'affected countries'}, ${dates}. [URL: ${report}]`)
    if (lines.length >= 8) break
  }

  const header = '[NATURAL HAZARD ALERTS — USGS earthquakes of magnitude 5.5+ and GDACS Orange/Red disaster alerts from the last 7 days, in countries this company operates in, buys from or sells to]'
  if (lines.length === 0) return `${header}\n  No major hazard alerts in these countries this week.`
  return [header, ...lines].join('\n')
}
