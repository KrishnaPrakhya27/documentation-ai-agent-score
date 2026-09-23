import { parse, type HTMLElement } from 'node-html-parser';

import type { PlatformId, PlatformResult } from '../report.types';

/**
 * Names the platform a site runs on from weighted page signals. It explains
 * findings and tailors fixes; it never changes a score. A single weak signal
 * (one CDN host) is not enough to name a platform.
 */

type Signal =
  | { kind: 'generator'; pattern: RegExp; weight: number }
  | { kind: 'meta'; name: string; weight: number }
  | { kind: 'html'; pattern: string; weight: number }
  | { kind: 'selector'; pattern: string; weight: number }
  | { kind: 'url'; pattern: RegExp; weight: number };

interface PlatformProfile {
  id: Exclude<PlatformId, 'unknown'>;
  name: string;
  helpCenter: boolean;
  signals: Signal[];
}

export const PLATFORM_PROFILES: PlatformProfile[] = [
  {
    id: 'mintlify',
    name: 'Mintlify',
    helpCenter: false,
    signals: [
      { kind: 'generator', pattern: /^mintlify/i, weight: 5 },
      { kind: 'html', pattern: 'mintcdn.com', weight: 3 },
      { kind: 'html', pattern: '/_mintlify/', weight: 3 },
      { kind: 'selector', pattern: '#content-area', weight: 1 },
      { kind: 'selector', pattern: '#sidebar-content', weight: 1 },
    ],
  },
  {
    id: 'gitbook',
    name: 'GitBook',
    helpCenter: false,
    signals: [
      { kind: 'generator', pattern: /^gitbook/i, weight: 5 },
      { kind: 'html', pattern: 'static-2v.gitbook.com', weight: 3 },
      { kind: 'html', pattern: 'fonts.gitbook.com', weight: 2 },
      { kind: 'selector', pattern: 'main.page-has-toc', weight: 1 },
    ],
  },
  {
    id: 'readme',
    name: 'ReadMe',
    helpCenter: false,
    signals: [
      { kind: 'meta', name: 'readme-deploy', weight: 5 },
      { kind: 'html', pattern: 'cdn.readme.io', weight: 3 },
      { kind: 'html', pattern: 'files.readme.io', weight: 1 },
      { kind: 'selector', pattern: '.rm-Sidebar', weight: 2 },
      { kind: 'selector', pattern: '.rm-Markdown', weight: 2 },
    ],
  },
  {
    id: 'docusaurus',
    name: 'Docusaurus',
    helpCenter: false,
    signals: [
      { kind: 'generator', pattern: /^docusaurus/i, weight: 5 },
      { kind: 'selector', pattern: '#__docusaurus', weight: 3 },
      { kind: 'selector', pattern: '.theme-doc-markdown', weight: 3 },
    ],
  },
  {
    id: 'fern',
    name: 'Fern',
    helpCenter: false,
    signals: [
      { kind: 'generator', pattern: /^fern/i, weight: 5 },
      { kind: 'html', pattern: 'buildwithfern.com', weight: 3 },
      { kind: 'selector', pattern: '.fern-sidebar', weight: 3 },
      { kind: 'selector', pattern: '.fern-layout-main', weight: 2 },
    ],
  },
  {
    id: 'zendesk',
    name: 'Zendesk',
    helpCenter: true,
    signals: [
      { kind: 'html', pattern: 'zdassets.com', weight: 4 },
      { kind: 'url', pattern: /\/hc\/[a-z-]+\/(articles|sections|categories)\//i, weight: 3 },
      { kind: 'html', pattern: 'zendesk.com', weight: 1 },
    ],
  },
  {
    id: 'intercom',
    name: 'Intercom',
    helpCenter: true,
    signals: [
      { kind: 'html', pattern: 'intercomassets.com', weight: 4 },
      { kind: 'html', pattern: 'intercomcdn.com', weight: 2 },
      { kind: 'selector', pattern: '.intercom-force-break', weight: 3 },
    ],
  },
  {
    id: 'freshdesk',
    name: 'Freshdesk',
    helpCenter: true,
    signals: [
      { kind: 'url', pattern: /\/support\/solutions\/articles\//i, weight: 4 },
      { kind: 'html', pattern: 'freshdesk.com', weight: 3 },
      { kind: 'html', pattern: 'freshworks.com', weight: 1 },
    ],
  },
  {
    id: 'helpscout',
    name: 'Help Scout',
    helpCenter: true,
    signals: [
      { kind: 'html', pattern: 'helpscoutdocs.com', weight: 4 },
      { kind: 'selector', pattern: '#fullArticle', weight: 3 },
      { kind: 'html', pattern: 'beacon-v2.helpscout.net', weight: 1 },
    ],
  },
  {
    id: 'document360',
    name: 'Document360',
    helpCenter: true,
    signals: [
      { kind: 'html', pattern: 'cdn.document360.io', weight: 4 },
      { kind: 'selector', pattern: '.editor360-published-content', weight: 3 },
      { kind: 'selector', pattern: '#articleContent', weight: 1 },
    ],
  },
  {
    id: 'confluence',
    name: 'Confluence',
    helpCenter: true,
    signals: [
      { kind: 'meta', name: 'ajs-page-id', weight: 5 },
      { kind: 'url', pattern: /\/wiki\/spaces\//i, weight: 3 },
      { kind: 'html', pattern: 'atlassian.net/wiki', weight: 2 },
      { kind: 'selector', pattern: '.wiki-content', weight: 2 },
    ],
  },
  {
    id: 'documentation-ai',
    name: 'Documentation.AI',
    helpCenter: false,
    signals: [
      { kind: 'html', pattern: '/_dai/', weight: 4 },
      { kind: 'html', pattern: 'class="dai-', weight: 3 },
      { kind: 'html', pattern: 'blob-cdn.documentation.ai', weight: 2 },
    ],
  },
  {
    id: 'nextra',
    name: 'Nextra',
    helpCenter: false,
    signals: [
      { kind: 'selector', pattern: '.nextra-content', weight: 4 },
      { kind: 'html', pattern: 'nextra-', weight: 2 },
    ],
  },
  {
    id: 'readthedocs',
    name: 'Read the Docs',
    helpCenter: false,
    signals: [
      { kind: 'selector', pattern: '.rst-content', weight: 3 },
      { kind: 'selector', pattern: '.wy-nav-side', weight: 3 },
      { kind: 'html', pattern: 'readthedocs', weight: 2 },
    ],
  },
  {
    id: 'mkdocs',
    name: 'MkDocs',
    helpCenter: false,
    signals: [
      { kind: 'generator', pattern: /^mkdocs/i, weight: 5 },
      { kind: 'selector', pattern: '.md-content', weight: 2 },
    ],
  },
  {
    id: 'vitepress',
    name: 'VitePress',
    helpCenter: false,
    signals: [
      { kind: 'generator', pattern: /^vitepress/i, weight: 5 },
      { kind: 'selector', pattern: '.VPDoc', weight: 3 },
    ],
  },
];

/** A weighted score this high, from at least two signals or one decisive one. */
const MIN_CONFIDENCE = 0.34;
const DECISIVE_WEIGHT = 4;

export interface PlatformEvidence {
  pages: Array<{ url: string; html: string }>;
}

export function detectPlatform(evidence: PlatformEvidence): PlatformResult {
  const pages = evidence.pages.filter((page) => page.html);
  if (pages.length === 0) return unknownPlatform();

  const parsed = pages.map((page) => ({
    url: page.url,
    html: page.html,
    root: parse(page.html),
  }));

  let best: { profile: PlatformProfile; confidence: number } | null = null;
  for (const profile of PLATFORM_PROFILES) {
    const total = profile.signals.reduce((sum, signal) => sum + signal.weight, 0);
    const matched = profile.signals.filter((signal) =>
      parsed.some((page) => signalMatches(signal, page.url, page.html, page.root)),
    );
    const weight = matched.reduce((sum, signal) => sum + signal.weight, 0);
    const decisive = matched.some((signal) => signal.weight >= DECISIVE_WEIGHT);
    if (matched.length < 2 && !decisive) continue;

    const confidence = weight / total;
    if (confidence >= MIN_CONFIDENCE && (!best || confidence > best.confidence)) {
      best = { profile, confidence };
    }
  }

  if (!best) return unknownPlatform();
  return {
    id: best.profile.id,
    name: best.profile.name,
    confidence: Math.round(best.confidence * 100) / 100,
  };
}

export function isHelpCenterPlatform(id: PlatformId): boolean {
  return PLATFORM_PROFILES.some((profile) => profile.id === id && profile.helpCenter);
}

export function platformName(id: PlatformId): string {
  return PLATFORM_PROFILES.find((profile) => profile.id === id)?.name ?? 'Unknown';
}

function signalMatches(
  signal: Signal,
  url: string,
  html: string,
  root: HTMLElement,
): boolean {
  switch (signal.kind) {
    case 'generator': {
      const content = root
        .querySelector('meta[name="generator"]')
        ?.getAttribute('content');
      return !!content && signal.pattern.test(content.trim());
    }
    case 'meta':
      return !!root.querySelector(`meta[name="${signal.name}"]`);
    case 'html':
      return html.includes(signal.pattern);
    case 'selector':
      return !!root.querySelector(signal.pattern);
    case 'url':
      return signal.pattern.test(url);
  }
}

function unknownPlatform(): PlatformResult {
  return { id: 'unknown', name: 'Unknown', confidence: 0 };
}
