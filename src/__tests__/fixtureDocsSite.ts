import type { FixtureRoute } from './fixtureServer';

/**
 * A small agent-friendly docs site: robots.txt, sitemap, llms.txt and six
 * pages served as HTML and as Markdown. Tests override single routes to
 * break one property at a time.
 */

const PAGES = [
  'getting-started',
  'install',
  'configuration',
  'authentication',
  'webhooks',
  'troubleshooting',
];

function pageHtml(slug: string, origin: string): string {
  const title = slug.replace(/-/g, ' ');
  return `<!doctype html><html lang="en"><head>
<title>${title} | Acme Docs</title>
<meta name="generator" content="Docusaurus v3.5.2">
<meta property="article:modified_time" content="2026-08-01T10:00:00Z">
<link rel="alternate" type="text/markdown" href="${origin}/docs/${slug}.md">
</head><body>
<nav><a href="/docs/getting-started">Getting started</a></nav>
<main><article class="theme-doc-markdown">
<h1>${title}</h1>
<p>This page explains ${title} for Acme. To create an API key, open Settings and choose API keys, then press Create key.</p>
<h2>Example</h2>
<pre><code>curl https://api.acme.test/v1/widgets</code></pre>
<p>Call <code>GET /v1/widgets</code> to list widgets. <a href="/docs/install">Install guide</a>.</p>
</article></main>
</body></html>`;
}

function pageMarkdown(slug: string): string {
  const title = slug.replace(/-/g, ' ');
  return `# ${title}\n\nThis page explains ${title} for Acme. To create an API key, open Settings and choose API keys, then press Create key.\n\n## Example\n\n\`\`\`\ncurl https://api.acme.test/v1/widgets\n\`\`\`\n\nCall \`GET /v1/widgets\` to list widgets. [Install guide](/docs/install).\n`;
}

export function docsSiteRoutes(origin: string): Record<string, FixtureRoute> {
  const routes: Record<string, FixtureRoute> = {
    '/robots.txt': {
      headers: { 'content-type': 'text/plain' },
      body: `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`,
    },
    '/sitemap.xml': {
      headers: { 'content-type': 'application/xml' },
      body: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${PAGES.map(
        (slug) =>
          `<url><loc>${origin}/docs/${slug}</loc><lastmod>2026-08-01</lastmod></url>`,
      ).join('')}</urlset>`,
    },
    '/llms.txt': {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: `# Acme Docs\n\n> Documentation for Acme.\n\n## Docs\n\n${PAGES.map(
        (slug) => `- [${slug}](${origin}/docs/${slug}.md): About ${slug}`,
      ).join('\n')}\n`,
    },
  };
  for (const slug of PAGES) {
    routes[`/docs/${slug}`] = {
      headers: { 'cache-control': 'public, max-age=300' },
      body: pageHtml(slug, origin),
    };
    routes[`/docs/${slug}.md`] = {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'cache-control': 'public, max-age=300',
      },
      body: pageMarkdown(slug),
    };
  }
  routes['/docs'] = { status: 301, headers: { location: '/docs/getting-started' } };
  return routes;
}
