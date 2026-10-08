# Agent Readiness Score

Scores how well AI agents can find, read and answer questions from a documentation site, help center or knowledge base, from 0 to 100 with a letter grade. It is the engine behind [documentation.ai/agent-score](https://documentation.ai/agent-score), and gives the same results when you run it yourself.

```bash
npx @documentation.ai/agent-score check https://docs.example.com
```

Needs Node.js 22 or later. The scan runs from your machine and nothing is uploaded.

## What it measures

One points table on the same scale as the open [AFDocs](https://afdocs.dev) standard: every check is worth 10, 7, 4 or 2 points by importance, a site earns a share of them, and the score is points earned over points possible. A check that cannot run on a site (no API spec, a timeout) is left out, never counted as zero.

| Part | Points | What it checks |
| --- | --- | --- |
| **Access** | 138 | The 23 AFDocs checks with AFDocs' own points (llms.txt, Markdown versions of pages, page size, content structure, URL stability, sign-in walls), plus whether search crawlers and the AI assistants that honour robots.txt may read the docs, and whether the sitemap lists the pages found on their own. |
| **Freshness** | up to 21 | Links and section anchors on the pages work, pages say when they were last changed, sitemap entries still exist, and, when the site publishes an OpenAPI spec, the endpoints the docs mention exist in it and deprecated ones are marked. |
| **Answerability** | 28 | An AI agent answers 5 to 8 real questions written from the sampled pages, fetching pages without JavaScript. Each answer is checked for reaching the right page, agreeing with the sentence it came from, and being backed by the passages it cites. Needs `--ai` and your own API key. |

MCP server, llms-full.txt and agent skills are reported but not scored. Grades: A+ is 97 and above, A 90 and above, B 80, C 70, D 60, and F below 60. AFDocs' caps apply: no llms.txt holds a site at 59. Without Answerability the score is out of the other points and the report says so. Every report records its `methodology.version`; scores from different versions are not comparable.

## Command line

```
agent-score check <url> [options]

  --json                        Print the full report as JSON
  --profile <profile>           Score as developer-docs or help-center instead of detecting it
  --ai <provider>               Also test answering: anthropic, openai, google or gateway
  --ai-models <role=model,...>  Override the model for questions, solver or judge
  --version                     Print the version
  --help                        Print this help
```

It scores exactly the address you give and the pages under it, such as `https://docs.example.com`, `https://example.com/docs` or `https://example.com/help`. A bare domain such as `example.com` is scored as itself; give the docs address to score the docs. When a bare domain has docs at `docs.example.com` or `example.com/docs`, the JSON report names them in `target.docsElsewhere`. If the address redirects, the scan follows the redirect, as an agent would.

### Answerability with your own model

`--ai` reads the key from the provider's usual environment variable:

| `--ai` | Key | Default models (questions, solver, judge) |
| --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` | claude-haiku-4-5-20251001, claude-haiku-4-5-20251001, claude-sonnet-5 |
| `openai` | `OPENAI_API_KEY` | gpt-5.4-mini, gpt-5.4-mini, gpt-5.4 |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` | gemini-2.5-flash, gemini-2.5-flash, gemini-2.5-pro |
| `gateway` | `AI_GATEWAY_API_KEY` | anthropic/claude-haiku-4.5, anthropic/claude-haiku-4.5, anthropic/claude-sonnet-5 |

```bash
ANTHROPIC_API_KEY=sk-... npx @documentation.ai/agent-score check https://docs.example.com --ai anthropic
```

The run prints its estimated cost. A test is 5 to 8 questions; on a 10-page sample of our own docs it cost about $0.24 with the Anthropic defaults.

## Use it from code

```ts
import { createAnswerabilityModels, scanSite } from '@documentation.ai/agent-score';

const { report } = await scanSite('https://docs.example.com');
console.log(report.overall.score, report.overall.grade, report.topFixes);

// With Answerability
const models = await createAnswerabilityModels({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
});
const { report: full, answerabilityCostUsd } = await scanSite('https://docs.example.com', { models });
```

`scanSite` runs every stage in one call; pass `onProgress` to get a short message at each step, as the CLI shows them. To run the stages as separate jobs, as the hosted scanner does, call `resolveTarget`, `runTechnicalAssessment`, `runAnswerability` and `finalizeReport` yourself. The report's shape is exported as the `AgentScoreReport` type.

## How the scanner behaves on your site

- It identifies itself as `Mozilla/5.0 (compatible; DocumentationAI-AgentScore/1.0; +https://documentation.ai/agent-score)`.
- It follows robots.txt (RFC 9309), including `Crawl-delay`.
- It waits 200 ms between requests to a site, makes at most 3 at a time, and honours `Retry-After`.
- A scan stops after 600 requests or 150 seconds, and tests a sample of 15 pages.
- It refuses private and internal addresses, so it cannot be pointed at a local network. That also means it cannot scan `localhost`.

To opt out, add this to robots.txt:

```
User-agent: DocumentationAI-AgentScore
Disallow: /
```

## Contributing

Issues and pull requests are welcome. [DEVELOPMENT.md](DEVELOPMENT.md) covers running it from source, where the code comes from and how releases are made.

## Credits

The Access checks and their scoring come from [AFDocs](https://github.com/agent-ecosystem/afdocs) (MIT), pinned to an exact version so scores stay reproducible.

## License

MIT
