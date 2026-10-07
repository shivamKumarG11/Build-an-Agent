// Rivalradar API: runs competitor sweeps on an Agent37 agent (which fetches pages through Monid),
// has an OpenAI model judge each change, and stores everything in Supabase Postgres.
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");

const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 4 });
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const DEMO = {
  name: "Linear",
  slug: "linear",
  sources: [
    { source: "pricing", url: "https://linear.app/pricing" },
    { source: "changelog", url: "https://linear.app/changelog" },
    { source: "careers", url: "https://linear.app/careers" },
  ],
};
const BASELINE = "20260401"; // Wayback Machine date used as "last sweep" when no snapshot exists yet
const MINUTES_PER_SOURCE = 15; // manual time to open, read and compare one source

async function ensureCompetitor() {
  const { rows } = await db.query(
    `insert into competitors (name, slug, sources) values ($1, $2, $3)
     on conflict (slug) do update set sources = excluded.sources returning *`,
    [DEMO.name, DEMO.slug, JSON.stringify(DEMO.sources)]
  );
  return rows[0];
}

const setStep = (id, step) => db.query("update sweeps set step = $2 where id = $1", [id, step]);

// --- Agent37: one agent turn does the whole sweep (fetch via Monid, compare with memory, judge) ---
async function runAgent(comp) {
  const tpl = fs.readFileSync(path.join(__dirname, "agent", "sweep-prompt.md"), "utf8");
  const prompt = tpl
    .replaceAll("{{name}}", comp.name)
    .replaceAll("{{slug}}", comp.slug)
    .replaceAll("{{baseline}}", BASELINE)
    .replaceAll("{{sources}}", comp.sources.map((s) => `- ${s.source}: ${s.url}`).join("\n"));
  const res = await fetch(`https://${process.env.AGENT37_INSTANCE_ID}.agent37.app/v1/responses`, {
    method: "POST",
    headers: { "X-Agent37-Key": process.env.AGENT37_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ input: prompt }),
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  const body = await res.json();
  if (body.status === "failed" || !body.output_text) throw new Error(body.error?.message || `agent returned ${res.status}`);
  return parseJson(body.output_text);
}

function parseJson(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const s = m ? m[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(s);
}

// --- OpenAI (via TokenRouter): threat score + Slack alert + battlecard line per change ---
async function judge(comp, change) {
  if (!process.env.TOKENROUTER_BASE_URL) return null;
  const res = await fetch(`${process.env.TOKENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TOKENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.JUDGE_MODEL || "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a sharp sales-enablement lead. Given one verified change at a competitor, return JSON: " +
            '{"threat":"high|medium|low","slack":"a Slack message to the sales channel, max 3 short lines, starts with an emoji, ends with the evidence link",' +
            '"battlecard":"one line to add to the battlecard: how to sell against this"}. Be concrete; no hype.',
        },
        { role: "user", content: JSON.stringify({ competitor: comp.name, ...change }) },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`judge ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

function fallbackSlack(comp, c) {
  return `:rotating_light: ${comp.name}: ${c.what_changed}\nWhy it matters: ${c.why_it_matters}\n${c.evidence_url}`;
}

async function sweep(sweepId, comp) {
  try {
    await setStep(sweepId, "agent");
    const out = await runAgent(comp);
    const checked = (out.checked || []).filter((c) => c.status === "ok").length;
    await db.query("update sweeps set raw = $2, sources_checked = $3, step = 'judge' where id = $1", [sweepId, out, checked]);
    for (const c of out.changes || []) {
      let j = null;
      try { j = await judge(comp, c); } catch (e) { console.error(e.message); }
      const { rows } = await db.query(
        `insert into signals (sweep_id, competitor_id, source, what_changed, before, after, evidence_url, matters, why_it_matters, confidence, threat)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [sweepId, comp.id, c.source, c.what_changed, c.before, c.after, c.evidence_url, c.matters !== false, c.why_it_matters, c.confidence,
         j?.threat || (c.confidence === "high" ? "high" : "medium")]
      );
      if (c.matters !== false) {
        await db.query("insert into actions (signal_id, kind, draft) values ($1, 'slack_alert', $2)", [rows[0].id, j?.slack || fallbackSlack(comp, c)]);
        if (j?.battlecard) await db.query("insert into actions (signal_id, kind, draft) values ($1, 'battlecard', $2)", [rows[0].id, j.battlecard]);
      }
    }
    await db.query("update sweeps set status = 'done', step = 'done', finished_at = now() where id = $1", [sweepId]);
  } catch (e) {
    console.error("sweep failed:", e.message);
    await db.query("update sweeps set status = 'failed', error = $2, finished_at = now() where id = $1", [sweepId, e.message]);
  }
}

app.post("/api/sweep", async (req, res) => {
  const comp = await ensureCompetitor();
  const running = await db.query("select id from sweeps where competitor_id = $1 and status = 'running' and started_at > now() - interval '20 minutes'", [comp.id]);
  if (running.rows.length) return res.json({ id: running.rows[0].id, already: true });
  const { rows } = await db.query("insert into sweeps (competitor_id, step) values ($1, 'start') returning id", [comp.id]);
  sweep(rows[0].id, comp);
  res.json({ id: rows[0].id });
});

app.get("/api/state", async (req, res) => {
  const comp = await ensureCompetitor();
  const sweeps = (await db.query("select id, status, step, started_at, finished_at, sources_checked, error from sweeps where competitor_id = $1 order by id desc limit 10", [comp.id])).rows;
  const signals = (await db.query(
    `select s.*, coalesce(json_agg(a order by a.id) filter (where a.id is not null), '[]') as actions
     from signals s left join actions a on a.signal_id = s.id where s.competitor_id = $1
     group by s.id order by s.matters desc, case s.threat when 'high' then 0 when 'medium' then 1 else 2 end, s.id desc`, [comp.id])).rows;
  const done = sweeps.filter((s) => s.status === "done");
  res.json({
    competitor: comp,
    sweeps,
    signals,
    stats: {
      sweeps: done.length,
      sources_checked: done.reduce((n, s) => n + (s.sources_checked || 0), 0),
      signals: signals.filter((s) => s.matters).length,
      minutes_saved: done.reduce((n, s) => n + (s.sources_checked || 0) * MINUTES_PER_SOURCE, 0),
    },
  });
});

app.post("/api/actions/:id/approve", async (req, res) => {
  const { rows } = await db.query("update actions set status = 'approved' where id = $1 returning *", [req.params.id]);
  res.json(rows[0] || {});
});

app.listen(process.env.PORT || 3000, () => console.log(`Rivalradar on http://localhost:${process.env.PORT || 3000}`));
