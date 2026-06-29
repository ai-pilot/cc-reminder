-- Card Reminder — database schema
-- Paste this whole file into Supabase → SQL Editor → Run.
-- It is idempotent: safe to run on a fresh project OR on top of an existing one
-- (it adds any missing columns and the transactions table without dropping data).

-- ──────────────────────────────────────────────────────────────────────────
-- cards: one row per credit card
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists cards (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz default now(),

  owner            text not null,              -- auth user id (or email) — owns the row
  telegram_chat_id text,                       -- where reminders are sent

  name             text not null,              -- e.g. "ADCB Traveller"
  currency         text default 'AED',
  last4            text,                        -- last 4 digits, for matching bank SMS

  credit_limit     numeric not null default 0,
  monthly_target   numeric not null default 0, -- monthly spend goal you want to hit
  balance          numeric not null default 0, -- current statement balance owed

  -- current statement cycle (reset on statement day)
  cycle_spend      numeric not null default 0,
  cycle_paid       numeric not null default 0,
  spend_by_cat     jsonb default '{}'::jsonb,  -- { "Groceries": 1200, "Dining": 400, ... }

  -- calendar-month spend (independent of the statement cycle), for "this month" queries
  month_spend      numeric not null default 0,
  month_spend_key  text,                        -- "2026-06"; resets month_spend when it rolls over

  cashback_rules   jsonb default '{"base":1,"minSpend":0,"needsVerify":false,"rules":[]}'::jsonb,
  history          jsonb default '[]'::jsonb,   -- last 12 closed statements

  statement_day    int not null,                -- 1–31 (clamped to month end at runtime)
  payment_day      int not null,                -- 1–31

  -- per-cycle approval state, set by the ✅ Done button
  payment_done     boolean not null default false,
  usage_done       boolean not null default false,
  last_cycle_month     int,                     -- auto-resets the done flags each new month
  last_statement_month int                      -- guards the once-per-cycle statement close
);

-- Patch older deployments that predate the columns above (no-op on fresh installs).
alter table cards add column if not exists currency             text default 'AED';
alter table cards add column if not exists last4                text;
alter table cards add column if not exists balance              numeric not null default 0;
alter table cards add column if not exists cycle_spend          numeric not null default 0;
alter table cards add column if not exists cycle_paid           numeric not null default 0;
alter table cards add column if not exists spend_by_cat         jsonb default '{}'::jsonb;
alter table cards add column if not exists month_spend          numeric not null default 0;
alter table cards add column if not exists month_spend_key      text;
alter table cards add column if not exists cashback_rules       jsonb default '{"base":1,"minSpend":0,"needsVerify":false,"rules":[]}'::jsonb;
alter table cards add column if not exists history              jsonb default '[]'::jsonb;
alter table cards add column if not exists payment_done         boolean not null default false;
alter table cards add column if not exists usage_done           boolean not null default false;
alter table cards add column if not exists last_cycle_month     int;
alter table cards add column if not exists last_statement_month int;

-- Allow days 1–31 (the app lets you pick up to 31; month-end is handled in code).
-- The original 1–28 check silently rejected saves for cards due on 29–31.
alter table cards drop constraint if exists cards_statement_day_check;
alter table cards drop constraint if exists cards_payment_day_check;
alter table cards add  constraint cards_statement_day_check check (statement_day between 1 and 31);
alter table cards add  constraint cards_payment_day_check  check (payment_day  between 1 and 31);

-- ──────────────────────────────────────────────────────────────────────────
-- transactions: an append-only ledger of individual spends & payments.
-- Powers "last 5 spends", "this month spend till date", and "delete last payment".
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists transactions (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  card_id     uuid not null references cards(id) on delete cascade,
  owner       text,                                  -- mirrors cards.owner, for RLS
  type        text not null check (type in ('spend','payment')),
  category    text,                                  -- set for spends
  merchant    text,
  amount      numeric not null                       -- always positive
);
create index if not exists transactions_card_created_idx on transactions (card_id, created_at desc);

-- ──────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- Policies are permissive for the simple shared-link setup. For stronger
-- isolation, add Supabase Auth and replace `true` with `auth.uid()::text = owner`.
-- The bot uses the service_role key and bypasses RLS entirely.
-- ──────────────────────────────────────────────────────────────────────────
alter table cards        enable row level security;
alter table transactions enable row level security;

drop policy if exists "cards read"   on cards;
drop policy if exists "cards insert" on cards;
drop policy if exists "cards update" on cards;
drop policy if exists "cards delete" on cards;
create policy "cards read"   on cards for select using (true);
create policy "cards insert" on cards for insert with check (true);
create policy "cards update" on cards for update using (true);
create policy "cards delete" on cards for delete using (true);

drop policy if exists "txn read"   on transactions;
drop policy if exists "txn insert" on transactions;
drop policy if exists "txn update" on transactions;
drop policy if exists "txn delete" on transactions;
create policy "txn read"   on transactions for select using (true);
create policy "txn insert" on transactions for insert with check (true);
create policy "txn update" on transactions for update using (true);
create policy "txn delete" on transactions for delete using (true);
