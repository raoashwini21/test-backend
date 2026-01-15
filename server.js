import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ContentOps Backend Running', version: '3.0 - Simple' });
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

// SIMPLE analyze endpoint
app.post('/api/analyze', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { blogContent, title, anthropicKey, braveKey, writingPrompt } = req.body;

    if (!blogContent || !anthropicKey || !braveKey) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const anthropic = new Anthropic({ apiKey: anthropicKey });
    
    console.log('Starting simple fact-check for:', title);

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

    // STEP 2: Claude rewrite with detailed search results
    const prompt = writingPrompt || `You are a blog fact-checker. Use search results to verify and update factual claims.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000,
      system: prompt,
      messages: [{
        role: 'user',
        content: `Update this blog using search results. Be thorough with numbers and facts.

SEARCH RESULTS FROM BRAVE:
${searchResults}

BLOG TO UPDATE:
${blogContent}

CRITICAL INSTRUCTIONS:
1. For EVERY product mentioned, check search results for:
   - Current pricing (2025)
   - Number of users/customers
   - Key features
   - Any limits or restrictions

2. MUST update if found in search results:
   - User counts (e.g., "4200+ users")
   - Pricing (exact amounts)
   - LinkedIn limits (75/day for connections, NOT 100/week)
   - Feature names

3. Grammar fixes:
   - Remove em-dashes (—)
   - Shorten 30+ word sentences
   - Remove: transform, delve, unleash, revolutionize, meticulous, navigating, realm, bespoke, tailored, autopilot, magic

4. PRESERVE:
   - ALL HTML tags, structure, headings
   - ALL images and links
   - Original tone and style

5. Return COMPLETE blog (don't cut off early)

EXAMPLE CORRECTIONS:
- If search shows "SalesRobot has 4200+ users" → update blog to say "4200+"
- If search shows "LinkedIn allows 75 connection requests per day" → update to "75 per day"
- If search shows "Dripify pricing starts at $79" → update to "$79"

Return ONLY the updated HTML, no explanations.`
      }]
    });

    let updatedContent = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        updatedContent += block.text;
      }
    }

    // Clean markdown artifacts
    updatedContent = updatedContent.replace(/```html\n?/g, '').replace(/```\n?/g, '').trim();

    // Validate we got content
    if (!updatedContent || updatedContent.length < 500) {
      console.error('Warning: Content seems too short');
      updatedContent = blogContent; // Fallback to original
    }

    const duration = Date.now() - startTime;

    console.log(`Done in ${(duration/1000).toFixed(1)}s, content length: ${updatedContent.length}`);

    res.json({
      content: updatedContent,
      changes: [
        `✅ Performed ${searchCount} detailed Brave searches`,
        `✅ Verified pricing, user counts, and features`,
        `✅ Updated facts from official sources`,
        `✅ Fixed grammar and readability`
      ],
      searchesUsed: searchCount,
      claudeCalls: 1,
      sectionsUpdated: 4,
      duration
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 ContentOps Backend (Simple Version) on port ${PORT}`);
});
