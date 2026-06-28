// Фаза 2 (P2.4 / P2.5): Реальный веб-поиск вместо DuckDuckGo Instant Answer.
//
// Проблема: api.duckduckgo.com (Instant Answer API) для технических запросов
// почти всегда пуст → база знаний наполнялась пустотой.
//
// Решение, два режима (config.knowledge.searchMode):
//  - "free"  (по умолчанию): DuckDuckGo HTML (html.duckduckgo.com/html) —
//            реальная выдача ссылок, парсинг результатов из HTML. Бесплатно.
//  - "full"  : Firecrawl (подключён в Gumloop) — поиск + скрейп страницы в
//            markdown → конспект. Требует FIRECRAWL_API_KEY (SecretStorage).
//
// Возвращает унифицированный список результатов. Никаких ключей в коде —
// Firecrawl-ключ приходит параметром (из SecretStorage расширения).

export interface WebSearchResult {
  url: string;
  title?: string;
  summary: string;
}

export interface WebSearchOptions {
  mode?: "free" | "full";
  firecrawlApiKey?: string;
  // Сколько результатов вернуть (по умолчанию 5).
  limit?: number;
  signal?: AbortSignal;
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export async function webSearch(
  query: string,
  options: WebSearchOptions = {}
): Promise<WebSearchResult[]> {
  const limit = options.limit ?? 5;
  if (options.mode === "full" && options.firecrawlApiKey) {
    try {
      return await firecrawlSearch(query, options.firecrawlApiKey, limit, options.signal);
    } catch {
      // Падение Firecrawl не должно ронять поиск — мягкий фоллбэк на free.
      return duckDuckGoHtmlSearch(query, limit, options.signal);
    }
  }
  return duckDuckGoHtmlSearch(query, limit, options.signal);
}

// --- Бесплатный режим: DuckDuckGo HTML ---
// html.duckduckgo.com/html отдаёт реальную органическую выдачу в HTML.
// Парсим ссылки результатов и сниппеты простыми регэкспами (без тяжёлого
// DOM-парсера). DDG оборачивает целевой URL в редирект-ссылку uddg=...
async function duckDuckGoHtmlSearch(
  query: string,
  limit: number,
  signal?: AbortSignal
): Promise<WebSearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": BROWSER_UA,
      "Accept": "text/html",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: `q=${encodeURIComponent(query)}`,
    signal
  });
  if (!response.ok) {
    throw new Error(`DuckDuckGo HTML search failed: ${response.status}`);
  }
  const html = await response.text();
  return parseDuckDuckGoHtml(html, limit);
}

// Экспортируется отдельно для юнит-теста парсинга на фикстуре HTML.
export function parseDuckDuckGoHtml(html: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  // Блоки результатов: <a class="result__a" href="...">title</a> ... snippet.
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) {
    snippets.push(stripTags(sm[1]));
  }
  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(html)) && results.length < limit) {
    const href = decodeDdgRedirect(lm[1]);
    const title = stripTags(lm[2]);
    if (href && title) {
      results.push({ url: href, title, summary: snippets[i] ?? title });
    }
    i += 1;
  }
  return results;
}

function decodeDdgRedirect(href: string): string {
  // DDG: //duckduckgo.com/l/?uddg=<encoded>&...
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return href;
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Полный режим: Firecrawl ---
// /v1/search возвращает органические результаты; при scrapeOptions можно
// получить markdown-конспект страницы. Документация Firecrawl v1.
async function firecrawlSearch(
  query: string,
  apiKey: string,
  limit: number,
  signal?: AbortSignal
): Promise<WebSearchResult[]> {
  const response = await fetch("https://api.firecrawl.dev/v1/search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query,
      limit,
      scrapeOptions: { formats: ["markdown"] }
    }),
    signal
  });
  if (!response.ok) {
    throw new Error(`Firecrawl search failed: ${response.status}`);
  }
  const data = (await response.json()) as {
    data?: Array<{ url?: string; title?: string; description?: string; markdown?: string }>;
  };
  return (data.data ?? []).slice(0, limit).map((item) => ({
    url: item.url ?? "",
    title: item.title,
    summary: truncate(item.description || item.markdown || item.title || "", 500)
  })).filter((r) => r.url);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}