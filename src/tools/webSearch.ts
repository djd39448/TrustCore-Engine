/**
 * Web search tool — DuckDuckGo HTML scrape, no API key required.
 *
 * Fetches the DuckDuckGo lite HTML results page and extracts titles,
 * URLs, and snippets. Returns up to maxResults results.
 *
 * Used by the research agent when knowledge base has no relevant entries.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const DDG_LITE_URL = 'https://lite.duckduckgo.com/lite/';
const USER_AGENT = 'Mozilla/5.0 (compatible; TrustCoreResearch/1.0)';

/**
 * Search DuckDuckGo and return up to maxResults results.
 * Returns empty array on network error or parse failure.
 */
export async function webSearch(
  query: string,
  maxResults = 5
): Promise<SearchResult[]> {
  try {
    const body = new URLSearchParams({ q: query, s: '0', o: 'json', api: 'd.js' });
    const res = await fetch(DDG_LITE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
        'Accept': 'text/html',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.warn(`[webSearch] DuckDuckGo returned ${res.status}`);
      return [];
    }

    const html = await res.text();
    return parseResults(html, maxResults);
  } catch (err) {
    console.warn(`[webSearch] Failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Parse DuckDuckGo lite HTML to extract results.
 *
 * DDG lite structure (actual):
 *   <a rel="nofollow" href="URL" class='result-link'>TITLE</a>
 *   followed later by <td class='result-snippet'>SNIPPET</td>
 *
 * Note: DDG lite uses single-quoted attributes.
 */
function parseResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Extract href from any <a> tag that has class='result-link' or class="result-link"
  // Attribute order varies; class may use single or double quotes
  const linkPattern = /<a\s[^>]*class=['"]result-link['"][^>]*>/gi;
  const hrefPattern = /href=['"]([^'"]+)['"]/i;
  const snippetPattern = /<td\s[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;

  // Extract all result-link anchor tags, then pull href and text content
  const links: Array<{ url: string; title: string }> = [];
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = linkPattern.exec(html)) !== null && links.length < maxResults) {
    const tag = tagMatch[0];
    const hrefMatch = hrefPattern.exec(tag);
    if (!hrefMatch) continue;
    const url = hrefMatch[1] ?? '';
    // Grab text content between the opening tag and </a>
    const afterTag = html.slice((tagMatch.index ?? 0) + tag.length);
    const closeIdx = afterTag.indexOf('</a>');
    const title = decodeHtml(stripTags(closeIdx >= 0 ? afterTag.slice(0, closeIdx) : '')).trim();
    if (url && title) links.push({ url, title });
  }

  const snippets: string[] = [];
  let snippetMatch: RegExpExecArray | null;
  while ((snippetMatch = snippetPattern.exec(html)) !== null && snippets.length < maxResults) {
    snippets.push(decodeHtml(stripTags(snippetMatch[1] ?? '')).trim());
  }

  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    results.push({
      title: links[i]!.title,
      url: links[i]!.url,
      snippet: snippets[i] ?? '',
    });
  }

  return results;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
