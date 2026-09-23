# Agent Readiness Score

Scores how well AI agents can find, read and answer questions from a documentation site, help center or knowledge base, from 0 to 100 with a letter grade. It is the engine behind [documentation.ai/agent-score](https://documentation.ai/agent-score), and gives the same results when you run it yourself.

```bash
npx @documentation-ai/agent-score check https://docs.example.com
```

Needs Node.js 22 or later. The scan runs from your machine and nothing is uploaded.

## What it measures

| Part | Weight | What it checks |
| --- | --- | --- |
| **Access** | 40% | Can an agent find and read the content? The 23 checks of the [AFDocs](https://afdocs.dev) standard: llms.txt, Markdown versions of pages, page size, content structure, URL stability and sign-in walls. It also reports, without scoring, whether the site has llms-full.txt, an MCP server, agent skills, AI crawler access in robots.txt and a sitemap. |
| **Answerability** | 40% | Can an agent answer real questions from it? Questions are written from up to 10 sampled pages. An AI agent then answers them, fetching pages without running JavaScript, and each answer is judged against the page it came from. Needs `--ai` and your own API key. |
| **Freshness** | 20% | Is the content current and intact? Working links count for 50 points, Markdown that matches the HTML for 30, and page dates, changelog recency and OpenAPI coverage for 20. |

Grades: A+ is 97 and above, A 90 and above, B 80, C 70, D 60, and F below 60.

When Answerability is not tested, the grade is the weighted average of the other two parts: Access counts for two thirds and Freshness for one third. The report says which parts the grade is based on. Every report records its `methodology.version`; scores from different versions are not comparable.

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

Give it the address of the docs, such as `https://docs.example.com` or `https://example.com/docs`. A bare domain such as `example.com` is resolved to its docs, such as `docs.example.com` or `example.com/docs`, when it has them.

### Answerability with your own model

`--ai` reads the key from the provider's usual environment variable:

| `--ai` | Key | Default models (questions, solver, judge) |
| --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` | claude-haiku-4-5-20251001, claude-haiku-4-5-20251001, claude-sonnet-5 |
| `openai` | `OPENAI_API_KEY` | gpt-5.4-mini, gpt-5.4-mini, gpt-5.4 |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` | gemini-2.5-flash, gemini-2.5-flash, gemini-2.5-pro |
| `gateway` | `AI_GATEWAY_API_KEY` | anthropic/claude-haiku-4.5, anthropic/claude-haiku-4.5, anthropic/claude-sonnet-5 |

```bash
ANTHROPIC_API_KEY=sk-... npx @documentation-ai/agent-score check https://docs.example.com --ai anthropic
```

The run prints its estimated cost. A test is 5 to 8 questions; on a 10-page sample of our own docs it cost about $0.24 with the Anthropic defaults.

## Use it from code

```ts
import { createAnswerabilityModels, scanSite } from '@documentation-ai/agent-score';

const { report } = await scanSite('https://docs.example.com');
console.log(report.overall.score, report.overall.grade, report.topFixes);

// With Answerability
const models = await createAnswerabilityModels({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
});
const { report: full, answerabilityCostUsd } = await scanSite('https://docs.example.com', { models });
```

`scanSite` runs every stage in one call. To run the stages as separate jobs, as the hosted scanner does, call `resolveTarget`, `runTechnicalAssessment`, `runAnswerability` and `finalizeReport` yourself. The report's shape is exported as the `AgentScoreReport` type.

## How the scanner behaves on your site

- It identifies itself as `Mozilla/5.0 (compatible; DocumentationAI-AgentScore/1.0; +https://documentation.ai/agent-score)`.
- It follows robots.txt (RFC 9309), including `Crawl-delay`.
- It waits 200 ms between requests to a site, makes at most 3 at a time, and honours `Retry-After`.
- A scan stops after 260 requests or 45 seconds, and tests a sample of 10 pages.
- It refuses private and internal addresses, so it cannot be pointed at a local network. That also means it cannot scan `localhost`.

To opt out, add this to robots.txt:

```
User-agent: DocumentationAI-AgentScore
Disallow: /
```

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
npm run check -- https://docs.example.com   # run the CLI from source
```

## Credits

The Access checks and their scoring come from [AFDocs](https://github.com/agent-ecosystem/afdocs) (MIT), pinned to an exact version so scores stay reproducible.

## License

MIT
