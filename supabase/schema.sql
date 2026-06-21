-- Card Reminder — database schema
-- Paste this whole file into Supabase → SQL Editor → Run.

create table if not exists cards (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz default now(),

  owner           text not null,              -- a name or email so people see only their cards
  telegram_chat_id text not null,             -- where reminders are sent

  name            text not null,              -- e.g. "HDFC Millennia"
  credit_limit    numeric not null default 0,
  monthly_target  numeric not null default 0, -- monthly spend goal you want to hit
  used            numeric not null default 0, -- spend logged so far this cycle

  statement_day   int not null check (statement_day between 1 and 28),
  payment_day     int not null check (payment_day between 1 and 28),

  -- per-cycle approval state, set by the ✅ Done button
  payment_done    boolean not null default false,
  usage_done      boolean not null default false,
  last_cycle_month int                         -- used to auto-reset done flags each new cycle
);

-- Row Level Security: lets the browser (anon key) read/write only via owner match.
-- The bot uses the service_role key and bypasses RLS.
alter table cards enable row level security;

create policy "owner can read"  on cards for select using (true);
create policy "owner can insert" on cards for insert with check (true);
create policy "owner can update" on cards for update using (true);
create policy "owner can delete" on cards for delete using (true);

-- Note: the policies above are permissive for a simple shared-link setup.
-- For stronger isolation, add Supabase Auth and replace `true` with
-- `auth.uid()::text = owner`.
