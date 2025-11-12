// generate-rss.js
const fs = require('fs');
const crypto = require('crypto');
const fetch = global.fetch || require('node-fetch');
const AbortController = global.AbortController || require('abort-controller');

const apiURLs = [
  "https://bonikbarta.com/api/post-filters/41?root_path=00000000010000000001",
  "https://bonikbarta.com/api/post-filters/52?root_path=00000000010000000001"
];
const baseURL = "https://bonikbarta.com";

// ---------------- Fetch Helpers ----------------
async function fetchJsonSafe(url) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (RSS Generator)',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://bonikbarta.com/',
    'Accept-Language': 'bn,en;q=0.8'
  };
  if (process.env.BONIK_COOKIE) headers['Cookie'] = process.env.BONIK_COOKIE;

  const timeoutMs = 10000;
  const maxRetries = 3;
  let last = null;
  for (let i=1;i<=maxRetries;i++){
    const ac = new AbortController();
    const id = setTimeout(()=>ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, { method:'GET', headers, signal: ac.signal });
      clearTimeout(id);
      const text = await r.text().catch(()=> '');
      const ct = r.headers && (r.headers.get && r.headers.get('content-type')) || '';
      if (ct.includes('html') || text.trim().startsWith('<')) {
        const err = new Error(`HTML response status=${r.status}`);
        err.snippet = text.slice(0,400);
        throw err;
      }
      return JSON.parse(text);
    } catch (err) {
      clearTimeout(id);
      last = err;
      const transient = /timeout|AbortError|ECONNRESET|ENOTFOUND|status=5|HTML response/i.test(String(err.message));
      if (!transient || i===maxRetries) break;
      await new Promise(res => setTimeout(res, 200 * Math.pow(2, i)));
    }
  }
  throw last;
}

async function fetchAll() {
  let allItems = [];
  for (const url of apiURLs) {
    try {
      const data = await fetchJsonSafe(url);
      const items = (data.posts && Array.isArray(data.posts))
        ? data.posts
        : ((data.content && data.content.items) || []);
      allItems = allItems.concat(items || []);
    } catch (err) {
      console.error('Failed to load from', url, err && (err.message || err));
      if (err && err.snippet) console.error('snippet:', err.snippet.slice(0,300));
    }
  }
  allItems.sort((a,b)=> new Date(b.first_published_at) - new Date(a.first_published_at));
  return allItems;
}

// ---------------- RSS Helpers ----------------
function generateGUID(item) {
  const str = (item.title||'')+(item.excerpt||'')+(item.first_published_at||'');
  return crypto.createHash('md5').update(str).digest('hex');
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
    const fullLink = (item.url_path || "/").replace(/^\/home/,"");
    const articleUrl = baseURL + fullLink;
    const pubDate = item.first_published_at ? new Date(item.first_published_at).toUTCString() : nowUTC;
    const title = (item.title || "No title").replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const description = item.excerpt || item.summary || "No description available";
    const guid = generateGUID(item);

    rss += '    <item>\n' +
           '      <title>' + title + '</title>\n' +
           '      <link>' + articleUrl + '</link>\n' +
           '      <description><![CDATA[' + description + ']]></description>\n' +
           '      <pubDate>' + pubDate + '</pubDate>\n' +
           '      <guid isPermaLink="false">' + guid + '</guid>\n' +
           '    </item>\n';
  });

  rss += '  </channel>\n</rss>';
  return rss;
}

// ---------------- Main ----------------
(async function main() {
  try {
    const items = await fetchAll();
    if(items.length === 0) console.warn('No articles fetched');
    fs.writeFileSync('feed.xml', generateRSS(items.slice(0,500)), { encoding: 'utf8' });
    console.log('RSS feed generated with ' + items.length + ' articles');
  } catch (err) {
    console.error('Error generating RSS:', err);
  }
})();
