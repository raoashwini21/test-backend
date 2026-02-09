import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// Google Search from env (server-side, not client-sent)
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const GOOGLE_CX = process.env.GOOGLE_SEARCH_ENGINE_ID || '';

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ════════════════════════════════════════════
// MULTI-LAYER CACHE
// ════════════════════════════════════════════
const blogCache = new Map();       // collectionId → { data, timestamp }
const BLOG_CACHE_TTL = 10 * 60 * 1000;

const searchCache = new Map();     // queryHash → { data, timestamp }
const SEARCH_CACHE_TTL = 60 * 60 * 1000;

const analysisCache = new Map();   // contentHash → { data, timestamp }
const ANALYSIS_CACHE_TTL = 24 * 60 * 60 * 1000;

// ── In-flight fetch dedup (fixes multi-user race condition) ──
// Key: collectionId → Promise
// When user A starts fetching, user B awaits the SAME promise
const inflight = new Map();

function hash(str) {
  let h = 0;
  for (let i = 0; i < Math.min(str.length, 5000); i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h = h & h;
  }
  return h.toString(36);
}

function cacheGet(map, key, ttl) {
  const e = map.get(key);
  if (!e || (Date.now() - e.ts) > ttl) return null;
  return e.data;
}

function cacheSet(map, key, data) {
  map.set(key, { data, ts: Date.now() });
}

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of blogCache) if (now - v.ts > BLOG_CACHE_TTL) blogCache.delete(k);
  for (const [k, v] of searchCache) if (now - v.ts > SEARCH_CACHE_TTL) searchCache.delete(k);
  for (const [k, v] of analysisCache) if (now - v.ts > ANALYSIS_CACHE_TTL) analysisCache.delete(k);
}, 5 * 60 * 1000);

// ════════════════════════════════════════════
// RATE LIMITING
// ════════════════════════════════════════════
const rateMap = new Map();
const RATE_WINDOW = 60_000;
const RATE_MAX = 30;

function rateOk(ip) {
  const now = Date.now();
  const r = rateMap.get(ip);
  if (!r || now > r.reset) { rateMap.set(ip, { count: 1, reset: now + RATE_WINDOW }); return true; }
  if (r.count >= RATE_MAX) return false;
  r.count++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateMap) if (now > v.reset) rateMap.delete(k);
}, 2 * 60 * 1000);

// ════════════════════════════════════════════
// FETCH WITH TIMEOUT + RETRY
// ════════════════════════════════════════════
async function fetchR(url, opts = {}, timeout = 30000, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), timeout);
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(tid);
      return r;
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** (i - 1), 5000)));
    }
  }
}

// ════════════════════════════════════════════
// FETCH ALL BLOGS (with dedup for concurrent users)
// ════════════════════════════════════════════
async function fetchAllBlogs(collectionId, token) {
  // Check cache first
  const cached = cacheGet(blogCache, collectionId, BLOG_CACHE_TTL);
  if (cached) return cached;

  // If another request is already fetching this collection, wait for it
  if (inflight.has(collectionId)) {
    console.log(`  Waiting for in-flight fetch of ${collectionId}...`);
    return inflight.get(collectionId);
  }

  // Start fetch and store the promise so others can await it
  const fetchPromise = (async () => {
    console.log('Fetching all blogs from Webflow...');
    const items = [];
    let offset = 0;

    while (true) {
      const r = await fetchR(
        `https://api.webflow.com/v2/collections/${collectionId}/items?limit=100&offset=${offset}`,
        { headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' } },
        30000, 3
      );
      if (!r.ok) throw new Error(`Webflow ${r.status}: ${await r.text()}`);
      const d = await r.json();
      const batch = d.items || [];
      items.push(...batch);
      if (batch.length < 100) break;
      offset += 100;
      await new Promise(r => setTimeout(r, 300));
    }

    // Dedup
    const seen = new Set();
    const unique = items.filter(i => { if (seen.has(i.id)) return false; seen.add(i.id); return true; });
    console.log(`Fetched ${unique.length} unique blogs`);

    // Cache
    cacheSet(blogCache, collectionId, unique);
    return unique;
  })();

  inflight.set(collectionId, fetchPromise);

  try {
    const result = await fetchPromise;
    return result;
  } finally {
    // Always clean up inflight, even on error
    inflight.delete(collectionId);
  }
}

// ════════════════════════════════════════════
// WIDGET PROTECTION
// ════════════════════════════════════════════
function protectWidgets(html) {
  const widgets = [];
  const safe = html.replace(
    /(<(?:iframe|script|embed|object)[^>]*>(?:[\s\S]*?<\/(?:iframe|script|embed|object)>)?)|(<div[^>]*class="[^"]*(?:w-embed|w-widget|widget|embed)[^"]*"[^>]*>[\s\S]*?<\/div>)|(<figure[^>]*>[\s\S]*?<\/figure>)|(<video[^>]*>[\s\S]*?<\/video>)/gi,
    (m) => { const id = `___WIDGET_${widgets.length}___`; widgets.push(m); return id; }
  );
  return { html: safe, widgets };
}

function restoreWidgets(html, widgets) {
  let out = html;
  widgets.forEach((w, i) => { out = out.replace(`___WIDGET_${i}___`, w); });
  return out;
}

// ════════════════════════════════════════════
// GET /api/webflow
// ════════════════════════════════════════════
app.get('/api/webflow', async (req, res) => {
  try {
    const ip = req.ip || req.connection?.remoteAddress;
    if (!rateOk(ip)) return res.status(429).json({ error: 'Too many requests. Wait a minute.' });

    const { collectionId, itemId } = req.query;
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !collectionId) return res.status(400).json({ error: 'Missing credentials' });

    // Single item
    if (itemId) {
      const r = await fetchR(
        `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`,
        { headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' } },
        15000, 2
      );
      const d = await r.json();
      return r.ok ? res.json(d) : res.status(r.status).json(d);
    }

    // All blogs (with dedup)
    const items = await fetchAllBlogs(collectionId, token);
    const fromCache = !!cacheGet(blogCache, collectionId, BLOG_CACHE_TTL);

    // Auto-detect siteId from collection info (needed for image uploads)
    let siteId = null;
    try {
      const colRes = await fetchR(
        `https://api.webflow.com/v2/collections/${collectionId}`,
        { headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' } },
        10000, 1
      );
      if (colRes.ok) {
        const colData = await colRes.json();
        siteId = colData.siteId || null;
      }
    } catch (e) {
      console.warn('Could not fetch siteId:', e.message);
    }

    res.json({ items, cached: fromCache, siteId });

  } catch (err) {
    console.error('Webflow fetch error:', err.message);
    if (err.name === 'AbortError') return res.status(408).json({ error: 'Timeout. Try again.', type: 'timeout' });
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// PATCH /api/webflow
// ════════════════════════════════════════════
app.patch('/api/webflow', async (req, res) => {
  try {
    const ip = req.ip || req.connection?.remoteAddress;
    if (!rateOk(ip)) return res.status(429).json({ error: 'Too many requests.' });

    const { collectionId, itemId } = req.query;
    const token = req.headers.authorization?.replace('Bearer ', '');
    const { fieldData } = req.body;
    if (!token || !collectionId || !itemId || !fieldData) return res.status(400).json({ error: 'Missing fields' });

    const r = await fetchR(
      `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`,
      { method: 'PATCH', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'accept': 'application/json' }, body: JSON.stringify({ fieldData }) },
      60000, 3
    );
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json(d);

    // Invalidate cache
    blogCache.delete(collectionId);
    console.log('Published:', itemId);
    res.json(d);
  } catch (err) {
    console.error('Publish error:', err.message);
    if (err.name === 'AbortError') return res.status(408).json({ error: 'Publish timeout.', type: 'timeout' });
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// IMAGE UPLOAD TO WEBFLOW
// Add this AFTER the app.patch('/api/webflow') block
// and BEFORE the app.post('/api/analyze') block
// ============================================
app.post('/api/upload-image', async (req, res) => {
  try {
    const { image, filename, siteId } = req.body;
    const webflowToken = req.headers.authorization?.replace('Bearer ', '');

    if (!webflowToken || !image || !filename || !siteId) {
      return res.status(400).json({ error: 'Missing fields (need image, filename, siteId)' });
    }

    // Parse base64 image
    const matches = image.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'Invalid image format' });

    const [, ext, b64] = matches;
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Max 5MB' });

    // Build multipart form
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('file', buf, {
      filename: filename.replace(/[^a-zA-Z0-9.-]/g, '_'),
      contentType: `image/${ext}`
    });

    console.log(`📤 Uploading ${filename} (${(buf.length / 1024).toFixed(0)}KB) to Webflow...`);

    const response = await fetch(`https://api.webflow.com/v2/sites/${siteId}/assets`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${webflowToken}`,
        ...form.getHeaders()
      },
      body: form
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Webflow upload error:', errBody);
      throw new Error(`Upload failed: ${response.status}`);
    }

    const data = await response.json();
    console.log('✅ Image uploaded:', data.publicUrl || data.url);

    res.json({ url: data.publicUrl || data.url, assetId: data.id });
  } catch (error) {
    console.error('Upload error:', error.message);
    res.status(500).json({ error: error.message });
  }
});
// ════════════════════════════════════════════
// SEARCH (cached)
// ════════════════════════════════════════════
async function braveSearch(query, key, count = 5) {
  if (!key) return [];
  const ck = `b:${hash(query)}`;
  const c = cacheGet(searchCache, ck, SEARCH_CACHE_TTL);
  if (c) return c;
  try {
    const r = await fetchR(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
      { headers: { 'X-Subscription-Token': key, 'Accept': 'application/json' } }, 10000, 2);
    if (!r.ok) return [];
    const d = await r.json();
    const results = (d.web?.results || []).map(x => ({ title: x.title, url: x.url, snippet: x.description || '', source: 'brave' }));
    cacheSet(searchCache, ck, results);
    return results;
  } catch { return []; }
}

async function googleSearch(query, count = 5) {
  if (!GOOGLE_API_KEY || !GOOGLE_CX) return [];
  const ck = `g:${hash(query)}`;
  const c = cacheGet(searchCache, ck, SEARCH_CACHE_TTL);
  if (c) return c;
  try {
    const r = await fetchR(`https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(query)}&num=${count}`, {}, 10000, 2);
    if (!r.ok) return [];
    const d = await r.json();
    const results = (d.items || []).map(x => ({ title: x.title, url: x.link, snippet: x.snippet || '', source: 'google' }));
    cacheSet(searchCache, ck, results);
    return results;
  } catch { return []; }
}

// ════════════════════════════════════════════
// POST /api/smartcheck
// ════════════════════════════════════════════
app.post('/api/smartcheck', async (req, res) => {
  try {
    const ip = req.ip || req.connection?.remoteAddress;
    if (!rateOk(ip)) return res.status(429).json({ error: 'Too many requests.' });

    const { blogContent, title, anthropicKey, braveKey, gscKeywords } = req.body;
    if (!blogContent || !anthropicKey) return res.status(400).json({ error: 'Missing fields' });

    // Check analysis cache
    const contentKey = hash(blogContent + JSON.stringify(gscKeywords || []));
    const cachedResult = cacheGet(analysisCache, contentKey, ANALYSIS_CACHE_TTL);
    if (cachedResult) {
      console.log('Serving cached analysis');
      return res.json({ ...cachedResult, fromCache: true });
    }

    const anthropic = new Anthropic({ apiKey: anthropicKey });
    const t0 = Date.now();
    let searchCount = 0;

    // ── Step 0: Widget protection ──
    const { html: protectedContent, widgets } = protectWidgets(blogContent);
    console.log(`Protected ${widgets.length} widgets`);

    // ── Step 1: Generate queries ──
    console.log('=== Queries ===');
    const qRes = await Promise.race([
      anthropic.messages.create({
        model: 'claude-sonnet-4-20250514', max_tokens: 2000,
        messages: [{ role: 'user', content: `Generate 6-8 search queries to fact-check: "${title}"

BLOG EXCERPT:
${protectedContent.substring(0, 4000)}

Return ONLY a JSON array of strings. Focus on:
- Official pricing pages (site:company.com pricing)
- Product feature updates 2025/2026
- Stats and claims verification
- Competitor info
If SalesRobot mentioned, include "site:salesrobot.co features 2025".` }]
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Query timeout')), 30000))
    ]);

    let queries = [];
    try {
      queries = JSON.parse(qRes.content[0].text.replace(/```json\n?|```\n?/g, '').trim());
    } catch {
      const m = qRes.content[0].text.match(/\[[\s\S]*?\]/);
      queries = m ? JSON.parse(m[0]) : [];
    }
    console.log(`${queries.length} queries`);

    // ── Step 2: Parallel search (batched) ──
    console.log('=== Search ===');
    let allResults = [];
    const batch = 3;
    for (let i = 0; i < Math.min(queries.length, 8); i += batch) {
      const slice = queries.slice(i, i + batch);
      const results = await Promise.all(slice.map(async q => {
        const [b, g] = await Promise.all([braveSearch(q, braveKey, 3), googleSearch(q, 3)]);
        searchCount++;
        return { query: q, results: [...b, ...g] };
      }));
      allResults.push(...results);
      if (i + batch < Math.min(queries.length, 8)) await new Promise(r => setTimeout(r, 500));
    }

    // Dedup results
    const seen = new Set();
    const unique = [];
    for (const g of allResults) for (const r of g.results) {
      if (!seen.has(r.url)) { seen.add(r.url); unique.push({ ...r, query: g.query }); }
    }
    console.log(`${unique.length} unique results from ${searchCount} searches`);

    // ── Step 3: Claude rewrite ──
    console.log('=== Rewrite ===');
    const research = unique.map(r => `[${r.source?.toUpperCase()}] ${r.title}\nURL: ${r.url}\n${r.snippet}`).join('\n\n');

    let gscBlock = '';
    if (gscKeywords?.length > 0) {
      gscBlock = `\n\nGSC KEYWORDS TO INTEGRATE:\n${gscKeywords.map(k => `- "${k.keyword}" (Pos ${k.position}, ${k.clicks} clicks)`).join('\n')}

GSC RULES:
- Work keywords into EXISTING H2/H3 headings where natural
- Add a short paragraph for keywords with no existing coverage
- For question keywords (who/what/how/why/is/can/does), add FAQ at bottom: <h2>Frequently Asked Questions</h2> with <h3>question</h3><p>answer</p> pairs
- Do NOT keyword-stuff`;
    }

    const rwRes = await Promise.race([
      anthropic.messages.create({
        model: 'claude-sonnet-4-20250514', max_tokens: 16000,
        messages: [{ role: 'user', content: `You are an expert blog content updater. Rewrite this blog using the research below.

TITLE: ${title}

CURRENT HTML:
${protectedContent}

RESEARCH:
${research}
${gscBlock}

ABSOLUTE RULES:
1. Return ONLY updated HTML. No markdown fences. No explanation before or after.
2. PRESERVE every HTML tag, class, id, data-*, style attribute EXACTLY.
3. PRESERVE all heading levels (h1-h6). Only change heading TEXT for GSC keywords or factual fixes.
4. PRESERVE every <ul>, <ol>, <li> with ALL attributes (role, class, style).
5. PRESERVE every <strong>, <em>, <b>, <i> tag — NEVER strip bold/italic.
6. PRESERVE every <a> with href, target, rel.
7. PRESERVE every <img> with src, alt, loading, width, height, class.
8. PRESERVE every ___WIDGET_N___ placeholder EXACTLY as-is.
9. Fix outdated facts (pricing, features, stats) using research.
10. New lists: <ul role="list"><li role="listitem">text</li></ul>
11. New bold = <strong>, new italic = <em>. Never markdown.
12. Active voice. Remove em-dashes. Use contractions.
13. NEVER strip attributes from existing elements.
14. NEVER remove or modify ___WIDGET_N___ markers.` }]
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Rewrite timeout')), 120000))
    ]);

    let updated = rwRes.content[0].text;
    if (updated.startsWith('```')) updated = updated.replace(/^```(?:html)?\n?/, '').replace(/\n?```$/, '');
    updated = updated.trim();

    // ── Step 4: Restore widgets ──
    updated = restoreWidgets(updated, widgets);
    console.log(`Restored ${widgets.length} widgets`);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`Done in ${elapsed}s`);

    const result = {
      updatedContent: updated,
      stats: { searches: searchCount, results: unique.length, elapsed, gscKeywords: gscKeywords?.length || 0, widgetsProtected: widgets.length },
      research: unique.slice(0, 15)
    };

    cacheSet(analysisCache, contentKey, result);
    res.json(result);

  } catch (err) {
    console.error('SmartCheck error:', err.message);
    if (err.message.includes('timeout')) return res.status(408).json({ error: 'Analysis timeout. Try a shorter post.', type: 'timeout' });
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// HEALTH
// ════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    caches: { blogs: blogCache.size, search: searchCache.size, analysis: analysisCache.size },
    inflight: inflight.size,
    google: GOOGLE_API_KEY ? 'ON' : 'OFF'
  });
});

app.listen(PORT, () => {
  console.log(`ContentOps backend: port ${PORT}`);
  console.log(`Google: ${GOOGLE_API_KEY ? 'ON' : 'OFF'} | Brave: client-key | Cache: ON`);
});
