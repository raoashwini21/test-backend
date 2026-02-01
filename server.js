const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ===== MAIN ANALYSIS ENDPOINT =====
app.post('/api/analyze', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { 
      blogContent, 
      title, 
      anthropicKey, 
      braveKey, 
      researchPrompt,
      writingPrompt,
      gscKeywords  // NEW: GSC keywords array
    } = req.body;
    
    // Validation
    if (!anthropicKey) {
      return res.status(400).json({ error: 'Anthropic API key missing' });
    }
    
    if (!braveKey) {
      return res.status(400).json({ error: 'Brave API key missing' });
    }
    
    if (!blogContent || !title) {
      return res.status(400).json({ error: 'Blog content and title required' });
    }
    
    console.log('=== ANALYSIS REQUEST ===');
    console.log('Blog title:', title);
    console.log('Content length:', blogContent.length);
    console.log('GSC keywords:', gscKeywords ? gscKeywords.length : 0);
    
    // Build enhanced prompt with GSC data
    let enhancedWritingPrompt = writingPrompt;
    
    if (gscKeywords && gscKeywords.length > 0) {
      // Sort by position (best opportunities first)
      const sortedKeywords = gscKeywords
        .sort((a, b) => a.position - b.position)
        .slice(0, 10); // Top 10 opportunities
      
      const gscSection = `

**CRITICAL: GSC KEYWORD OPTIMIZATION (HIGH PRIORITY)**

You have access to Google Search Console data showing keyword opportunities for this blog.
These keywords are ALREADY ranking but need optimization to rank higher.

Top Keyword Opportunities (Positions 4-20):
${sortedKeywords.map((k, i) => `
${i + 1}. "${k.query}"
   - Current Position: ${k.position.toFixed(1)}
   - Clicks/month: ${k.clicks}
   - Impressions: ${k.impressions}
   ${k.position <= 10 ? '   🎯 HIGH PRIORITY: Almost Page 1!' : ''}
   ${k.position > 10 && k.position <= 15 ? '   🔍 MEDIUM PRIORITY: Good potential' : ''}
   ${k.position > 15 ? '   💡 LOW PRIORITY: Long-term play' : ''}
`).join('')}

**YOUR GSC OPTIMIZATION TASKS:**

1. **Optimize Existing Headings:**
   - If a heading is SIMILAR to a GSC keyword, change it to the EXACT keyword
   - Example: "Top Automation Tools" → "LinkedIn Automation Tools" (if that's the keyword)
   - Keep heading level the same (H2 stays H2)

2. **Add New Sections for Missing Keywords:**
   - If a high-priority keyword is NOT in any heading, add a new section
   - Use the exact keyword as the heading
   - Write 2-3 paragraphs of relevant content

3. **FAQ Sections for Question Keywords:**
   - Keywords starting with "how", "is", "what", "why", "can" = Questions
   - Add as H3 with the exact question
   - Provide a direct answer in the next paragraph

4. **Keyword Integration Rules:**
   - Use EXACT keyword phrases from GSC (don't paraphrase)
   - Make it natural (not keyword-stuffed)
   - Prioritize keywords with position 4-10 (almost Page 1)
   - Add keywords to headings AND body text naturally

5. **What NOT to Do:**
   - Don't change heading hierarchy (H2 → H3 etc)
   - Don't keyword stuff (use each keyword 2-3 times max)
   - Don't remove existing good content
   - Don't force keywords where they don't fit naturally

**REMEMBER:** GSC keywords take PRIORITY over general rewrites. If you must choose between a small style improvement and adding a GSC keyword, ALWAYS add the GSC keyword.
`;
      
      enhancedWritingPrompt = writingPrompt + gscSection;
    }
    
    // Call Claude for analysis
    console.log('Calling Claude API...');
    const claudeResponse = await callClaude({
      blogContent,
      title,
      anthropicKey,
      braveKey,
      researchPrompt,
      writingPrompt: enhancedWritingPrompt
    });
    
    const duration = Date.now() - startTime;
    
    console.log('✅ Analysis complete');
    console.log('Duration:', duration, 'ms');
    console.log('Changes:', claudeResponse.changes?.length || 0);
    
    res.json({
      ...claudeResponse,
      duration,
      gscOptimized: gscKeywords && gscKeywords.length > 0
    });
    
  } catch (error) {
    console.error('❌ Analysis error:', error);
    res.status(500).json({ 
      error: error.message || 'Analysis failed',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// ===== CLAUDE API CALL =====
async function callClaude({ blogContent, title, anthropicKey, braveKey, researchPrompt, writingPrompt }) {
  try {
    // Step 1: Research phase (with Brave Search)
    console.log('Step 1: Research phase with Claude + Brave...');
    
    const researchResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        tools: [{
          type: 'brave_search_20241119',
          name: 'brave_search',
          brave_api_key: braveKey
        }],
        messages: [{
          role: 'user',
          content: `${researchPrompt}

Blog Title: ${title}

Blog Content (first 8000 chars):
${blogContent.substring(0, 8000)}

Please fact-check this content and identify any:
1. Incorrect pricing/features
2. Outdated information
3. Broken or incorrect claims
4. Missing important recent developments

Return your findings as structured JSON with this format:
{
  "factChecks": [
    {
      "issue": "Description of what's wrong",
      "original": "Original text from blog",
      "correction": "Corrected text",
      "source": "URL or source of correct info",
      "priority": "high" | "medium" | "low"
    }
  ],
  "searchesUsed": 5
}`
        }]
      })
    });
    
    if (!researchResponse.ok) {
      const errorData = await researchResponse.json();
      throw new Error(`Claude research failed: ${errorData.error?.message || researchResponse.statusText}`);
    }
    
    const researchData = await researchResponse.json();
    console.log('Research complete:', researchData.usage);
    
    // Extract research findings
    let factChecks = [];
    let searchesUsed = 0;
    
    try {
      const textContent = researchData.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');
      
      // Try to parse JSON from response
      const jsonMatch = textContent.match(/\{[\s\S]*"factChecks"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        factChecks = parsed.factChecks || [];
        searchesUsed = parsed.searchesUsed || 0;
      }
    } catch (e) {
      console.log('Could not parse research JSON, continuing anyway');
    }
    
    console.log(`Found ${factChecks.length} fact-check issues`);
    
    // Step 2: Writing phase (apply corrections + GSC optimizations)
    console.log('Step 2: Applying corrections and GSC optimizations...');
    
    const writingResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 16000,
        messages: [{
          role: 'user',
          content: `${writingPrompt}

Blog Title: ${title}

Original Blog Content:
${blogContent}

${factChecks.length > 0 ? `
Fact-Check Corrections to Apply:
${factChecks.map((fc, i) => `
${i + 1}. ${fc.issue}
   Original: "${fc.original}"
   Correction: "${fc.correction}"
   Source: ${fc.source}
`).join('\n')}
` : ''}

Please rewrite the blog applying:
1. All fact-check corrections above
2. GSC keyword optimizations (if provided in the prompt)
3. Style improvements (remove em-dashes, shorten sentences, etc.)

Return ONLY the complete rewritten HTML content. No explanations, no markdown fences, just the HTML.`
        }]
      })
    });
    
    if (!writingResponse.ok) {
      const errorData = await writingResponse.json();
      throw new Error(`Claude writing failed: ${errorData.error?.message || writingResponse.statusText}`);
    }
    
    const writingData = await writingResponse.json();
    console.log('Writing complete:', writingData.usage);
    
    // Extract updated content
    const updatedContent = writingData.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();
    
    return {
      content: updatedContent,
      originalContent: blogContent,
      changes: factChecks,
      searchesUsed,
      claudeCalls: 2,
      sectionsUpdated: factChecks.length
    };
    
  } catch (error) {
    console.error('Claude API error:', error);
    throw error;
  }
}

// ===== WEBFLOW PROXY ENDPOINTS =====

// GET blogs from Webflow
app.get('/api/webflow', async (req, res) => {
  try {
    const { collectionId, limit = 100, offset = 0 } = req.query;
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      return res.status(401).json({ error: 'Authorization header missing' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    
    const response = await fetch(
      `https://api.webflow.com/v2/collections/${collectionId}/items?limit=${limit}&offset=${offset}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'accept': 'application/json'
        }
      }
    );
    
    if (!response.ok) {
      const errorData = await response.json();
      return res.status(response.status).json(errorData);
    }
    
    const data = await response.json();
    res.json(data);
    
  } catch (error) {
    console.error('Webflow GET error:', error);
    res.status(500).json({ error: error.message });
  }
});

// PATCH blog to Webflow
app.patch('/api/webflow', async (req, res) => {
  try {
    const { collectionId, itemId } = req.query;
    const { fieldData } = req.body;
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      return res.status(401).json({ error: 'Authorization header missing' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    
    console.log('Publishing to Webflow:', {
      collectionId,
      itemId,
      titleLength: fieldData.name?.length,
      contentLength: fieldData['post-body']?.length
    });
    
    const response = await fetch(
      `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'accept': 'application/json'
        },
        body: JSON.stringify({ fieldData })
      }
    );
    
    const data = await response.json();
    
    if (!response.ok) {
      console.error('Webflow PATCH error:', data);
      return res.status(response.status).json(data);
    }
    
    console.log('✅ Published successfully');
    res.json(data);
    
  } catch (error) {
    console.error('Webflow PATCH error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log('=================================');
  console.log('🚀 ContentOps Backend Started');
  console.log('=================================');
  console.log(`Port: ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log('=================================');
});

module.exports = app;
