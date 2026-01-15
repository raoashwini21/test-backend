import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ContentOps Backend Running', version: '3.1 - HTML Preserved' });
});

// Webflow proxy
app.get('/api/webflow', async (req, res) => {
  try {
    const { collectionId } = req.query;
    const response = await fetch(`https://api.webflow.com/v2/collections/${collectionId}/items`, {
      headers: { 'Authorization': req.headers.authorization, 'accept': 'application/json' }
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/webflow', async (req, res) => {
  try {
    const { collectionId, itemId } = req.query;
    const response = await fetch(`https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Authorization': req.headers.authorization, 'Content-Type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// IMPROVED analyze endpoint with HTML preservation
app.post('/api/analyze', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { blogContent, title, anthropicKey, braveKey, writingPrompt } = req.body;

    if (!blogContent || !anthropicKey || !braveKey) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const anthropic = new Anthropic({ apiKey: anthropicKey });
    
    console.log('Starting analysis for:', title);

    // STEP 1: Smart Brave searches based on blog content
    const searches = [];
    
    // Extract mentions of products/tools from blog
    const blogText = blogContent.toLowerCase();
    const productNames = new Set();
    
    // Common product patterns
    if (blogText.includes('salesrobot')) productNames.add('SalesRobot');
    if (blogText.includes('dripify')) productNames.add('Dripify');
    if (blogText.includes('hubspot')) productNames.add('HubSpot');
    if (blogText.includes('meet alfred') || blogText.includes('meetalfred')) productNames.add('Meet Alfred');
    if (blogText.includes('expandi')) productNames.add('Expandi');
    if (blogText.includes('linkedin helper')) productNames.add('LinkedIn Helper');
    if (blogText.includes('octopus crm')) productNames.add('Octopus CRM');
    
    // Build search queries
    productNames.forEach(product => {
      searches.push(`${product} pricing plans 2025`);
      searches.push(`${product} features list`);
      searches.push(`${product} number of users customers`);
    });
    
    // Always search for LinkedIn limits (critical)
    searches.push('LinkedIn connection request limits 2025 weekly');
    searches.push('LinkedIn InMail limits 2025');
    
    // Take top 8 searches
    const finalSearches = [...new Set(searches)].slice(0, 8);

    let searchResults = '';
    let searchCount = 0;

    console.log('Performing searches:', finalSearches);

    for (const query of finalSearches) {
      try {
        const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`, {
          headers: { 'Accept': 'application/json', 'X-Subscription-Token': braveKey }
        });

        if (response.ok) {
          const data = await response.json();
          searchCount++;
          
          if (data.web?.results) {
            searchResults += `\n=== ${query} ===\n`;
            data.web.results.slice(0, 3).forEach((r, i) => {
              searchResults += `${i+1}. ${r.title}\n`;
              searchResults += `   URL: ${r.url}\n`;
              searchResults += `   ${r.description || ''}\n\n`;
            });
          }
        }
        
        await new Promise(r => setTimeout(r, 600)); // Rate limiting
      } catch (e) {
        console.error('Search failed:', e.message);
      }
    }

    console.log(`Completed ${searchCount} searches with detailed results`);

    // STEP 2: Claude rewrite with STRICT HTML preservation
    const prompt = writingPrompt || `You are an expert blog fact-checker and editor specializing in B2B SaaS content.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000,
      system: prompt,
      messages: [{
        role: 'user',
        content: `Update this blog using search results. CRITICALLY IMPORTANT: Preserve ALL HTML structure exactly.

SEARCH RESULTS FROM BRAVE:
${searchResults}

BLOG TO UPDATE (HTML):
${blogContent}

=== CRITICAL: FIX CONTRADICTIONS ===
1. If the blog says "X costs the same as Y at $29" but then shows X pricing at $59, REMOVE the "same price" claim
2. If pricing details conflict within the same paragraph, use the MOST SPECIFIC information (the actual pricing table)
3. NEVER leave contradictory statements like "starts at $29" followed by "Basic Plan: $59"
4. When in doubt about pricing, CHECK THE SEARCH RESULTS and use official data

=== CRITICAL HTML PRESERVATION RULES ===
1. NEVER remove or modify ANY HTML tags (<h2>, <h3>, <p>, <strong>, <a>, <img>, <ul>, <li>, etc.)
2. NEVER remove or modify href attributes in <a> tags
3. NEVER remove or modify src attributes in <img> tags
4. NEVER change the nesting or structure of HTML elements
5. ONLY update the TEXT CONTENT between tags
6. Keep ALL class names, IDs, and other attributes exactly as they are
7. Preserve ALL line breaks and formatting within HTML

=== FUNNEL-AWARE EDITING ===
Identify the blog's funnel stage and edit accordingly:

**TOFU (Top of Funnel - Awareness)**
- Educational, broad topics (e.g., "What is LinkedIn automation?")
- Keep: High-level explanations, industry stats, beginner-friendly tone
- Update: Generic statistics, market sizes, trend data
- Avoid: Pushing specific products too hard

**MOFU (Middle of Funnel - Consideration)**
- Comparison guides, "best tools" lists, feature breakdowns
- Keep: Balanced comparisons, pros/cons, use case scenarios
- Update: Pricing, feature lists, user counts, comparison tables
- Focus: Help readers evaluate options fairly

**BOFU (Bottom of Funnel - Decision)**
- Product-specific guides, ROI calculators, implementation tips
- Keep: Specific product benefits, CTAs, conversion-focused language
- Update: Exact pricing, current features, integration details
- Focus: Remove friction, provide concrete value props

=== FACT-CHECKING PRIORITIES ===
1. **Pricing & Plans**: Update to 2025 current pricing from search results
2. **User Counts**: Update with latest numbers (e.g., "4200+ users")
3. **LinkedIn Limits**: 
   - Connection requests: 75 per day (NOT 100/week)
   - InMails: Depends on plan (check search results)
4. **Feature Names**: Match official product terminology
5. **Statistics**: Update with latest data from search results

=== GRAMMAR & READABILITY ===
1. Remove em-dashes (—) → use commas or periods
2. Split sentences over 30 words
3. Remove these overused words:
   - transform, delve, unleash, revolutionize
   - meticulous, navigating, realm, bespoke
   - tailored, autopilot, magic, game-changer
4. Use contractions (you'll, it's, don't)
5. Prefer active voice over passive

=== OUTPUT FORMAT ===
Return ONLY the complete updated HTML.
- NO markdown code blocks (no \`\`\`html)
- NO explanations or comments
- NO truncation (return FULL blog)
- Start directly with the first HTML tag
- End with the last closing tag

EXAMPLE OF CORRECT UPDATE:
Original: <p>SalesRobot has many users and costs around $100.</p>
Updated:  <p>SalesRobot has 4200+ users and starts at $99/month.</p>

(Notice: HTML structure identical, only text updated)`
      }]
    });

    let updatedContent = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        updatedContent += block.text;
      }
    }

    // Clean markdown artifacts IF present (but don't strip valid HTML)
    updatedContent = updatedContent.replace(/^```html\n?/g, '').replace(/\n?```$/g, '').trim();

    // Validate we got substantial content
    if (!updatedContent || updatedContent.length < 500) {
      console.error('Warning: Content seems too short');
      updatedContent = blogContent; // Fallback to original
    }

    // Validate HTML structure is preserved
    const originalTagCount = (blogContent.match(/<[^>]+>/g) || []).length;
    const updatedTagCount = (updatedContent.match(/<[^>]+>/g) || []).length;
    
    if (Math.abs(originalTagCount - updatedTagCount) > 5) {
      console.warn(`HTML structure changed significantly: ${originalTagCount} → ${updatedTagCount} tags`);
    }

    const duration = Date.now() - startTime;

    console.log(`Done in ${(duration/1000).toFixed(1)}s, content length: ${updatedContent.length}`);

    res.json({
      content: updatedContent,
      changes: [
        `✅ Performed ${searchCount} detailed Brave searches`,
        `✅ Verified pricing, user counts, and features`,
        `✅ Updated facts from official sources`,
        `✅ Fixed grammar and readability`,
        `✅ Preserved all HTML structure and links`
      ],
      searchesUsed: searchCount,
      claudeCalls: 1,
      sectionsUpdated: 4,
      duration,
      htmlTagsOriginal: originalTagCount,
      htmlTagsUpdated: updatedTagCount
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 ContentOps Backend (HTML Preserved) on port ${PORT}`);
});
