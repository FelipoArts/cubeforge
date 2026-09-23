-- ============================================================
-- Painel Web Remoto (Cubicase Plus) — acesso compartilhado (membros e convites)
-- ============================================================
-- Rodar no SQL editor do projeto Supabase (rtfxcyvymlxebvemgwaj), DEPOIS de
-- scripts/supabase-panel-devices.sql (referencia panel_devices). Seguro rodar
-- mais de uma vez.
--
-- Nada aqui é lido/escrito pelo navegador nem pelo app desktop: RLS fica
-- LIGADO e SEM policies de propósito — só o Worker (SUPABASE_SERVICE_ROLE_KEY,
-- que bypassa RLS) mexe nestas tabelas, porque é ele quem decide quem pode
-- convidar quem e quais permissões valem (ver api/src/panel-members.ts).
--
-- panel_device_members  — quem tem acesso a um dispositivo além do dono, e o
--                         que pode fazer (permissions: ver api/src/panel-access.ts).
-- panel_device_invites  — convites pendentes. kind='email' já aponta pra uma
--                         conta existente (target_user_id) e espera a pessoa
--                         aceitar; kind='link' é um token secreto que qualquer
--                         conta logada pode resgatar até expirar/esgotar.
-- ============================================================

create table if not exists public.panel_device_members (
  id           uuid primary key default gen_random_uuid(),
  device_id    uuid not null references public.panel_devices(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  permissions  jsonb not null,
  invited_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (device_id, user_id)
);

create index if not exists panel_device_members_user_id_idx on public.panel_device_members(user_id);

create table if not exists public.panel_device_invites (
  id              uuid primary key default gen_random_uuid(),
  device_id       uuid not null references public.panel_devices(id) on delete cascade,
  kind            text not null check (kind in ('email', 'link')),
  token           text unique,
  target_user_id  uuid references auth.users(id) on delete cascade,
  permissions     jsonb not null,
  single_use      boolean not null default true,
  uses            integer not null default 0,
  expires_at      timestamptz not null,
  created_by      uuid not null references auth.users(id) on delete cascade,
  created_at      timestamptz not null default now(),
  constraint panel_device_invites_kind_shape check (
    (kind = 'email' and target_user_id is not null and token is null) or
    (kind = 'link'  and token is not null and target_user_id is null)
  )
);

create index if not exists panel_device_invites_device_id_idx on public.panel_device_invites(device_id);
create index if not exists panel_device_invites_target_idx on public.panel_device_invites(target_user_id);

alter table public.panel_device_members enable row level security;
alter table public.panel_device_invites enable row level security;

-- ------------------------------------------------------------
-- Funções auxiliares — auth.users não é acessível via REST, então o Worker
-- as chama por RPC. Só service_role pode executar (revoke abaixo): senão
-- qualquer usuário logado poderia descobrir e-mails alheios pela API.
-- ------------------------------------------------------------

-- Convite por e-mail: acha a conta pelo e-mail (null se não existir).
create or replace function public.panel_find_user_by_email(p_email text)
returns uuid
language sql
security definer
set search_path = public, auth
stable
as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1
$$;

-- Nome/e-mail para mostrar na lista de membros e no eco do console.
create or replace function public.panel_user_info(p_ids uuid[])
returns table (id uuid, email text, name text)
language sql
security definer
set search_path = public, auth
stable
as $$
  select
    u.id,
    u.email::text,
    coalesce(
      nullif(u.raw_user_meta_data->>'full_name', ''),
      nullif(u.raw_user_meta_data->>'name', ''),
      nullif(u.raw_user_meta_data->>'user_name', '')
    )::text
  from auth.users u
  where u.id = any(p_ids)
$$;

revoke all on function public.panel_find_user_by_email(text) from public, anon, authenticated;
revoke all on function public.panel_user_info(uuid[]) from public, anon, authenticated;
grant execute on function public.panel_find_user_by_email(text) to service_role;
grant execute on function public.panel_user_info(uuid[]) to service_role;
