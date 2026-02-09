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
// MULTI-LAYER CACHE SYSTEM
// ════════════════════════════════════════════
const blogCache = new Map(); // Key: collectionId, Value: { data, timestamp }
const BLOG_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

const searchResultsCache = new Map(); // Key: query hash, Value: { results, timestamp }
const SEARCH_CACHE_TTL = 60 * 60 * 1000; // 1 hour

const analysisCache = new Map(); // Key: blog content hash, Value: { result, timestamp }
const ANALYSIS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Simple hash function for cache keys
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

function isCacheValid(cache, key, ttl) {
  const entry = cache.get(key);
  if (!entry) return false;
  return (Date.now() - entry.timestamp) < ttl;
}

function getFromCache(cache, key, ttl) {
  if (!isCacheValid(cache, key, ttl)) return null;
  return cache.get(key).data;
}

function setCache(cache, key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

// Clean old cache entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of blogCache.entries()) {
    if (now - value.timestamp > BLOG_CACHE_TTL) blogCache.delete(key);
  }
  for (const [key, value] of searchResultsCache.entries()) {
    if (now - value.timestamp > SEARCH_CACHE_TTL) searchResultsCache.delete(key);
  }
  for (const [key, value] of analysisCache.entries()) {
    if (now - value.timestamp > ANALYSIS_CACHE_TTL) analysisCache.delete(key);
  }
}, 5 * 60 * 1000); // Clean every 5 minutes

// ════════════════════════════════════════════
// RATE LIMITING
// ════════════════════════════════════════════
const rateLimitMap = new Map(); // Key: IP, Value: { count, resetTime }
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 30; // 30 requests per minute

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  
  if (!record || now > record.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }
  
  if (record.count >= MAX_REQUESTS_PER_WINDOW) {
    return false;
  }
  
  record.count++;
  return true;
}

// Clean rate limit map periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now > record.resetTime) rateLimitMap.delete(ip);
  }
}, 2 * 60 * 1000); // Clean every 2 minutes

// ════════════════════════════════════════════
// FETCH WITH TIMEOUT & RETRY
// ════════════════════════════════════════════
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      return response;
      
    } catch (error) {
      if (attempt === retries) throw error;
      
      // Exponential backoff
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
      console.log(`Retry ${attempt}/${retries} after ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function fetchAllBlogs(collectionId, token) {
  console.log('Fetching blogs from Webflow...');
  const items = [];
  let offset = 0;
  
  while (true) {
    const url = `https://api.webflow.com/v2/collections/${collectionId}/items?limit=100&offset=${offset}`;
    
    const res = await fetchWithTimeout(url, {
      headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
    }, 30000, 3);
    
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Webflow ${res.status}: ${errorText}`);
    }
    
    const data = await res.json();
    const batch = data.items || [];
    items.push(...batch);
    
    if (batch.length < 100) break;
    offset += 100;
    
    // Rate limit: wait between requests
    await new Promise(r => setTimeout(r, 300));
  }
  
  const seen = new Set();
  return items.filter(i => { if (seen.has(i.id)) return false; seen.add(i.id); return true; });
}

// ════════════════════════════════════════════
// WIDGET PROTECTION - Prevents Claude from stripping embeds
// ════════════════════════════════════════════
function protectWidgets(html) {
  const widgets = [];
  const protectedHtml = html.replace(
    /(<(?:iframe|script|embed|object)[^>]*>(?:[\s\S]*?<\/(?:iframe|script|embed|object)>)?)|(<div[^>]*class="[^"]*(?:w-embed|w-widget|widget|embed)[^"]*"[^>]*>[\s\S]*?<\/div>)|(<figure[^>]*>[\s\S]*?<\/figure>)|(<video[^>]*>[\s\S]*?<\/video>)/gi,
    (match) => {
      const id = `___WIDGET_${widgets.length}___`;
      widgets.push(match);
      return id;
    }
  );
  return { protectedHtml, widgets };
}

function restoreWidgets(html, widgets) {
  let restored = html;
  widgets.forEach((widget, i) => {
    restored = restored.replace(`___WIDGET_${i}___`, widget);
  });
  return restored;
}

// ════════════════════════════════════════════
// GET /api/webflow — blogs list OR single item
// ════════════════════════════════════════════
app.get('/api/webflow', async (req, res) => {
  try {
    const clientIp = req.ip || req.connection.remoteAddress;
    
    // Rate limiting
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ 
        error: 'Too many requests. Please wait a minute.' 
      });
    }
    
    const { collectionId, itemId } = req.query;
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token || !collectionId) {
      return res.status(400).json({ error: 'Missing credentials' });
    }

    // Single blog fetch
    if (itemId) {
      const r = await fetchWithTimeout(
        `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`,
        { headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' } },
        15000,
        2
      );
      const d = await r.json();
      return r.ok ? res.json(d) : res.status(r.status).json(d);
    }

    // Check cache first
    const cacheKey = collectionId;
    const cached = getFromCache(blogCache, cacheKey, BLOG_CACHE_TTL);
    if (cached) {
      console.log(`Serving ${cached.length} blogs from cache`);
      return res.json({ items: cached, cached: true });
    }

    // Fetch all blogs
    const items = await fetchAllBlogs(collectionId, token);
    setCache(blogCache, cacheKey, items);
    
    console.log(`Fetched and cached ${items.length} blogs`);
    res.json({ items, cached: false });
    
  } catch (err) {
    console.error('Webflow fetch error:', err);
    
    if (err.name === 'AbortError') {
      return res.status(408).json({ 
        error: 'Request timeout. Please try again.',
        type: 'timeout'
      });
    }
    
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// PATCH /api/webflow — publish to Webflow
// ════════════════════════════════════════════
app.patch('/api/webflow', async (req, res) => {
  try {
    const clientIp = req.ip || req.connection.remoteAddress;
    
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
    }
    
    const { collectionId, itemId } = req.query;
    const token = req.headers.authorization?.replace('Bearer ', '');
    const { fieldData } = req.body;
    
    if (!token || !collectionId || !itemId || !fieldData) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const url = `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`;
    const response = await fetchWithTimeout(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'accept': 'application/json'
      },
      body: JSON.stringify({ fieldData })
    }, 60000, 3); // 60 second timeout, 3 retries
    
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);

    // Invalidate cache for this collection
    blogCache.delete(collectionId);
    
    console.log('Published:', itemId);
    res.json(data);
    
  } catch (err) {
    console.error('Publish error:', err);
    
    if (err.name === 'AbortError') {
      return res.status(408).json({ 
        error: 'Publish timeout. Please try again.',
        type: 'timeout'
      });
    }
    
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// POST /api/upload-image — Upload to Webflow Assets
// ════════════════════════════════════════════
app.post('/api/upload-image', async (req, res) => {
  try {
    const clientIp = req.ip || req.connection.remoteAddress;
    
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ error: 'Too many uploads. Please wait a minute.' });
    }
    
    const { image, filename, siteId } = req.body;
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token || !image || !filename) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (!siteId) {
      return res.status(400).json({ 
        error: 'Site ID required. Please reload blogs to get site ID.' 
      });
    }
    
    // Convert base64 to buffer
    const matches = image.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) {
      return res.status(400).json({ error: 'Invalid image format' });
    }
    
    const [, ext, base64Data] = matches;
    const buffer = Buffer.from(base64Data, 'base64');
    
    // Validate size (5MB max)
    if (buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image too large (max 5MB)' });
    }
    
    // Create form data
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    
    // Clean filename
    const cleanFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    
    form.append('file', buffer, {
      filename: cleanFilename,
      contentType: `image/${ext}`
    });
    
    // Upload to Webflow Assets API
    console.log(`Uploading ${cleanFilename} (${(buffer.length / 1024).toFixed(1)}KB) to site ${siteId}...`);
    
    const response = await fetchWithTimeout(
      `https://api.webflow.com/v2/sites/${siteId}/assets`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          ...form.getHeaders()
        },
        body: form
      },
      45000, // 45 second timeout for uploads
      2 // 2 retries
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Webflow upload error:', errorText);
      throw new Error(`Upload failed: ${response.status}`);
    }
    
    const data = await response.json();
    console.log('Upload successful:', data.publicUrl || data.url);
    
    res.json({ 
      url: data.publicUrl || data.url,
      assetId: data.id 
    });
    
  } catch (err) {
    console.error('Image upload error:', err);
    
    if (err.name === 'AbortError') {
      return res.status(408).json({ 
        error: 'Upload timeout. Image may be too large.',
        type: 'timeout'
      });
    }
    
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// BRAVE SEARCH (with caching)
// ════════════════════════════════════════════
async function braveSearch(query, key, count = 5) {
  if (!key) return [];
  
  const cacheKey = `brave:${hashString(query + count)}`;
  const cached = getFromCache(searchResultsCache, cacheKey, SEARCH_CACHE_TTL);
  if (cached) {
    console.log(`  Brave cache hit: "${query}"`);
    return cached;
  }
  
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    const res = await fetchWithTimeout(
      url, 
      { headers: { 'X-Subscription-Token': key, 'Accept': 'application/json' } },
      10000,
      2
    );
    
    if (!res.ok) {
      console.warn(`Brave search failed: ${res.status}`);
      return [];
    }
    
    const data = await res.json();
    const results = (data.web?.results || []).map(r => ({ 
      title: r.title, 
      url: r.url, 
      snippet: r.description || '', 
      source: 'brave' 
    }));
    
    setCache(searchResultsCache, cacheKey, results);
    return results;
    
  } catch (err) {
    console.warn(`Brave search error: ${err.message}`);
    return [];
  }
}

// ════════════════════════════════════════════
// GOOGLE CUSTOM SEARCH (with caching)
// ════════════════════════════════════════════
async function googleSearch(query, key, cx, count = 5) {
  if (!key || !cx) return [];
  
  const cacheKey = `google:${hashString(query + count)}`;
  const cached = getFromCache(searchResultsCache, cacheKey, SEARCH_CACHE_TTL);
  if (cached) {
    console.log(`  Google cache hit: "${query}"`);
    return cached;
  }
  
  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${encodeURIComponent(query)}&num=${count}`;
    const res = await fetchWithTimeout(url, {}, 10000, 2);
    
    if (!res.ok) {
      console.warn(`Google search failed: ${res.status}`);
      return [];
    }
    
    const data = await res.json();
    const results = (data.items || []).map(r => ({ 
      title: r.title, 
      url: r.link, 
      snippet: r.snippet || '', 
      source: 'google' 
    }));
    
    setCache(searchResultsCache, cacheKey, results);
    return results;
    
  } catch (err) {
    console.warn(`Google search error: ${err.message}`);
    return [];
  }
}

// ════════════════════════════════════════════
// POST /api/smartcheck — Research + Rewrite (with caching)
// ════════════════════════════════════════════
app.post('/api/smartcheck', async (req, res) => {
  try {
    const clientIp = req.ip || req.connection.remoteAddress;
    
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ error: 'Too many analysis requests. Please wait a minute.' });
    }
    
    const {
      blogContent, title, slug,
      anthropicKey, braveKey, googleKey, googleCx,
      gscKeywords
    } = req.body;

    if (!blogContent || !anthropicKey) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check analysis cache (based on content hash + GSC keywords)
    const contentHash = hashString(blogContent + JSON.stringify(gscKeywords || []));
    const cachedAnalysis = getFromCache(analysisCache, contentHash, ANALYSIS_CACHE_TTL);
    
    if (cachedAnalysis) {
      console.log('Serving cached analysis');
      return res.json({
        ...cachedAnalysis,
        fromCache: true
      });
    }

    const anthropic = new Anthropic({ apiKey: anthropicKey });
    const t0 = Date.now();
    let searchCount = 0;

    // ── STEP 0: Protect widgets/embeds ──
    console.log('=== Stage 0: Widget Protection ===');
    const { protectedHtml: protectedContent, widgets } = protectWidgets(blogContent);
    console.log(`  Protected ${widgets.length} widgets/embeds from Claude`);

    // ── 1. Generate search queries (with timeout) ──
    console.log('=== Stage 1: Query Gen ===');
    
    const qRes = await Promise.race([
      anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: `Generate 6-8 search queries to fact-check: "${title}"

BLOG EXCERPT:
${protectedContent.substring(0, 4000)}

Return ONLY a JSON array of strings. Focus on:
- Official pricing pages (site:company.com pricing)
- Product feature updates (product 2025 features)
- Stats and claims verification
- Competitor info mentioned
Include year 2025/2026 for latest info.` }]
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Query generation timeout')), 30000)
      )
    ]);

    let queries = [];
    try {
      const raw = qRes.content[0].text.replace(/```json\n?|```\n?/g, '').trim();
      queries = JSON.parse(raw);
    } catch {
      const m = qRes.content[0].text.match(/\[[\s\S]*?\]/);
      queries = m ? JSON.parse(m[0]) : [];
    }
    console.log(`  ${queries.length} queries generated`);

    // ── 2. Run searches (parallel with limits) ──
    console.log('=== Stage 2: Search ===');
    let allResults = [];

    // Process searches in batches of 3 to avoid rate limits
    const batchSize = 3;
    for (let i = 0; i < queries.length && i < 8; i += batchSize) {
      const batch = queries.slice(i, i + batchSize);
      
      const batchResults = await Promise.all(
        batch.map(async q => {
          const [b, g] = await Promise.all([
            braveSearch(q, braveKey, 3),
            googleSearch(q, googleKey, googleCx, 3)
          ]);
          searchCount++;
          return { query: q, results: [...b, ...g] };
        })
      );
      
      allResults.push(...batchResults);
      
      // Wait between batches
      if (i + batchSize < Math.min(queries.length, 8)) {
        await new Promise(r => setTimeout(r, 500));
      }
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

    // ── 3. Claude rewrite (with timeout) ──
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

    const rwRes = await Promise.race([
      anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 16000,
        messages: [{ role: 'user', content: `You are an expert blog content updater. Rewrite this blog using the research below.

TITLE: ${title}

CURRENT HTML:
${protectedContent}

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
8. PRESERVE every placeholder like ___WIDGET_0___, ___WIDGET_1___ etc. These are special markers that must remain unchanged.
9. Fix outdated facts (pricing, features, stats) using research data.
10. New lists MUST use: <ul role="list"><li role="listitem">text</li></ul>
11. New bold = <strong>, new italic = <em>. Never markdown.
12. Use active voice. Remove em-dashes. Use contractions where natural.
13. NEVER strip attributes from any existing element.
14. NEVER convert HTML to markdown.
15. DO NOT remove or modify any ___WIDGET_N___ markers - these are essential placeholders.` }]
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Content rewrite timeout')), 120000)
      )
    ]);

    let updated = rwRes.content[0].text;
    if (updated.startsWith('```')) updated = updated.replace(/^```(?:html)?\n?/, '').replace(/\n?```$/, '');
    updated = updated.trim();

    // ── STEP 4: Restore widgets ──
    console.log('=== Stage 4: Widget Restoration ===');
    updated = restoreWidgets(updated, widgets);
    console.log(`  Restored ${widgets.length} widgets/embeds to final HTML`);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`Done in ${elapsed}s`);

    const result = {
      updatedContent: updated,
      stats: { 
        searches: searchCount, 
        results: unique.length, 
        elapsed, 
        gscKeywords: gscKeywords?.length || 0,
        widgetsProtected: widgets.length 
      },
      research: unique.slice(0, 15)
    };

    // Cache the result
    setCache(analysisCache, contentHash, result);

    res.json(result);
    
  } catch (err) {
    console.error('Smart check error:', err);
    
    if (err.message.includes('timeout')) {
      return res.status(408).json({ 
        error: 'Analysis timeout. Please try again with a shorter blog post.',
        type: 'timeout'
      });
    }
    
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// HEALTH & STATS
// ════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    caches: {
      blogs: blogCache.size,
      searchResults: searchResultsCache.size,
      analyses: analysisCache.size
    },
    rateLimits: {
      activeIPs: rateLimitMap.size
    }
  });
});

app.listen(PORT, () => console.log(`Server on port ${PORT}`));
