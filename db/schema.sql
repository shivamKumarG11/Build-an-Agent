-- Rivalradar schema (Supabase Postgres). RLS on with no policies: only the server (postgres role) reads/writes.
create table if not exists competitors (
  id serial primary key,
  name text not null,
  slug text unique not null,
  sources jsonb not null,            -- [{"source":"pricing","url":"..."}]
  created_at timestamptz default now()
);
create table if not exists sweeps (
  id serial primary key,
  competitor_id int references competitors(id) on delete cascade,
  status text not null default 'running',   -- running | done | failed
  step text,                                 -- current step label for the live timeline
  started_at timestamptz default now(),
  finished_at timestamptz,
  sources_checked int default 0,
  raw jsonb,                                 -- agent's JSON reply
  error text
);
create table if not exists signals (
  id serial primary key,
  sweep_id int references sweeps(id) on delete cascade,
  competitor_id int references competitors(id) on delete cascade,
  source text, what_changed text, before text, after text, evidence_url text,
  matters boolean, why_it_matters text, confidence text,
  threat text,                               -- high | medium | low (OpenAI judge)
  created_at timestamptz default now()
);
create table if not exists actions (
  id serial primary key,
  signal_id int references signals(id) on delete cascade,
  kind text not null,                        -- slack_alert | battlecard
  draft text not null,
  status text not null default 'draft',      -- draft | approved
  created_at timestamptz default now()
);
alter table competitors enable row level security;
alter table sweeps enable row level security;
alter table signals enable row level security;
alter table actions enable row level security;
