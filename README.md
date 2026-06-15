# income-radar

Self-hosted AI-powered income automation dashboard. Monitors 10 freelance/bounty sources, auto-generates proposals, tracks earnings across 20 income streams.

## What it does

- **Scrapes 10 sources** every 5 minutes: Useme, Freelancer, Upwork, Opire, Algora, GitHub bounties, Devpost, HackerOne, Airdrops, Fiverr
- **Smart scoring** — repo health, competition level, skill match, freshness
- **AI auto-drafts** — personalized proposals via Claude CLI (8 offers + 5 bounty analyses per cycle)
- **Telegram alerts** with priority tiers (high-value vs standard)
- **Draft queue** with 1-click approve/skip
- **Win-rate tracking** and earnings aggregator
- **Cold outreach** engine with lead management and AI-personalized emails
- **Content pipeline** — generates posts for Twitter, LinkedIn, Reddit, dev.to
- **20 income streams** tracked with activation status

Pipeline: **28 seconds** end-to-end.

## Architecture

```
co 5 min → fetch 10 sources → smart scoring → AI draft → auto-personalize
→ queue → Telegram alert → daily summary at 20:00
```

## Modules

| Module | Purpose |
|---|---|
| `server.mjs` | HTTP API (35 endpoints) + pipeline orchestration |
| `fetch.mjs` | 10-source scraper with repo health scoring |
| `llm.mjs` | Claude CLI: offers, bounty GO/NO-GO analysis, personalization |
| `outreach.mjs` | Cold email engine: leads, templates, AI drafts, business scraping |
| `content.mjs` | Multi-platform content generator (5 platforms) |
| `offers.mjs` | CDP auto-submit for browser-based platforms |
| `hotels.mjs` | Hotel price monitoring (Pruvo model) |

## Tech

- **Zero npm dependencies** — pure Node.js ESM (v21+)
- Claude CLI for LLM
- Single-file SPA dashboard (inline CSS + JS)
- JSON file storage
- Telegram Bot API

## Quick start

```bash
git clone https://github.com/trixer666/income-radar
cd income-radar
cp config.example.json config.json
# Add your tokens to config.json
node server.mjs
# http://127.0.0.1:7777
```

## API

| Endpoint | Method | Description |
|---|---|---|
| `/api/items` | GET | All tracked items |
| `/api/stats` | GET | Dashboard stats |
| `/api/drafts` | GET | Generated drafts |
| `/api/queue` | GET | Draft approval queue |
| `/api/earnings` | GET | Earnings aggregator |
| `/api/streams` | GET | 20 income streams |
| `/api/outreach` | GET | Outreach leads + templates |
| `/api/content` | GET | Generated content |
| `/api/winrates` | GET | Win-rate per source |
| `/api/refresh` | POST | Trigger manual refresh |

## Author

**Patryk** — [trixer666.github.io](https://trixer666.github.io) | Automation, bots, AI orchestration

Available for freelance work: automation pipelines, Telegram bots, web scrapers, AI integrations, n8n workflows.
