# Rivalradar: build plan

> Competitive intelligence that runs itself. Name your rivals; an always-on agent watches their pricing, product, hiring and reputation, spots every move, and hands you the battlecard and the Slack alert.

Hackathon: "Build an Agent" (Agent37 × InsForge × Monid), Wed Oct 7 2026, PDT. **Submissions close 4:40 PM PDT (5:10 AM IST).**
Challenge: *build an agent that takes over repetitive, frustrating work you'd happily never touch again. Build agents you can sell.*

---

## 1. The problem

Every week, someone at every startup (a PM, a founder, a salesperson) clicks through competitors' websites, pricing pages, changelogs, job boards, X and Reddit to find out "what did they ship, what did they change, who are they hiring, are their users angry?" It's tedious, it's skipped half the time, and when it's skipped, sales gets blindsided on a call.

The companies that pay to have it done use **Crayon or Klue, at $20K–$40K a year**, plus analyst time.

**Rivalradar replaces that workflow and that subscription.**

## 2. What it does

1. **You name your company and your competitors** (e.g. "We're Linear. Watch Jira, Asana, Height").
2. **Each customer gets their own always-on agent** on Agent37. It sweeps every competitor across five signal types:

   | Signal | What the agent looks at | Why sales cares |
   | --- | --- | --- |
   | **Pricing** | pricing page, plans, limits | "They raised prices 20%: call their customers" |
   | **Product** | changelog, docs, launch posts | "They shipped X: here's our counter" |
   | **Hiring** | job postings (count, roles, locations) | "10 new enterprise AE roles: they're moving upmarket" |
   | **Sentiment** | Reddit, X, reviews | "Users are angry about the outage: opening for us" |
   | **Messaging** | homepage headline, positioning | "They now pitch 'AI-first': they're repositioning" |

3. **It remembers.** Snapshots persist in the instance's files, so every sweep is compared with the last one. Only *changes* become signals.
4. **It scores and acts.** Each signal gets a type, a threat level (high / medium / low) and a one-line "so what". The agent then **updates the competitor's battlecard** and **drafts a Slack alert** for the sales team.
5. **It schedules itself.** An Agent37 cron re-runs the sweep every morning, so nobody has to remember.
6. **You watch it all on a live 3D radar.**

## 3. Sponsor usage (prize eligibility: Agent37 + ≥1 sponsor; we use all)

| Sponsor | Role in Rivalradar |
| --- | --- |
| **Agent37** (required) | One Hermes agent instance per customer workspace (`POST /v1/instances`, template `agent37-hermes`). Sweeps run as agent turns (`POST /v1/responses` on `https://{id}.agent37.app`). Daily sweep via **Agent37 crons** (`POST /v1/instances/{id}/crons`). Snapshots kept in the instance's persistent files. Monid key passed via instance `env`. |
| **Monid** | The agent's tool layer: page scraping (pricing, changelog, homepage), social search (Reddit, X), job postings, reviews. All behind one key, discovered at runtime (`discover` → `inspect` → `run`). |
| **OpenAI** (via our TokenRouter, OpenAI models) | Turns raw sweep output into structured signals (type, threat, summary, evidence URL), writes battlecards and Slack alert drafts. JSON/structured outputs. |
| **Supabase** | Postgres for workspaces, competitors, snapshots, signals, battlecards. **Realtime** streams every new signal to the 3D radar the moment it's written. |
| **InstaCloud** | Hosts the deployed web app + API (live demo URL for judges). |

## 4. Architecture

```
 Browser: 3D radar (React + Three.js)
     │  ▲ Supabase Realtime (new signals, sweep status)
     │  │
     ▼  │
 API server (Node, hosted on InstaCloud)
     │  POST /api/competitors   add rival
     │  POST /api/sweep         trigger sweep now
     │
     ├──► Agent37 API ── instance per workspace (Hermes agent)
     │         │  POST /v1/responses: "sweep these competitors, compare to last snapshot"
     │         │  cron: every day 08:00 → same sweep
     │         └──► Monid (scrape / social / jobs / reviews), via MONID_API_KEY in env
     │
     ├──► OpenAI via TokenRouter: raw findings → structured signals + battlecard + Slack draft
     │
     └──► Supabase: write snapshots, signals, battlecards (→ Realtime → radar)
```

**Sweep flow**
1. API marks the sweep `running` in Supabase (radar shows the sweep beam turning faster).
2. API sends the sweep prompt to the workspace's Agent37 instance. The agent uses Monid tools for each competitor, saves the new snapshot to `/home/node/snapshots/<competitor>/<date>.json`, diffs it against the previous one, and returns findings as JSON.
3. API sends the findings to OpenAI (TokenRouter): classify, score threat, write a "so what", update the battlecard, draft the Slack alert.
4. API inserts the signals. Supabase Realtime sends them to the radar: particle trail, node pulse, signal card.
5. Sweep marked `done`, with stats (sources checked, minutes of manual work replaced).

## 5. Data model (Supabase)

```sql
workspaces  (id, name, company, company_url, agent37_instance_id, created_at)
competitors (id, workspace_id, name, url, logo_url, threat_score int, last_swept_at)
sweeps      (id, workspace_id, status text, started_at, finished_at, sources_checked int, minutes_saved int)
snapshots   (id, competitor_id, sweep_id, kind text, data jsonb, created_at)
signals     (id, competitor_id, sweep_id, type text,        -- pricing|product|hiring|sentiment|messaging
             threat text,                                    -- high|medium|low
             title, summary, so_what, evidence_url, created_at)
battlecards (competitor_id pk, strengths text[], weaknesses text[], how_to_win text,
             objection_handlers jsonb, updated_at)
actions     (id, signal_id, kind text,                       -- slack_alert|email
             draft text, status text, created_at)            -- draft|approved
```
Realtime enabled on `signals`, `sweeps`, `competitors`. RLS on; demo workspace readable by anon.

## 6. The 3D radar (the "wow")

- Dark space scene, React Three Fiber + drei + postprocessing (bloom).
- **Center:** your company as a glowing core.
- **Rings:** 3 orbit rings = threat tiers (inner = high threat). Competitors are glowing spheres with logo sprites; size = activity, color = latest threat (red / amber / green).
- **Sweep beam:** a rotating radar cone; spins faster while a sweep is running.
- **Live signals:** each new signal launches a particle trail from the competitor to the core; the competitor pulses; a signal card slides into the right-hand feed.
- **Click a competitor:** the camera flies to it, and a side panel shows its battlecard + signal timeline + drafted Slack alert ("Approve & send").
- **HUD:** sweeps run · sources checked · signals found · **hours of manual research replaced**.
- Add-competitor input ("+ Watch a competitor") → new node flies into orbit.

## 7. Demo script (≈2 min)

1. **Hook (15s):** "Every Monday someone on your team spends hours stalking competitors. Crayon charges $25K a year to do it. We replaced it with an agent."
2. **The radar (20s):** pre-populated workspace: Linear vs Jira, Asana, Height, Monday. Signals already in: price change, new feature, hiring spike, Reddit complaints.
3. **Live (60s):** type a new competitor, e.g. "Notion", hit **Sweep now**. The agent runs live on Agent37, calls Monid; the beam spins; signals fly in; click → battlecard + drafted Slack alert.
4. **Business (20s):** one agent per customer on Agent37, runs itself daily via cron, costs cents a day in compute. Sells per seat for a fraction of Crayon.
5. **Close (5s):** "Rivalradar: never check a competitor's website again."

## 8. Build timeline (now → 4:40 PM PDT)

| When (IST) | Task |
| --- | --- |
| 03:25–03:45 | Repo scaffold (Vite + React + R3F, Node API); Supabase schema + Realtime; create the Agent37 instance with `MONID_API_KEY` in env |
| 03:45–04:20 | 3D radar: scene, rings, competitor nodes, sweep beam, signal particles, feed, battlecard panel. Connected to Supabase Realtime |
| 04:20–04:40 | Sweep pipeline: API → Agent37 `/v1/responses` → OpenAI structuring → Supabase. Daily cron created |
| 04:40–04:50 | Seed demo workspace with real sweep results (run sweeps on 4 competitors) |
| 04:50–05:00 | Deploy on InstaCloud; record 2-min demo video |
| 05:00–05:10 | Submit the form: team, workflow replaced, video link, sponsor integrations, live URL, repo link (public) |

## 9. Risks and fallbacks

| Risk | Fallback |
| --- | --- |
| A live agent sweep takes 1–3 min or fails on stage | Seed real results beforehand; live demo sweeps one competitor; UI shows streaming progress so waiting looks intentional |
| Monid tool cost / balance ($1.00) | Limit each sweep to ~4 calls per competitor; check prices with `inspect` first |
| Agent37 balance ($5.00, auto top-up off) | Default 2 vCPU shape ≈ $0.0065/hr; managed-model turns are the main cost; keep sweeps few |
| InstaCloud deploy problems | Fallback host: Vercel/InsForge Sites; keep InstaCloud for the API if possible |
| WebGL perf on judges' laptops | Cap particle count; 2D fallback list view |

## 10. Submission checklist (Google Form)

- [ ] Team members
- [ ] Workflow replaced: "weekly manual competitor research + Crayon/Klue subscription"
- [ ] Demo video link (public, no access request)
- [ ] Sponsor integrations: Agent37 (instances, responses, crons), Monid, OpenAI, Supabase, InstaCloud
- [ ] Live project URL + public repo link
- [ ] Up to 5 files (≤10 MB each): screenshots of radar + battlecard

## 11. Still needed from Shivam

- [ ] TokenRouter base URL + API key (OpenAI models)
- [ ] Supabase project URL, anon key, service-role key
- [ ] Full new Agent37 key (the screenshot cut it off; the Playground key works meanwhile)
- [ ] InstaCloud: sign up, or approve the device login when `npx insta setup agent` runs

Secrets live in `../accounts/.env` and are **never committed**; the app reads them from its own untracked `.env`.
