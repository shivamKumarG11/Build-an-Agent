# Rivalradar: build plan

> **Tell us what you sell. Your agent finds your rivals and watches their prices.**
> A business owner types a product type ("running shoes", "ceiling fan", "mattress") and pastes their product's link. Nothing else. The agent reads the product, finds the closest competing products, ranks them by threat, tracks their prices across sweeps, and tells the owner what to do about each one.

Hackathon: "Build an Agent" (Agent37 × InsForge × Monid), Wed Oct 7 2026. **Submissions close 4:40 PM PDT (5:10 AM IST).**
Challenge: *build an agent that takes over repetitive, frustrating work you'd happily never touch again. Build agents you can sell.*

Live: https://prod-main-app-ac6eeb-00j076ypky2.compute.instacloud-edge.com

---

## 1. The problem

Every small brand and online seller has to keep checking what rivals charge: open Amazon, Google Shopping and a dozen competitor sites, find the comparable products, note prices and ratings, decide whether to react. It's tedious, it's skipped, and it costs sales when a rival quietly undercuts you. Pricing-intelligence tools exist (Prisync, Price2Spy, Competera) but they are built for retailers with catalogs, need setup per competitor and SKU, and charge monthly whether or not you use them.

**Rivalradar replaces that weekly chore with two inputs and one button.**

## 2. What it does (one sweep)

1. **Owner input:** product type + link to their product page (+ optional market). No predefined categories: shoes, fans, beds, anything.
2. **Reads the owner's product** (title, brand, price, defining specs) through Monid's page reader.
3. **Finds competitors itself:** searches Google Shopping (and Amazon if thin) through Monid for directly comparable products: same type, similar specs and price band. Picks the 6 closest.
4. **Remembers:** saves each sweep in the agent's own files on Agent37; the next sweep reports price changes, new entrants and disappearances.
5. **Prioritises:** ranks rivals by threat (close substitute + cheaper + better rated = biggest threat).
6. **Decides and drafts:** 3-6 findings that need action, each with evidence; OpenAI turns each into a concrete recommended move (with numbers) and a draft message, which the owner approves with one click.
7. **Manual sweeps only:** the owner presses "Run sweep again" when they want a fresh look. No schedule.

## 3. Sponsor usage (eligibility: Agent37 + at least one sponsor; we use all five, all live)

| Sponsor | Role |
| --- | --- |
| **Agent37** (required) | The agent runs on its own always-on Hermes instance (`tg8c2i3i14`). Each sweep is one agent turn via `POST /v1/responses`. The instance's persistent files are the agent's memory between sweeps. Monid key passed in the instance `env`. $2/month model budget cap set via `PATCH /v1/instances/{id}/budget`. |
| **Monid** | The agent's tools: `context.dev /web/scrape/markdown` (read the owner's page), `litescrape /google/shopping` (rivals, prices, ratings), `dataforseo /amazon/products` (fallback). Discovered and schema-checked at runtime with `inspect`. |
| **OpenAI** (via TokenRouter, `openai/gpt-6-luna`) | Scores each finding and drafts the owner's move and message (JSON output). |
| **Supabase** | Postgres: watches, sweeps (incl. the agent's raw JSON), findings, drafted actions and approvals. Connected through the IPv4 session pooler. |
| **InstaCloud** | Hosts the app (`compute/app`, always-on), secrets stored as InstaCloud project secrets. |

## 4. Architecture

```
Browser (Claude-style UI + small Three.js radar)
   │  POST /api/sweep {type, url, market}      GET /api/watches/:id (polled every 3s)
   ▼
Node/Express on InstaCloud ──► Supabase Postgres (watches, sweeps, signals, actions)
   │
   ├──► Agent37 instance: POST https://tg8c2i3i14.agent37.app/v1/responses
   │        agent ──► Monid: read owner page, Google Shopping / Amazon search
   │        agent ──► its files: /home/node/rivalradar/<slug>.json (memory)
   │        returns JSON: my_product, competitors[], changes[]
   │
   └──► TokenRouter (OpenAI model): per finding → threat, recommended move, draft message
```

## 5. Data model (Supabase)

`competitors` (one row per watch: name = product type, sources = [{url, market}]), `sweeps` (status, step for the live timeline, raw agent JSON, error), `signals` (findings: source, what changed, before/after, evidence URL, why it matters, confidence, threat), `actions` (drafted move / message, draft → approved). RLS on with no policies: only the server reads and writes. Schema in `db/schema.sql`.

## 6. Front end

Claude-style design: ivory background, Source Serif headings, clay-orange accent, light and dark mode. Hero with the two-field form and example chips; stats row (competitors tracked, rivals cheaper than you, findings, manual time replaced); "Your market" (your product card + ranked competitor table with price gap vs you, rating, threat); "What to do" (live sweep steps + finding cards with before/after, evidence, recommended move and draft message with Approve & copy). A small 3D radar in the hero speeds up while a sweep runs and fires a pulse for each new finding.

## 7. Demo script (≈2 min)

1. **Hook:** "If you sell anything online, someone has to keep checking what your rivals charge. Nobody wants that job."
2. **Two inputs:** type "running shoes", paste the product link, press Start watching. Steps light up as the agent works on Agent37 and calls Monid.
3. **Result:** your product card, 6 rivals ranked by threat with price gaps and ratings, and findings like "X is 25% cheaper with a 4.6★ rating", each with a recommended move to approve.
4. **Any product:** switch to a ceiling fan or a mattress that was swept earlier: same agent, no setup.
5. **Memory:** "Run sweep again" compares with the last sweep and reports what changed.
6. **Close:** "Two inputs, one button. Your agent does the competitor research you never get round to."

## 8. Risks and fallbacks

| Risk | Fallback |
| --- | --- |
| A sweep takes 2-4 minutes on stage | Pre-run sweeps for 2-3 products; start a live one at the beginning of the demo and come back to it |
| Shopping search returns loose matches | Prompt requires same type, similar specs and price band; the table shows why each rival was picked |
| Monid balance ($1) / Agent37 balance ($5) | Max 8 Monid calls per sweep (≈$0.01); $2 cap on the agent's model spend |
| Live demo fails | The inference-pricing version is tagged `fallback-inference` in git and works end to end |

## 9. Submission checklist (Google Form, by 4:40 PM PDT)

- [ ] Team members
- [ ] Workflow replaced: "checking competitors' prices and listings by hand"
- [ ] Demo video link (public)
- [ ] Sponsor integrations: Agent37 (instance, responses, files, budgets), Monid (page reader, Google Shopping, Amazon), OpenAI via TokenRouter, Supabase, InstaCloud
- [ ] Live URL + public GitHub repo
- [ ] Screenshots (≤5 files, 10 MB each)

Secrets live only in `.env` (git-ignored) and InstaCloud project secrets.
