-- ============================================================
-- Painel Web Remoto (Cubicase Plus) — tabela de dispositivos pareados
-- ============================================================
-- Rodar no SQL editor do projeto Supabase (rtfxcyvymlxebvemgwaj), mesmo
-- processo de scripts/supabase-subscriptions.sql (não existe CLI/migrations
-- neste repo). Seguro rodar mais de uma vez (create/drop ... if exists em
-- tudo) — útil tanto pra criar do zero quanto pra reaplicar a correção do
-- default de device_token abaixo numa tabela que já existia.
--
-- `id`           — identificador público do dispositivo (não-secreto): é o
--                  que o Durable Object usa como nome do canal
--                  (env.HOST_CHANNEL.idFromName(id)) e o que o painel web
--                  lista para o usuário escolher qual computador acessar.
-- `device_token` — credencial secreta gerada nesta tabela, nunca exposta ao
--                  navegador. Só o app desktop a lê (grava localmente em
--                  panel_device.json, ver src/lib/panelDevice.ts) para se
--                  autenticar como "agent" no WebSocket do Worker
--                  (api/src/durable-objects/host-channel.ts). Gerado
--                  concatenando dois gen_random_uuid() (nativo do Postgres
--                  13+, sem precisar de extensão nenhuma) — a primeira
--                  versão deste script usava pgcrypto (gen_random_bytes),
--                  que depende do search_path enxergar o schema onde a
--                  extensão foi instalada; se o INSERT do app estava
--                  falhando com "function gen_random_bytes does not exist",
--                  era isso.
--
-- Igual a `subscriptions`: o app grava/lê com a própria sessão do usuário
-- (RLS abaixo restringe à própria linha); só o Worker LÊ com
-- SUPABASE_SERVICE_ROLE_KEY para validar device_token/ownership durante o
-- handshake do WebSocket (bypassa RLS de propósito, é ele quem decide se uma
-- credencial que não é sessão de ninguém é válida).
-- ============================================================

create table if not exists public.panel_devices (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  device_token   text not null unique default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  device_name    text not null default 'Meu computador',
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz
);

-- Reaplica o default correto mesmo se a tabela já existia com a versão
-- antiga (baseada em pgcrypto) — não afeta linhas já gravadas, só o que
-- for inserido dali pra frente.
alter table public.panel_devices
  alter column device_token set default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));

create index if not exists panel_devices_user_id_idx on public.panel_devices(user_id);

alter table public.panel_devices enable row level security;

-- O próprio app desktop cria/lista/apaga o registro do dispositivo dele, com
-- a sessão do usuário logado (mesmo padrão de leitura de `subscriptions`).
-- Sem policy de UPDATE: device_token nunca deve ser trocado depois de criado
-- (se vazar, a correção é apagar a linha e criar um dispositivo novo, não
-- regenerar o token da mesma linha) — com RLS ligado e nenhuma policy de
-- update, essa ação já fica negada por padrão.
drop policy if exists "select_own_devices" on public.panel_devices;
create policy "select_own_devices"
  on public.panel_devices for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "insert_own_device" on public.panel_devices;
create policy "insert_own_device"
  on public.panel_devices for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "delete_own_device" on public.panel_devices;
create policy "delete_own_device"
  on public.panel_devices for delete to authenticated
  using (auth.uid() = user_id);
