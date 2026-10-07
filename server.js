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

const MODELS = ["openai/gpt-oss-120b", "meta-llama/llama-3.3-70b-instruct", "qwen/qwen3-235b-a22b-2507", "deepseek/deepseek-chat-v3.1"];
const DEFAULT_US = "Groq";
const MINUTES_PER_SOURCE = 10; // manual time to look up and compare one model's prices across providers

// Live price board straight from OpenRouter's public API (cached 60s).
let marketCache = { at: 0, data: null };
async function market() {
  if (Date.now() - marketCache.at < 60000 && marketCache.data) return marketCache.data;
  const rows = [];
  await Promise.all(MODELS.map(async (m) => {
    const r = await fetch(`https://openrouter.ai/api/v1/models/${m}/endpoints`, { signal: AbortSignal.timeout(15000) });
    const d = (await r.json()).data;
    const best = {};
    for (const e of d.endpoints) {
      const row = { model: m, model_name: d.name, provider: e.provider_name,
        in: +(e.pricing.prompt * 1e6).toFixed(3), out: +(e.pricing.completion * 1e6).toFixed(3),
        uptime: e.uptime_last_30m != null ? +e.uptime_last_30m.toFixed(2) : null, ctx: e.context_length, quant: e.quantization };
      const k = row.provider; if (!best[k] || row.in + row.out < best[k].in + best[k].out) best[k] = row;
    }
    rows.push(...Object.values(best));
  }));
  marketCache = { at: Date.now(), data: { models: MODELS, rows, fetched_at: new Date().toISOString() } };
  return marketCache.data;
}

async function ensureCompetitor(us = DEFAULT_US) {
  const { rows } = await db.query(
    `insert into competitors (name, slug, sources) values ($1, $2, $3)
     on conflict (slug) do update set sources = excluded.sources returning *`,
    [us, "market:" + us.toLowerCase(), JSON.stringify(MODELS.map((m) => ({ source: m, url: `https://openrouter.ai/${m}/providers` })))]
  );
  return rows[0];
}

const setStep = (id, step) => db.query("update sweeps set step = $2 where id = $1", [id, step]);

// --- Agent37: one agent turn does the whole sweep (fetch via Monid, compare with memory, judge) ---
async function runAgent(comp) {
  const tpl = fs.readFileSync(path.join(__dirname, "agent", "sweep-prompt.md"), "utf8");
  const prompt = tpl
    .replaceAll("{{us}}", comp.name)
    .replaceAll("{{models}}", MODELS.join(", "));
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
            "You are the pricing and sales-enablement lead at an AI inference provider. Given one verified competitor finding, return JSON: " +
            '{"threat":"high|medium|low","slack":"a Slack message to the sales channel, max 3 short lines, starts with an emoji, ends with the evidence link",' +
            '"battlecard":"one concrete recommended response: a price move, a sales talking point, or a deal to target"}. Be concrete; no hype.',
        },
        { role: "user", content: JSON.stringify({ we_are: comp.name, ...change }) },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`judge ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

function fallbackSlack(comp, c) {
  return `:rotating_light: Pricing alert for ${comp.name}: ${c.what_changed}\nWhy it matters: ${c.why_it_matters}\n${c.evidence_url}`;
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

app.get("/api/market", async (req, res) => {
  try { res.json(await market()); } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post("/api/sweep", async (req, res) => {
  const comp = await ensureCompetitor(req.body?.us || DEFAULT_US);
  const running = await db.query("select id from sweeps where competitor_id = $1 and status = 'running' and started_at > now() - interval '20 minutes'", [comp.id]);
  if (running.rows.length) return res.json({ id: running.rows[0].id, already: true });
  const { rows } = await db.query("insert into sweeps (competitor_id, step) values ($1, 'start') returning id", [comp.id]);
  sweep(rows[0].id, comp);
  res.json({ id: rows[0].id });
});

app.get("/api/state", async (req, res) => {
  const comp = await ensureCompetitor(req.query.us || DEFAULT_US);
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
