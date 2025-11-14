// generate-rss.js
const fs = require('fs');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { parseStringPromise } = require('xml2js');

const apiURLs = [
  "https://bonikbarta.com/api/post-filters/41?root_path=00000000010000000001",
  "https://bonikbarta.com/api/post-filters/52?root_path=00000000010000000001"
];
const baseURL = "https://bonikbarta.com";
const feedFile = "feed.xml";
const maxItems = 500;

// ---------------- Parse Existing Feed ----------------
async function parseExistingFeed() {
  if (!fs.existsSync(feedFile)) {
    console.log("📄 No existing feed.xml found, will create new one");
    return [];
  }

  try {
    const xmlContent = fs.readFileSync(feedFile, 'utf8');
    const result = await parseStringPromise(xmlContent);
    
    if (!result.rss || !result.rss.channel || !result.rss.channel[0].item) {
      console.log("⚠️ Invalid feed structure, starting fresh");
      return [];
    }

    const items = result.rss.channel[0].item.map(item => ({
      title: item.title[0],
      link: item.link[0],
      description: item.description[0].replace(/<!\[CDATA\[|\]\]>/g, ''),
      pubDate: item.pubDate[0],
      guid: item.guid[0]._ || item.guid[0]
    }));

    console.log(`📖 Loaded ${items.length} existing items from feed`);
    return items;
  } catch (err) {
    console.error("❌ Error parsing existing feed:", err.message);
    console.log("🔄 Starting with fresh feed");
    return [];
  }
}

// ---------------- RSS Helpers ----------------
function generateGUID(item) {
  const str = (item.title||'')+(item.excerpt||item.summary||'')+(item.first_published_at||'');
  return crypto.createHash('md5').update(str).digest('hex');
}

function itemToRSSItem(item) {
  const nowUTC = new Date().toUTCString();
  const fullLink = (item.url_path || "/").replace(/^\/home/,"");
  const articleUrl = baseURL + fullLink;
  const pubDate = item.first_published_at ? new Date(item.first_published_at).toUTCString() : nowUTC;
  const title = (item.title || "No title").replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const description = item.excerpt || item.summary || "No description available";
  const guid = generateGUID(item);

  return { title, link: articleUrl, description, pubDate, guid };
}

function generateRSS(items) {
  const nowUTC = new Date().toUTCString();
  let rss = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n' +
    '  <channel>\n' +
    '    <title>Bonikbarta Combined Feed</title>\n' +
    '    <link>https://harmonious-froyo-665879.netlify.app/</link>\n' +
    '    <atom:link href="https://harmonious-froyo-665879.netlify.app/feed.xml" rel="self" type="application/rss+xml"/>\n' +
    '    <description>Latest articles from Bonikbarta</description>\n' +
    '    <language>bn</language>\n' +
    '    <lastBuildDate>' + nowUTC + '</lastBuildDate>\n' +
    '    <generator>GitHub Actions RSS Generator</generator>\n';

  items.forEach(item => {
    rss += '    <item>\n' +
           '      <title>' + item.title + '</title>\n' +
           '      <link>' + item.link + '</link>\n' +
           '      <description><![CDATA[' + item.description + ']]></description>\n' +
           '      <pubDate>' + item.pubDate + '</pubDate>\n' +
           '      <guid isPermaLink="false">' + item.guid + '</guid>\n' +
           '    </item>\n';
  });

  rss += '  </channel>\n</rss>';
  return rss;
}

// ---------------- Fetch with Playwright ----------------
async function fetchJSONWithPlaywright(page, url) {
  try {
    console.log("→ Fetching:", url);
    const response = await page.evaluate(async (u) => {
      const res = await fetch(u, { 
        headers: { 
          Accept: 'application/json', 
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://bonikbarta.com/',
          'Accept-Language': 'bn,en;q=0.8'
        } 
      });
      return await res.text();
    }, url);

    if (!response.trim().startsWith('{')) {
      console.error("⚠️ Non-JSON response from", url);
      return null;
    }

    const data = JSON.parse(response);
    const items = (data.posts && Array.isArray(data.posts))
      ? data.posts
      : ((data.content && data.content.items) || []);
    
    if (!items || items.length === 0) {
      console.warn("⚠️ No items in response:", url);
      return null;
    }

    console.log(`✅ ${items.length} posts found`);
    return items;
  } catch (err) {
    console.error("❌ Failed to fetch:", url, err);
    return null;
  }
}

// ---------------- Main ----------------
(async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127 Safari/537.36"
  });
  const page = await context.newPage();

  // Load existing feed items
  const existingItems = await parseExistingFeed();
  const existingGuids = new Set(existingItems.map(item => item.guid));
  const existingLinks = new Set(existingItems.map(item => item.link));

  const newItems = [];

  for (const url of apiURLs) {
    const items = await fetchJSONWithPlaywright(page, url);
    if (!items) {
      console.warn(`⚠️ Skipping ${url} due to error`);
      continue;
    }

    for (const post of items) {
      const rssItem = itemToRSSItem(post);
      
      // Only add if not already in feed (check both GUID and link)
      if (!existingGuids.has(rssItem.guid) && !existingLinks.has(rssItem.link)) {
        newItems.push(rssItem);
        existingGuids.add(rssItem.guid);
        existingLinks.add(rssItem.link);
      }
    }

    // Rate limiting: wait 1 second between requests
    await page.waitForTimeout(1000);
  }

  await browser.close();

  console.log(`🆕 Found ${newItems.length} new items`);

  // Combine existing and new items
  const allItems = [...newItems, ...existingItems];

  // Sort by date (newest first)
  allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  // Keep only the latest 500 items
  const finalItems = allItems.slice(0, maxItems);

  const rssXML = generateRSS(finalItems);
  fs.writeFileSync(feedFile, rssXML, { encoding: 'utf8' });

  console.log(`✅ RSS feed updated with ${finalItems.length} total items (${newItems.length} new, ${existingItems.length} existing, keeping latest ${maxItems})`);
})();