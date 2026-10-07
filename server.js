// Rivalradar API: a business owner gives a product type + their product link. An Agent37 agent
// (calling Monid for page reads and shopping searches) finds and ranks competitors and tracks their
// prices across sweeps; an OpenAI model drafts the response to each finding; Supabase stores it all.
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");

const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 4, idleTimeoutMillis: 20000 });
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const MINUTES_PER_COMPETITOR = 8; // manual time to find, open and compare one rival listing

const slugify = (s) => s.toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

// A "watch" is one product the owner wants defended: stored in competitors(name = product type, sources = [{url, market}]).
async function upsertWatch(type, url, market) {
  const { rows } = await db.query(
    `insert into competitors (name, slug, sources) values ($1, $2, $3)
     on conflict (slug) do update set name = excluded.name, sources = excluded.sources returning *`,
    [type, slugify(url), JSON.stringify([{ source: "owner", url, market }])]
  );
  return rows[0];
}

const setStep = (id, step) => db.query("update sweeps set step = $2 where id = $1", [id, step]);

// --- Agent37: one agent turn does the research (Monid tools + memory in the instance's files) ---
async function runAgent(w) {
  const src = w.sources[0];
  const prompt = fs.readFileSync(path.join(__dirname, "agent", "sweep-prompt.md"), "utf8")
    .replaceAll("{{type}}", w.name)
    .replaceAll("{{url}}", src.url)
    .replaceAll("{{market}}", src.market || "infer from the owner's page (country and currency)")
    .replaceAll("{{slug}}", w.slug);
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
  return JSON.parse(m ? m[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

// --- OpenAI (via TokenRouter): priority + the owner's next move for each finding ---
async function judge(w, mine, change) {
  if (!process.env.TOKENROUTER_BASE_URL) return null;
  const res = await fetch(`${process.env.TOKENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TOKENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.JUDGE_MODEL || "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You advise a small-business owner on pricing and positioning. Given one verified competitor finding, return JSON: " +
            '{"threat":"high|medium|low","move":"one concrete action for the owner (price change with a number, listing or bundle change, promotion), max 2 sentences",' +
            '"message":"a short note the owner could send their team or post as a price-match update, max 3 lines"}. Use the exact numbers; no hype.',
        },
        { role: "user", content: JSON.stringify({ product_type: w.name, owner_product: mine, finding: change }) },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`judge ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return JSON.parse((await res.json()).choices[0].message.content);
}

async function sweep(sweepId, w) {
  try {
    await setStep(sweepId, "agent");
    const out = await runAgent(w);
    const checked = (out.competitors || []).length;
    await db.query("update sweeps set raw = $2, sources_checked = $3, step = 'judge' where id = $1", [sweepId, out, checked]);
    await Promise.all((out.changes || []).map(async (c) => {
      let j = null;
      try { j = await judge(w, out.my_product, c); } catch (e) { console.error(e.message); }
      const { rows } = await db.query(
        `insert into signals (sweep_id, competitor_id, source, what_changed, before, after, evidence_url, matters, why_it_matters, confidence, threat)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [sweepId, w.id, c.source, c.what_changed, c.before, c.after, c.evidence_url, c.matters !== false, c.why_it_matters, c.confidence,
         j?.threat || (c.confidence === "high" ? "high" : "medium")]
      );
      if (c.matters !== false) {
        if (j?.move) await db.query("insert into actions (signal_id, kind, draft) values ($1, 'move', $2)", [rows[0].id, j.move]);
        if (j?.message) await db.query("insert into actions (signal_id, kind, draft) values ($1, 'message', $2)", [rows[0].id, j.message]);
      }
    }));
    await db.query("update sweeps set status = 'done', step = 'done', finished_at = now() where id = $1", [sweepId]);
  } catch (e) {
    console.error("sweep failed:", e.message);
    await db.query("update sweeps set status = 'failed', error = $2, finished_at = now() where id = $1", [sweepId, e.message]);
  }
}

// Start watching a product (or re-sweep an existing watch). Manual only: nothing runs on a schedule.
app.post("/api/sweep", async (req, res) => {
  try {
    const { type, url, market } = req.body || {};
    if (!type || !/^https?:\/\//.test(url || "")) return res.status(400).json({ error: "Give a product type and your product's link." });
    const w = await upsertWatch(type.trim(), url.trim(), (market || "").trim());
    const running = await db.query("select id from sweeps where competitor_id = $1 and status = 'running' and started_at > now() - interval '20 minutes'", [w.id]);
    if (running.rows.length) return res.json({ watch: w.id, sweep: running.rows[0].id, already: true });
    const { rows } = await db.query("insert into sweeps (competitor_id, step) values ($1, 'start') returning id", [w.id]);
    sweep(rows[0].id, w);
    res.json({ watch: w.id, sweep: rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/watches", async (req, res) => {
  try {
    const { rows } = await db.query(
      `select c.id, c.name, c.sources, (select status from sweeps s where s.competitor_id = c.id order by id desc limit 1) as last_status
       from competitors c where c.slug not like 'market:%' and c.slug <> 'linear' order by c.id desc`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/watches/:id", async (req, res) => {
  try {
    const w = (await db.query("select * from competitors where id = $1", [req.params.id])).rows[0];
    if (!w) return res.status(404).json({ error: "not found" });
    const sweeps = (await db.query("select id, status, step, started_at, finished_at, sources_checked, error from sweeps where competitor_id = $1 order by id desc limit 10", [w.id])).rows;
    const lastDone = (await db.query("select raw from sweeps where competitor_id = $1 and status = 'done' order by id desc limit 1", [w.id])).rows[0];
    const signals = (await db.query(
      `select s.*, coalesce(json_agg(a order by a.id) filter (where a.id is not null), '[]') as actions
       from signals s left join actions a on a.signal_id = s.id
       where s.sweep_id = (select max(id) from sweeps where competitor_id = $1 and status = 'done')
       group by s.id order by s.matters desc, case s.threat when 'high' then 0 when 'medium' then 1 else 2 end, s.id`, [w.id])).rows;
    const done = sweeps.filter((s) => s.status === "done");
    res.json({
      watch: w, sweeps, signals,
      market: lastDone?.raw ? { my_product: lastDone.raw.my_product, competitors: lastDone.raw.competitors || [], insights: lastDone.raw.insights || null, had_previous_sweep: lastDone.raw.had_previous_sweep } : null,
      stats: {
        sweeps: done.length,
        competitors: lastDone?.raw?.competitors?.length || 0,
        signals: signals.filter((s) => s.matters).length,
        minutes_saved: done.reduce((n, s) => n + (s.sources_checked || 0) * MINUTES_PER_COMPETITOR, 0),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/actions/:id/approve", async (req, res) => {
  const { rows } = await db.query("update actions set status = 'approved' where id = $1 returning *", [req.params.id]);
  res.json(rows[0] || {});
});

app.listen(process.env.PORT || 3000, () => console.log(`Rivalradar on http://localhost:${process.env.PORT || 3000}`));
