# Rivalradar

**Tell us what you sell. Your agent finds your rivals and watches their prices.**

Live demo: https://prod-main-app-ac6eeb-00j076ypky2.compute.instacloud-edge.com

Built at the "Build an Agent" hackathon (Agent37 × InsForge × Monid, San Francisco, Oct 7 2026).

## The workflow it replaces

If you sell anything online, someone has to keep checking what your rivals charge: search Amazon and Google Shopping, find the products that really compete with yours, note prices and ratings, read reviews, decide whether to react. Nobody wants that job, so it gets skipped, and a rival quietly undercuts you.

Rivalradar takes **two inputs**, a product type and the link to your product, and does the rest:

1. Reads your product page (title, price, defining specs).
2. Finds the closest competing products itself, in your market and currency. Shoes, a ceiling fan, a mattress: no predefined categories.
3. Ranks them by threat (close substitute + cheaper + better rated = biggest threat).
4. Maps the market: price band and where you sit, what the top-rated rivals win on, what buyers complain about (reviews, Reddit).
5. Remembers every sweep: the next run reports price moves, new entrants and dropouts. Example from a real run: *"Hoka Clifton 10 went from $99.95 to $119.95 (+20%) since the last sweep."*
6. Turns each finding into a recommended move with numbers and a draft message, for you to approve with one click.

Sweeps are manual: you press the button when you want a fresh look.

## How it's built

| Sponsor | Role |
| --- | --- |
| **Agent37** | The agent lives on its own always-on Hermes instance. Each sweep is one agent turn (`POST /v1/responses`). The instance's persistent files are its memory between sweeps. Model spend capped with the instance budget API. |
| **Monid** | The agent's tools, chosen at runtime: page reader (`context.dev`), Google Shopping (`litescrape`), Amazon (`dataforseo`), web search for reviews and Reddit. One key, about 1 cent per sweep. |
| **OpenAI** (via TokenRouter) | Scores each finding and drafts the owner's move and message (JSON output). |
| **Supabase** | Postgres for watches, sweeps (with the agent's raw JSON), findings and approvals. |
| **InstaCloud** | Hosts the app; secrets live in InstaCloud project secrets. |

```
Browser ── Node/Express (InstaCloud) ── Supabase Postgres
                 │
                 ├── Agent37 agent ── Monid (page reader, Google Shopping, Amazon, web search)
                 │        └── memory: its own files on the instance
                 └── OpenAI via TokenRouter (moves + messages)
```

The front end is a single page: Claude-inspired warm design, an isometric 3D "market floor" (Three.js) where your product stands in the middle and rivals stand on pedestals whose height is their price and colour is their threat, while a small robot agent walks between them during a sweep.

## Run it

```bash
npm install
cp .env.example .env   # fill in the values
node server.js         # http://localhost:3000
```

`db/schema.sql` creates the tables. `agent/sweep-prompt.md` is the agent's full instruction set.
