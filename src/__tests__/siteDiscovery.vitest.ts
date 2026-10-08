import { describe, expect, it } from 'vitest';

import { advertisedMcpUrls, mcpAnswer } from '../checks/agentProtocols';
import { baseDomain, guessScope, scopeKey } from '../target/scope';

describe('site identity', () => {
  it('uses the registrable domain, not the last two labels', () => {
    expect(baseDomain('docs.github.com')).toBe('github.com');
    expect(baseDomain('docs.example.co.uk')).toBe('example.co.uk');
    expect(baseDomain('www.example.co.uk')).toBe('example.co.uk');
    expect(baseDomain('foo.readthedocs.io')).toBe('foo.readthedocs.io');
  });

});

describe('scan scope', () => {
  const scopeOf = (url: string) => {
    const guess = guessScope(new URL(url));
    return { key: scopeKey(guess.scopeRoot), locale: guess.locale, version: guess.version };
  };

  it('scores a bare domain as itself, not the docs it may have', () => {
    expect(scopeOf('https://github.com/').key).toBe('github.com');
    expect(scopeOf('https://www.example.co.uk/').key).toBe('example.co.uk');
  });

  it('keeps exactly the submitted section, neither widened to the site nor cut back to a docs root', () => {
    expect(scopeOf('https://example.com/docs/guides/install').key).toBe('example.com/docs/guides/install');
    expect(scopeOf('https://example.com/blog/').key).toBe('example.com/blog');
    expect(scopeOf('https://support.example.com/hc/en-us?utm_source=x#top').key).toBe(
      'support.example.com/hc/en-us',
    );
  });

  it('reads the locale and version from the submitted path', () => {
    expect(scopeOf('https://docs.example.com/en-us/v2/start')).toEqual({
      key: 'docs.example.com/en-us/v2/start',
      locale: 'en-us',
      version: 'v2',
    });
  });
});

describe('MCP discovery', () => {
  it('picks MCP endpoints out of llms.txt, not pages about MCP', () => {
    const llmsTxt = [
      '- [MCP server](https://mcp.example.com)',
      '- [Guide](https://docs.example.com/guides/mcp.md)',
      '- [Endpoint](https://docs.example.com/_mcp)',
    ].join('\n');
    expect(advertisedMcpUrls(llmsTxt)).toEqual(['https://mcp.example.com', 'https://docs.example.com/_mcp']);
  });

  const json = new Headers({ 'content-type': 'application/json' });

  it('recognises an open server, a server that wants sign-in, and neither', () => {
    const docs = new URL('https://docs.example.com/mcp');
    const mcpHost = new URL('https://mcp.example.com/');
    expect(mcpAnswer(docs, 405, json, '{"jsonrpc":"2.0","error":{"code":-32000}}')).toBe('open');
    expect(mcpAnswer(docs, 200, new Headers({ 'content-type': 'text/event-stream' }), '')).toBe('open');
    expect(mcpAnswer(mcpHost, 401, json, '{"error":"missing_api_key"}')).toBe('sign-in');
    expect(
      mcpAnswer(docs, 401, new Headers({ 'www-authenticate': 'Bearer resource_metadata="x"' }), ''),
    ).toBe('sign-in');
    expect(mcpAnswer(docs, 401, json, '{"error":"unauthorized"}')).toBeNull();
    expect(mcpAnswer(docs, 200, new Headers({ 'content-type': 'text/html' }), '<html>')).toBeNull();
  });
});
