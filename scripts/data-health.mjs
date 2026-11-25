// Data-source health check: calls every external source the brief depends on and prints
// working / not working, with the provider message. Prints no keys.
//
//   vercel env pull .env.production.local --environment=production   (once; the file is gitignored)
//   node --env-file=.env.production.local scripts/data-health.mjs
//
// Last run 2026-11-25: 53 of 63 checks working. Known gaps: FMP free plan refuses most stock
// symbols (402), Finnhub candles are premium (403), the old PatentsView API is gone, and
// Semantic Scholar and GDELT rate-limit anonymous callers (429).
const E = process.env
const clean = s => String(s ?? '').replace(/(key|token|apikey|api_key)=[^&\s"]+/gi, '$1=***').replace(/\s+/g, ' ').slice(0, 110)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const rows = []
const add = (name, ok, note) => { rows.push({ name, ok, note }); console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name.padEnd(34)} ${note}`) }

async function http(url, opts = {}) {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) })
    const text = await res.text()
    let json = null; try { json = JSON.parse(text) } catch {}
    return { status: res.status, json, text }
  } catch (e) { return { status: 0, json: null, text: String(e.message) } }
}

const today = new Date(); const iso = d => d.toISOString().slice(0, 10)
const ago = n => new Date(Date.now() - n * 864e5)

// ── News ──
{
  const r = await http(`https://newsapi.org/v2/everything?q=Vishay&pageSize=2&sortBy=publishedAt&from=${iso(ago(7))}&language=en&apiKey=${E.NEWS_API_KEY}`)
  add('NewsAPI', r.json?.status === 'ok', r.json?.status === 'ok' ? `${r.json.totalResults} results in 7 days` : clean(r.json?.message ?? r.text))
}
{
  const r = await http(`https://newsdata.io/api/1/latest?apikey=${E.NEWSDATA_API_KEY}&q=Vishay&size=2&language=en`)
  add('Newsdata.io', r.json?.status === 'success', r.json?.status === 'success' ? `${r.json.totalResults ?? (r.json.results || []).length} results` : clean(r.json?.results?.message ?? r.json?.message ?? r.text))
}
// ── FRED ──
const fredList = ['DEXUSEU','DTWEXBGS','DCOILWTICO','DCOILBRENTEU','DHHNGSP','SP500','NASDAQCOM','VIXCLS','NIKKEI225','PCOPPUSDM','PALUMUSDM','PNICKUSDM','PZINCUSDM','PIORECRUSDM','PTINUSDM','PURANUSDM','PWHEAMTUSDM','PMAIZMTUSDM','PSUGAISAUSDM','PCOFFOTMUSDM','PCOTTINDUSDM','PRUBBUSDM','WPU101','DEXJPUS','DEXCHUS','DEXUSUK','DEXMXUS','DEXKOUS','DEXINUS','DEXSZUS','DEXCAUS','DEXBZUS']
for (const id of fredList) {
  const r = await http(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${E.FRED_API_KEY}&file_type=json&sort_order=desc&limit=3`)
  const obs = (r.json?.observations || []).filter(o => o.value !== '.')
  add(`FRED ${id}`, r.status === 200 && obs.length > 0, r.status === 200 && obs.length ? `latest ${obs[0].date} = ${obs[0].value}` : clean(r.json?.error_message ?? `HTTP ${r.status}`))
}
// ── Equities ──
for (const sym of ['SPY', 'VPG', 'APH', 'LMT']) {
  const r = await http(`https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=${sym}&from=${iso(ago(40))}&to=${iso(today)}&apikey=${E.FMP_API_KEY}`)
  add(`FMP history ${sym}`, Array.isArray(r.json) && r.json.length > 1, Array.isArray(r.json) ? `${r.json.length} rows` : `HTTP ${r.status} ${clean(r.json?.['Error Message'] ?? r.text)}`)
}
for (const [label, path] of [['quote', 'quote?symbol=VPG'], ['profile', 'profile?symbol=VPG'], ['search-name', 'search-name?query=Sensata&limit=3'], ['stock-peers', 'stock-peers?symbol=VPG']]) {
  const r = await http(`https://financialmodelingprep.com/stable/${path}&apikey=${E.FMP_API_KEY}`)
  add(`FMP ${label}`, Array.isArray(r.json) && r.json.length > 0, Array.isArray(r.json) ? `${r.json.length} rows` : `HTTP ${r.status} ${clean(r.json?.['Error Message'] ?? r.text)}`)
}
for (const sym of ['VPG', 'APH']) {
  await sleep(1500)
  const r = await http(`https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${sym}&outputsize=compact&apikey=${E.ALPHA_VANTAGE_KEY}`)
  const series = r.json?.['Time Series (Daily)']
  add(`AlphaVantage daily ${sym}`, !!series, series ? `${Object.keys(series).length} days` : clean(r.json?.Note ?? r.json?.Information ?? r.json?.['Error Message'] ?? r.text))
}
for (const [label, path] of [['quote VPG', 'quote?symbol=VPG'], ['peers VPG', 'stock/peers?symbol=VPG'], ['profile VPG', 'stock/profile2?symbol=VPG'], ['company-news VPG', `company-news?symbol=VPG&from=${iso(ago(14))}&to=${iso(today)}`], ['candle VPG', `stock/candle?symbol=VPG&resolution=D&from=${Math.floor(ago(30) / 1000)}&to=${Math.floor(Date.now() / 1000)}`], ['forex candle EUR', `forex/candle?symbol=OANDA:EUR_USD&resolution=D&from=${Math.floor(ago(30) / 1000)}&to=${Math.floor(Date.now() / 1000)}`], ['earnings calendar', `calendar/earnings?from=${iso(today)}&to=${iso(new Date(Date.now() + 14 * 864e5))}&symbol=VPG`]]) {
  const r = await http(`https://finnhub.io/api/v1/${path}&token=${E.FINNHUB_API_KEY}`)
  const good = r.status === 200 && r.json && !r.json.error && (Array.isArray(r.json) ? r.json.length > 0 : (r.json.s ? r.json.s === 'ok' : Object.keys(r.json).length > 0 && (r.json.c === undefined || r.json.c !== 0)))
  add(`Finnhub ${label}`, good, good ? 'ok' : `HTTP ${r.status} ${clean(r.json?.error ?? r.text)}`)
}
// ── Filings / research / patents ──
{
  const r = await http('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': 'CompanyBrief research contact@companybrief.net' } })
  add('SEC EDGAR tickers', r.status === 200 && !!r.json, r.status === 200 ? 'ok' : `HTTP ${r.status}`)
}
{
  const r = await http('https://efts.sec.gov/LATEST/search-index?q=%22Vishay%20Precision%22&forms=8-K&dateRange=custom&startdt=' + iso(ago(60)) + '&enddt=' + iso(today), { headers: { 'User-Agent': 'CompanyBrief research contact@companybrief.net' } })
  add('SEC EDGAR full-text search', r.status === 200, r.status === 200 ? `${r.json?.hits?.total?.value ?? '?'} hits` : `HTTP ${r.status} ${clean(r.text)}`)
}
{
  const r = await http('https://api.patentsview.org/patents/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: { _contains: { assignee_organization: 'Vishay' } }, f: ['patent_title'], o: { per_page: 1 } }) })
  add('PatentsView (old API the app uses)', r.status === 200 && !!r.json?.patents, `HTTP ${r.status} ${clean(r.text)}`)
}
{
  const r = await http('https://search.patentsview.org/api/v1/patent/?q=%7B%22_text_any%22:%7B%22patent_title%22:%22sensor%22%7D%7D&f=%5B%22patent_title%22%5D&o=%7B%22size%22:1%7D')
  add('PatentsView (new API, no key)', r.status === 200, `HTTP ${r.status} ${clean(r.text)}`)
}
{
  const r = await http('https://api.semanticscholar.org/graph/v1/paper/search?query=precision+strain+gauge&limit=2&fields=title,year')
  add('Semantic Scholar', r.status === 200 && !!r.json?.data, r.status === 200 ? `${(r.json.data || []).length} papers` : `HTTP ${r.status} ${clean(r.text)}`)
}
{
  const r = await http('https://api.gdeltproject.org/api/v2/doc/doc?query=%22Vishay%20Precision%22&mode=ArtList&maxrecords=3&format=json&timespan=14d')
  add('GDELT news', r.status === 200 && !!r.json?.articles, r.status === 200 && r.json ? `${(r.json.articles || []).length} articles` : `HTTP ${r.status} ${clean(r.text)}`)
}
{
  const r = await http('https://news.google.com/rss/search?q=Vishay+Precision+Group&hl=en&gl=US&ceid=US:en')
  add('Google News RSS', r.status === 200 && /<item>/.test(r.text), r.status === 200 ? `${(r.text.match(/<item>/g) || []).length} items` : `HTTP ${r.status}`)
}
// ── Platform keys ──
{
  const r = await http('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${E.RESEND_API_KEY}` } })
  const doms = r.json?.data
  add('Resend key', r.status === 200 || r.status === 401, r.status === 200 ? `domains: ${(doms || []).map(d => `${d.name} (${d.status})`).join(', ') || 'none'}` : clean(r.json?.message ?? r.text))
}
{
  const r = await http('https://api.anthropic.com/v1/models?limit=3', { headers: { 'x-api-key': E.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } })
  add('Anthropic key', r.status === 200, r.status === 200 ? 'ok' : `HTTP ${r.status} ${clean(r.json?.error?.message ?? r.text)}`)
}
{
  const r = await http(`${E.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/briefs?select=id&limit=1`, { headers: { apikey: E.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${E.SUPABASE_SERVICE_ROLE_KEY}` } })
  add('Supabase service key', r.status === 200, r.status === 200 ? 'ok' : `HTTP ${r.status} ${clean(r.text)}`)
}
{
  const r = await http('https://api.stripe.com/v1/balance', { headers: { Authorization: `Bearer ${E.STRIPE_SECRET_KEY}` } })
  add('Stripe key', r.status === 200, r.status === 200 ? `${r.json?.livemode ? 'LIVE' : 'test'} mode` : `HTTP ${r.status} ${clean(r.json?.error?.message ?? r.text)}`)
}
console.log(`\n${rows.filter(r => r.ok).length} working, ${rows.filter(r => !r.ok).length} not working`)
