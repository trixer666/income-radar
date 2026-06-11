# income-radar

Self-hosted gig & bounty radar. One dashboard that watches six income sources,
scores real competition, and pings you on Telegram while the window to apply
is still open (first 5 proposals get 3-5x more views — speed is the game).

## Sources

| Source | Method | Signal |
|---|---|---|
| Opire | public API | bounties with claim/try counts |
| Algora | org pages | open bounties per org |
| GitHub | Search API (`bounty` labels) | global bounty discovery, star-filtered anti-spam |
| Freelancer.com | public API | gigs with bid counts & budgets |
| Useme (PL) | listing scrape | local gigs with offer counts |
| Devpost | public API | open hackathons & prize pools |

Every GitHub-issue bounty is enriched via the issue timeline: `/claim` &
`/attempt` comments + cross-referenced PRs = the real crowd, not the advertised
one. Closed issues are dropped automatically.

## Features

- **Competition verdicts** — WARTO / OK / TŁOK based on claims, PRs and offers
- **Skill matching** — keyword boost from `config.skills`, flagged in UI
- **Telegram alerts** — fresh high-value items pushed even when the browser is closed
- **Agent queue** — mark items for an AI agent; drafts (offers/analyses) appear in the panel
- **Earnings ledger** — paid items tracked, running total in the header
- Zero dependencies: plain Node.js, single static HTML page

## Quickstart

```
cp config.example.json config.json   # adjust skills/queries, optional Telegram token
node server.mjs                      # http://127.0.0.1:7777
```

Windows: `start.cmd`. Data lives in `data/` (gitignored).
