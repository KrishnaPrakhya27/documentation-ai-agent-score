import type { ReportCheck } from '../report.types';
import {
  fetchText,
  uniqueUrls,
  type BaseCheckInput,
  type CheckInput,
} from './checkInput';

/**
 * Newer agent interfaces a docs site can offer: llms-full.txt, an MCP server
 * and published agent skills. Informational in this methodology: presence is
 * reported with evidence but carries no points.
 */

const JSON_OR_STREAM = 'application/json, text/event-stream';

export async function checkLlmsFullTxt(input: BaseCheckInput): Promise<ReportCheck> {
  const candidates = uniqueUrls([
    `${input.target.scopeRoot}/llms-full.txt`,
    `${input.scopeRoot.origin}/llms-full.txt`,
  ]);
  for (const url of candidates) {
    const result = await fetchText(input, url);
    if (!('response' in result) || result.response.status !== 200) continue;
    const type = result.response.headers.get('content-type') ?? '';
    if (type.includes('html') || result.body.trim().length < 200) continue;
    const size = result.response.truncated
      ? 'over 2 MB'
      : `${result.body.length.toLocaleString('en-US')} characters`;
    return protocolCheck('llms-full-txt', 'pass', `llms-full.txt found at ${result.response.url} (${size}).`, [
      result.response.url,
    ]);
  }
  return protocolCheck(
    'llms-full-txt',
    'fail',
    `No llms-full.txt found at ${candidates.join(' or ')}.`,
    [],
    'Publish /llms-full.txt with the full text of your docs in Markdown, so an agent can load everything in one request instead of crawling page by page.',
  );
}

export async function checkMcpServer(input: CheckInput): Promise<ReportCheck> {
  const advertised = (input.llmsTxt?.content.match(/https?:\/\/[^\s)<>"']+\/_?mcp\b/g) ?? []).slice(0, 2);
  const candidates = uniqueUrls([
    ...advertised,
    `${input.target.scopeRoot}/mcp`,
    `${input.target.scopeRoot}/_mcp`,
    `${input.scopeRoot.origin}/mcp`,
  ]);

  for (const url of candidates) {
    const result = await fetchText(input, url, { accept: JSON_OR_STREAM });
    if ('response' in result && looksLikeMcp(result.response.status, result.response.headers, result.body)) {
      return protocolCheck('mcp-server', 'pass', `An MCP server answers at ${result.response.url}.`, [
        result.response.url,
      ]);
    }
  }
  return protocolCheck(
    'mcp-server',
    'fail',
    'No MCP server was found for these docs.',
    [],
    'Offer a read-only MCP server with a search tool over your docs, and link it from llms.txt, so agents in Cursor, Claude and ChatGPT can query your docs directly.',
  );
}

export async function checkAgentSkills(input: BaseCheckInput): Promise<ReportCheck> {
  const roots = uniqueUrls([input.target.scopeRoot, input.scopeRoot.origin]);
  const candidates = roots.flatMap((root) => [
    `${root}/.well-known/agent-skills/index.json`,
    `${root}/.well-known/skills/index.json`,
  ]);

  for (const url of candidates) {
    const result = await fetchText(input, url, { accept: 'application/json' });
    if (!('response' in result) || result.response.status !== 200) continue;
    const skills = skillCount(result.body);
    if (skills > 0) {
      return protocolCheck(
        'agent-skills',
        'pass',
        `${skills} agent skill${skills === 1 ? '' : 's'} published at ${result.response.url}.`,
        [result.response.url],
      );
    }
  }
  return protocolCheck(
    'agent-skills',
    'fail',
    'No agent skills index was found at /.well-known/agent-skills/index.json.',
    [],
    'Publish an Agent Skills index at /.well-known/agent-skills/index.json with a SKILL.md for your main tasks, so agents can load task instructions without reading every page.',
  );
}

function looksLikeMcp(status: number, headers: Headers, body: string): boolean {
  const type = headers.get('content-type') ?? '';
  if (type.includes('text/event-stream')) return status === 200;
  if (!type.includes('json')) return false;
  if (status === 200) return /"(jsonrpc|capabilities|serverInfo|protocolVersion)"/.test(body);
  return [400, 405, 406].includes(status) && body.includes('"jsonrpc"');
}

function skillCount(body: string): number {
  try {
    const parsed = JSON.parse(body) as { skills?: unknown[] } | unknown[];
    const list = Array.isArray(parsed) ? parsed : parsed?.skills;
    return Array.isArray(list) ? list.length : 0;
  } catch {
    return 0;
  }
}

const TITLES: Record<string, string> = {
  'llms-full-txt': 'llms-full.txt is available',
  'mcp-server': 'MCP server is discoverable',
  'agent-skills': 'Agent skills are published',
};

function protocolCheck(
  id: string,
  status: 'pass' | 'fail',
  message: string,
  evidence: string[],
  fix?: string,
): ReportCheck {
  return {
    id,
    pillar: 'access',
    group: 'agent-protocols',
    title: TITLES[id],
    status: status === 'pass' ? 'pass' : 'info',
    scored: false,
    source: 'agent-score',
    message,
    ...(fix && { fix }),
    ...(evidence.length && { evidence }),
  };
}
