-- ============================================================
-- Cubicase Plus — tabela de assinaturas
-- ============================================================
-- Rodar uma vez no SQL editor do projeto Supabase (rtfxcyvymlxebvemgwaj),
-- não existe CLI/migrations neste repo. Só o Worker (api/src/index.ts,
-- via SUPABASE_SERVICE_ROLE_KEY) escreve nesta tabela, a partir dos
-- webhooks customer.subscription.created/updated/deleted do Stripe — o
-- app só LÊ, com a sessão do próprio usuário (RLS abaixo restringe à
-- própria linha).
-- ============================================================

create table public.subscriptions (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id     text not null unique,
  stripe_subscription_id text unique,
  plan                   text not null check (plan in ('monthly', 'annual')),
  status                 text not null check (status in (
                           'trialing', 'active', 'past_due', 'canceled',
                           'unpaid', 'incomplete', 'incomplete_expired', 'paused'
                         )),
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

-- Único acesso do client: o próprio usuário lê a própria linha. Sem policy
-- de insert/update/delete para authenticated/anon — com RLS ligado e
-- nenhuma dessas policies, essas ações já ficam negadas por padrão. Só o
-- Worker escreve, via SUPABASE_SERVICE_ROLE_KEY, que ignora RLS inteiramente.
create policy "select_own_subscription"
  on public.subscriptions for select to authenticated
  using (auth.uid() = user_id);
