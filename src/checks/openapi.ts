import { parse as parseYaml } from 'yaml';

import { fetchText, type CheckInput } from './checkInput';
import { contentLinks, type ParsedPage } from './pageContent';

/**
 * The site's published OpenAPI description, read once per scan and shared
 * by the checks that compare the docs with it. Only the operations and their
 * deprecation flags are kept; nothing here claims the spec matches the
 * running product.
 */

export interface OpenApiSpec {
  url: string;
  /** `METHOD /normalized/path` for every operation. */
  operations: Set<string>;
  /** The operations the spec itself marks `deprecated: true`. */
  deprecated: Set<string>;
  basePaths: string[];
}

/** An endpoint a page mentions, with the words around it. */
export interface EndpointMention {
  operation: string;
  page: string;
  /** The text either side of the mention, for reading a notice next to it. */
  context: string;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const MENTION = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9_\-./{}:<>]+)/g;
const CONTEXT_CHARS = 240;

export function endpointMentions(pages: ParsedPage[]): EndpointMention[] {
  const mentions: EndpointMention[] = [];
  for (const page of pages) {
    for (const match of page.text.matchAll(MENTION)) {
      const start = match.index ?? 0;
      mentions.push({
        operation: `${match[1]} ${normalizeApiPath(match[2])}`,
        page: page.url,
        context: page.text.slice(Math.max(0, start - CONTEXT_CHARS), start + match[0].length + CONTEXT_CHARS),
      });
    }
  }
  return mentions;
}

export function normalizeApiPath(path: string): string {
  return (
    path
      .replace(/[.,;:)]+$/, '')
      .replace(/\{[^}]*\}|<[^>]*>|:[A-Za-z_]\w*/g, '{}')
      .replace(/\/+$/, '') || '/'
  );
}

/** The spec's own spelling of a mentioned operation, or null when the spec lacks it. */
export function specOperation(spec: OpenApiSpec, mention: string): string | null {
  if (spec.operations.has(mention)) return mention;
  const [method, path] = mention.split(' ');
  for (const base of spec.basePaths) {
    if (!base || !path.startsWith(`${base}/`)) continue;
    const candidate = `${method} ${path.slice(base.length)}`;
    if (spec.operations.has(candidate)) return candidate;
  }
  return null;
}

export async function loadOpenApi(input: Pick<CheckInput, 'http' | 'target' | 'scopeRoot' | 'llmsTxt' | 'pages'>): Promise<OpenApiSpec | null> {
  const linked = new Set<string>();
  const specLink = /https?:\/\/[^\s)"'<>]+(?:openapi|swagger)[^\s)"'<>/]*\.(?:json|ya?ml)\b/gi;
  for (const match of input.llmsTxt?.content.matchAll(specLink) ?? []) linked.add(match[0]);
  for (const page of input.pages) {
    for (const link of contentLinks(page)) {
      if (/(openapi|swagger)[^/]*\.(json|ya?ml)$/i.test(link)) linked.add(link);
    }
  }
  const candidates = [
    ...linked,
    `${input.target.scopeRoot}/openapi.json`,
    `${input.target.scopeRoot}/api-reference/openapi.json`,
    `${input.scopeRoot.origin}/openapi.json`,
  ].slice(0, 5);

  for (const url of [...new Set(candidates)]) {
    const result = await fetchText(input, url, {
      accept: 'application/json, application/yaml, text/yaml',
    });
    if (!('response' in result) || result.response.status !== 200 || result.response.truncated) {
      continue;
    }
    const spec = parseSpec(result.body);
    if (spec) return { url: result.response.url, ...spec };
  }
  return null;
}

type PathItem = Record<string, { deprecated?: unknown } | undefined>;

export function parseSpec(body: string): Omit<OpenApiSpec, 'url'> | null {
  let document: { paths?: Record<string, PathItem>; servers?: Array<{ url?: string }> };
  try {
    document = body.trimStart().startsWith('{') ? JSON.parse(body) : parseYaml(body);
  } catch {
    return null;
  }
  if (!document || typeof document !== 'object' || !document.paths) return null;

  const operations = new Set<string>();
  const deprecated = new Set<string>();
  for (const [path, item] of Object.entries(document.paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation || typeof operation !== 'object') continue;
      const key = `${method.toUpperCase()} ${normalizeApiPath(path)}`;
      operations.add(key);
      if (operation.deprecated === true) deprecated.add(key);
    }
  }
  const basePaths = (document.servers ?? [])
    .map((server) => {
      try {
        return new URL(server.url ?? '', 'https://placeholder.invalid').pathname.replace(/\/+$/, '');
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  return operations.size ? { operations, deprecated, basePaths } : null;
}
