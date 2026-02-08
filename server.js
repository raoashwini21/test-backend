import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ════════════════════════════════════════════
// BLOG CACHE (10 min TTL)
// ════════════════════════════════════════════
let blogCache = { data: null, timestamp: null, collectionId: null };
const CACHE_TTL = 10 * 60 * 1000;

function isCacheValid(cid) {
  return blogCache.data && blogCache.collectionId === cid &&
    blogCache.timestamp && (Date.now() - blogCache.timestamp < CACHE_TTL);
}

async function fetchAllBlogs(collectionId, token) {
  console.log('Fetching blogs from Webflow...');
  const items = [];
  let offset = 0;
  while (true) {
    const url = `https://api.webflow.com/v2/collections/${collectionId}/items?limit=100&offset=${offset}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
    });
    if (!res.ok) throw new Error(`Webflow ${res.status}`);
    const data = await res.json();
    const batch = data.items || [];
    items.push(...batch);
    if (batch.length < 100) break;
    offset += 100;
    await new Promise(r => setTimeout(r, 200));
  }
  const seen = new Set();
  return items.filter(i => { if (seen.has(i.id)) return false; seen.add(i.id); return true; });
}

// ════════════════════════════════════════════
// GET /api/webflow — blogs list OR single item
// ════════════════════════════════════════════
app.get('/api/webflow', async (req, res) => {
  try {
    const { collectionId, itemId } = req.query;
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !collectionId) return res.status(400).json({ error: 'Missing credentials' });

    // Single blog fetch
    if (itemId) {
      const r = await fetch(`https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
      });
      const d = await r.json();
      return r.ok ? res.json(d) : res.status(r.status).json(d);
    }

    // All blogs (cached)
    if (isCacheValid(collectionId)) {
      return res.json({ items: blogCache.data, cached: true });
    }
    const items = await fetchAllBlogs(collectionId, token);
    blogCache = { data: items, timestamp: Date.now(), collectionId };
    res.json({ items, cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// PATCH /api/webflow — publish to Webflow
// Sends HTML exactly as received from frontend
// ════════════════════════════════════════════
app.patch('/api/webflow', async (req, res) => {
  try {
    const { collectionId, itemId } = req.query;
    const token = req.headers.authorization?.replace('Bearer ', '');
    const { fieldData } = req.body;
    if (!token || !collectionId || !itemId || !fieldData) return res.status(400).json({ error: 'Missing fields' });

    const url = `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`;
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'accept': 'application/json'
      },
      body: JSON.stringify({ fieldData })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);

    // Invalidate cache
    if (blogCache.collectionId === collectionId) blogCache.timestamp = 0;
    console.log('Published:', itemId);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// BRAVE SEARCH
// ════════════════════════════════════════════
async function braveSearch(query, key, count = 5) {
  if (!key) return [];
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    const res = await fetch(url, { headers: { 'X-Subscription-Token': key, 'Accept': 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.web?.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.description || '', source: 'brave' }));
  } catch { return []; }
}

// ════════════════════════════════════════════
// GOOGLE CUSTOM SEARCH
// ════════════════════════════════════════════
async function googleSearch(query, key, cx, count = 5) {
  if (!key || !cx) return [];
  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${encodeURIComponent(query)}&num=${count}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || []).map(r => ({ title: r.title, url: r.link, snippet: r.snippet || '', source: 'google' }));
  } catch { return []; }
}

// ════════════════════════════════════════════
// POST /api/smartcheck — Research + Rewrite
// ════════════════════════════════════════════
app.post('/api/smartcheck', async (req, res) => {
  try {
    const {
      blogContent, title, slug,
      anthropicKey, braveKey, googleKey, googleCx,
      gscKeywords
    } = req.body;

    if (!blogContent || !anthropicKey) return res.status(400).json({ error: 'Missing required fields' });

    const anthropic = new Anthropic({ apiKey: anthropicKey });
    const t0 = Date.now();
    let searchCount = 0;

    // ── 1. Generate search queries ──
    console.log('=== Stage 1: Query Gen ===');
    const qRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: `Generate 6-8 search queries to fact-check: "${title}"

BLOG EXCERPT:
${blogContent.substring(0, 4000)}

Return ONLY a JSON array of strings. Focus on:
- Official pricing pages (site:company.com pricing)
- Product feature updates (product 2025 features)
- Stats and claims verification
- Competitor info mentioned
Include year 2025/2026 for latest info.` }]
    });

    let queries = [];
    try {
      const raw = qRes.content[0].text.replace(/```json\n?|```\n?/g, '').trim();
      queries = JSON.parse(raw);
    } catch {
      const m = qRes.content[0].text.match(/\[[\s\S]*?\]/);
      queries = m ? JSON.parse(m[0]) : [];
    }
    console.log(`  ${queries.length} queries generated`);

    // ── 2. Run Brave + Google searches ──
    console.log('=== Stage 2: Search ===');
    let allResults = [];

    for (const q of queries.slice(0, 8)) {
      const [b, g] = await Promise.all([
        braveSearch(q, braveKey, 3),
        googleSearch(q, googleKey, googleCx, 3)
      ]);
      searchCount++;
      allResults.push({ query: q, results: [...b, ...g] });
      await new Promise(r => setTimeout(r, 150));
    }

    // Dedupe
    const seen = new Set();
    const unique = [];
    for (const grp of allResults) {
      for (const r of grp.results) {
        if (!seen.has(r.url)) { seen.add(r.url); unique.push({ ...r, query: grp.query }); }
      }
    }
    console.log(`  ${unique.length} unique results from ${searchCount} searches`);

    // ── 3. Claude rewrite ──
    console.log('=== Stage 3: Rewrite ===');

    const research = unique.map(r =>
      `[${r.source?.toUpperCase()}] ${r.title}\nURL: ${r.url}\n${r.snippet}`
    ).join('\n\n');

    let gscBlock = '';
    if (gscKeywords?.length > 0) {
      gscBlock = `

GSC KEYWORDS TO INTEGRATE:
${gscKeywords.map(k => `- "${k.keyword}" (Pos ${k.position}, ${k.clicks} clicks)`).join('\n')}

GSC RULES:
- Work keywords into EXISTING H2/H3 headings where natural — change heading text to include the keyword
- Add a short paragraph for keywords with no existing coverage
- For question keywords (who/what/how/why/is/can/does), add an FAQ at bottom: <h2>Frequently Asked Questions</h2> with <h3>question</h3><p>answer</p> pairs
- Do NOT keyword-stuff — text must read naturally`;
    }

    const rwRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000,
      messages: [{ role: 'user', content: `You are an expert blog content updater. Rewrite this blog using the research below.

TITLE: ${title}

CURRENT HTML:
${blogContent}

RESEARCH:
${research}
${gscBlock}

ABSOLUTE RULES — violating any is a failure:
1. Return ONLY the updated HTML. No markdown fences. No explanation.
2. PRESERVE every HTML tag, class, id, data attribute EXACTLY as-is unless fixing a fact.
3. PRESERVE all heading levels (h1-h6). Only change heading TEXT for GSC keywords or factual fixes.
4. PRESERVE every <ul>, <ol>, <li> with ALL attributes (role, class, style, etc).
5. PRESERVE every <strong>, <em>, <b>, <i> tag.
6. PRESERVE every <a> with href, target, rel attributes.
7. PRESERVE every <img> with src, alt, loading, width, height, class, style attributes.
8. PRESERVE every <iframe>, <video>, <figure>, <figcaption>, <div>, embedded widget, script.
9. Fix outdated facts (pricing, features, stats) using research data.
10. New lists MUST use: <ul role="list"><li role="listitem">text</li></ul>
11. New bold = <strong>, new italic = <em>. Never markdown.
12. Use active voice. Remove em-dashes. Use contractions where natural.
13. NEVER strip attributes from any existing element.
14. NEVER convert HTML to markdown.` }]
    });

    let updated = rwRes.content[0].text;
    if (updated.startsWith('```')) updated = updated.replace(/^```(?:html)?\n?/, '').replace(/\n?```$/, '');
    updated = updated.trim();

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`Done in ${elapsed}s`);

    res.json({
      updatedContent: updated,
      stats: { searches: searchCount, results: unique.length, elapsed, gscKeywords: gscKeywords?.length || 0 },
      research: unique.slice(0, 15)
    });
  } catch (err) {
    console.error('Smart check error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// HEALTH
// ════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    cache: blogCache.data ? { count: blogCache.data.length, ageSeconds: Math.round((Date.now() - (blogCache.timestamp || 0)) / 1000) } : null
  });
});

app.listen(PORT, () => console.log(`Server on port ${PORT}`));
