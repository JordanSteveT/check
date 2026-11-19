-- =============================================================================
-- Check — Schéma Supabase
-- Fichier : supabase/migrations/0001_init.sql
-- Version 1.0 — 19/11/2026
--
-- Implémente la spécification « specification_comptes_et_jetons.md ».
-- Règles :
--   * RLS activé sur toutes les tables ; le navigateur ne fait que LIRE ses lignes.
--   * Toute écriture passe par une fonction SECURITY DEFINER.
--   * Fonctions appelables par le navigateur (rôle authenticated) :
--       sync_account, claim_daily_bonus
--   * Fonctions réservées au serveur Cloudflare (rôle service_role, clé secrète) :
--       check_can_join, start_game, settle_game, refund_game,
--       expire_guest, prepare_account_deletion, touch_user
--   * Les fonctions internes sont dans le schéma « private », non exposé par l'API.
-- =============================================================================

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 1. Types
-- -----------------------------------------------------------------------------
create type public.account_type   as enum ('GOOGLE', 'EMAIL', 'GUEST');
create type public.account_status as enum ('PENDING_VERIFICATION', 'ACTIVE', 'EXPIRED');
create type public.bonus_status   as enum ('PENDING', 'GRANTED', 'DENIED');
create type public.game_status    as enum ('PLAYING', 'FINISHED', 'DRAW', 'ABORTED');
create type public.ledger_type    as enum (
  'WELCOME_BONUS', 'GUEST_BONUS', 'GUEST_CONVERSION_BONUS', 'DAILY_BONUS',
  'ENTRY_FEE', 'POT_PAYOUT', 'HOUSE_COMMISSION', 'REFUND',
  'GUEST_EXPIRY', 'ACCOUNT_DELETION', 'ADMIN_ADJUSTMENT', 'AD_REWARD'
);

-- -----------------------------------------------------------------------------
-- 2. Configuration (valeurs de la spécification §12)
-- -----------------------------------------------------------------------------
create table public.app_config (
  key   text primary key,
  value jsonb not null
);

insert into public.app_config (key, value) values
  ('economy.welcome_bonus',               '5000'),
  ('economy.guest_bonus',                 '1000'),
  ('economy.guest_conversion_bonus',      '4000'),
  ('economy.daily_bonus',                 '400'),
  ('economy.daily_bonus_timezone',        '"Africa/Douala"'),
  ('economy.house_commission_percent',    '10'),
  ('fees.min',                            '200'),
  ('fees.max',                            '10000'),
  ('fees.step',                           '100'),
  ('fees.default',                        '200'),
  ('games.abort_after_hours',             '2'),
  ('guest.disconnect_grace_minutes',      '5'),
  ('guest.max_per_device_per_day',        '3'),
  ('antiabuse.max_welcome_bonus_per_device', '2');

create or replace function private.cfg_int(p_key text) returns bigint
language plpgsql stable security definer set search_path = '' as $$
declare v bigint;
begin
  select (value #>> '{}')::bigint into v from public.app_config where key = p_key;
  if v is null then raise exception 'CONFIG_MISSING:%', p_key; end if;
  return v;
end $$;

create or replace function private.cfg_text(p_key text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  select value #>> '{}' into v from public.app_config where key = p_key;
  if v is null then raise exception 'CONFIG_MISSING:%', p_key; end if;
  return v;
end $$;

-- -----------------------------------------------------------------------------
-- 3. Tables
-- -----------------------------------------------------------------------------
create table public.profiles (
  id                    uuid primary key references auth.users (id) on delete cascade,
  account_type          public.account_type   not null,
  status                public.account_status not null,
  pseudo                text not null,
  device_id             text,
  welcome_bonus_status  public.bonus_status not null default 'PENDING',
  guest_bonus_granted   boolean not null default false,
  converted_at          timestamptz,
  created_at            timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  constraint pseudo_format check (pseudo ~ '^[A-Za-z0-9_]{3,16}$')
);
create unique index profiles_pseudo_unique on public.profiles (lower(pseudo))
  where status in ('ACTIVE', 'PENDING_VERIFICATION');
create index profiles_guest_last_seen on public.profiles (last_seen_at) where account_type = 'GUEST';

create table public.wallets (
  owner_id   text primary key,               -- uuid d'un joueur, ou SYSTEM:*, ou GAME:{uuid}
  is_system  boolean not null default false,
  balance    bigint  not null default 0,
  updated_at timestamptz not null default now(),
  constraint balance_non_negative check (is_system or balance >= 0)
);

create table public.ledger_entries (
  id              uuid primary key default gen_random_uuid(),
  wallet_id       text not null references public.wallets (owner_id),
  type            public.ledger_type not null,
  amount          bigint not null check (amount <> 0),
  balance_after   bigint not null,
  ref_type        text,
  ref_id          text,
  idempotency_key text not null,
  created_at      timestamptz not null default now()
);
create unique index ledger_idempotency on public.ledger_entries (idempotency_key, wallet_id);
create index ledger_wallet_created on public.ledger_entries (wallet_id, created_at desc);

create table public.games (
  id          uuid primary key,
  room_id     text not null,
  fee         bigint not null,
  options     jsonb not null,
  player_ids  uuid[] not null,
  status      public.game_status not null,
  winner_id   uuid,
  pot         bigint not null,
  commission  bigint,
  payout      bigint,
  end_reason  text,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);
create index games_playing on public.games (started_at) where status = 'PLAYING';
create index games_players on public.games using gin (player_ids);

-- Hash SHA-256 des identités ayant déjà reçu un bonus ou appartenu à un compte supprimé.
create table public.used_identities (
  identity_hash text primary key,
  created_at    timestamptz not null default now()
);

-- Bonus de bienvenue (ou de conversion) accordés par appareil.
create table public.device_bonus_grants (
  device_id  text not null,
  user_id    uuid not null,
  granted_at timestamptz not null default now(),
  primary key (device_id, user_id)
);

-- Comptes invités créés par appareil (limite par 24 h).
create table public.guest_creations (
  device_id  text not null,
  user_id    uuid not null,
  created_at timestamptz not null default now()
);
create index guest_creations_device on public.guest_creations (device_id, created_at);

-- Alertes techniques (lues par l'équipe, jamais par le navigateur).
create table public.ops_alerts (
  id         bigserial primary key,
  kind       text not null,
  details    jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Portefeuilles système
insert into public.wallets (owner_id, is_system) values
  ('SYSTEM:MINT', true), ('SYSTEM:HOUSE', true), ('SYSTEM:BURN', true);

-- -----------------------------------------------------------------------------
-- 4. Journal non modifiable
-- -----------------------------------------------------------------------------
create or replace function private.forbid_ledger_change() returns trigger
language plpgsql as $$
begin
  raise exception 'LEDGER_IS_APPEND_ONLY';
end $$;

create trigger ledger_no_update before update or delete on public.ledger_entries
  for each row execute function private.forbid_ledger_change();

-- -----------------------------------------------------------------------------
-- 5. Fonctions internes
-- -----------------------------------------------------------------------------
create or replace function private.ensure_wallet(p_owner text, p_system boolean default false)
returns void language sql security definer set search_path = '' as $$
  insert into public.wallets (owner_id, is_system) values (p_owner, p_system)
  on conflict (owner_id) do nothing;
$$;

-- Procédure unique de mouvement de jetons (spécification §5.2).
-- Renvoie true si l'opération a été faite, false si elle l'avait déjà été (idempotence).
-- Lève INSUFFICIENT_BALANCE si le solde d'un joueur deviendrait négatif.
create or replace function private.transfer(
  p_from text, p_to text, p_amount bigint, p_type public.ledger_type,
  p_ref_type text, p_ref_id text, p_key text
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_from_balance bigint;
  v_to_balance   bigint;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_key, 0));
  if exists (select 1 from public.ledger_entries where idempotency_key = p_key) then
    return false;
  end if;

  -- Verrouillage dans un ordre fixe pour éviter les interblocages
  perform 1 from public.wallets where owner_id in (p_from, p_to) order by owner_id for update;

  update public.wallets set balance = balance - p_amount, updated_at = now()
   where owner_id = p_from returning balance into v_from_balance;
  if not found then raise exception 'WALLET_NOT_FOUND:%', p_from; end if;

  update public.wallets set balance = balance + p_amount, updated_at = now()
   where owner_id = p_to returning balance into v_to_balance;
  if not found then raise exception 'WALLET_NOT_FOUND:%', p_to; end if;

  insert into public.ledger_entries (wallet_id, type, amount, balance_after, ref_type, ref_id, idempotency_key)
  values (p_from, p_type, -p_amount, v_from_balance, p_ref_type, p_ref_id, p_key),
         (p_to,   p_type,  p_amount, v_to_balance,   p_ref_type, p_ref_id, p_key);
  return true;
exception
  when check_violation then
    raise exception 'INSUFFICIENT_BALANCE';
end $$;

create or replace function private.balance_of(p_owner text) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce((select balance from public.wallets where owner_id = p_owner), 0);
$$;

-- Hash des identités d'un utilisateur (email et fournisseurs OAuth).
create or replace function private.identity_hashes(p_user_id uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(h), '{}') from (
    select encode(sha256(convert_to('email:' || lower(trim(u.email)), 'UTF8')), 'hex') as h
      from auth.users u
     where u.id = p_user_id and coalesce(u.email, '') <> ''
    union
    select encode(sha256(convert_to(i.provider || ':' || i.provider_id, 'UTF8')), 'hex')
      from auth.identities i
     where i.user_id = p_user_id and i.provider <> 'email'
  ) s;
$$;

create or replace function private.random_guest_pseudo() returns text
language plpgsql volatile security definer set search_path = '' as $$
declare v text;
begin
  for i in 1..50 loop
    v := 'Invite_' || lpad((floor(random() * 10000))::int::text, 4, '0');
    if not exists (select 1 from public.profiles
                    where lower(pseudo) = lower(v) and status in ('ACTIVE', 'PENDING_VERIFICATION')) then
      return v;
    end if;
  end loop;
  return 'Invite_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
end $$;

create or replace function private.next_daily_reset() returns timestamptz
language sql stable security definer set search_path = '' as $$
  select (date_trunc('day', now() at time zone private.cfg_text('economy.daily_bonus_timezone'))
          + interval '1 day') at time zone private.cfg_text('economy.daily_bonus_timezone');
$$;

create or replace function private.daily_key(p_user_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select 'daily:' || p_user_id::text || ':' ||
         to_char(now() at time zone private.cfg_text('economy.daily_bonus_timezone'), 'YYYY-MM-DD');
$$;

create or replace function private.account_json(p_user_id uuid, p_bonus text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.profiles%rowtype;
begin
  select * into p from public.profiles where id = p_user_id;
  return jsonb_build_object(
    'user_id',               p.id,
    'account_type',          p.account_type,
    'status',                p.status,
    'pseudo',                p.pseudo,
    'balance',               private.balance_of(p_user_id::text),
    'daily_bonus_available', p.account_type <> 'GUEST' and p.status = 'ACTIVE'
                             and not exists (select 1 from public.ledger_entries
                                              where idempotency_key = private.daily_key(p_user_id)),
    'next_daily_bonus_at',   private.next_daily_reset(),
    'bonus_granted',         p_bonus,
    'needs_pseudo',          false
  );
end $$;

-- -----------------------------------------------------------------------------
-- 6. Fonctions appelées par le navigateur (rôle authenticated)
-- -----------------------------------------------------------------------------

-- À appeler après chaque connexion, vérification d'email ou conversion d'invité.
-- Crée le profil et le portefeuille, met à jour le type et le statut,
-- attribue les bonus (spécification §4 et §9). Idempotente.
-- Erreurs : UNAUTHORIZED, GUEST_LIMIT_REACHED, INVALID_PSEUDO, PSEUDO_TAKEN
create or replace function public.sync_account(p_pseudo text default null, p_device_id text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid        uuid := auth.uid();
  v_user       auth.users%rowtype;
  v_profile    public.profiles%rowtype;
  v_type       public.account_type;
  v_confirmed  boolean;
  v_bonus      text := null;
  v_hashes     text[];
  v_amount     bigint;
  v_ltype      public.ledger_type;
begin
  if v_uid is null then raise exception 'UNAUTHORIZED'; end if;
  select * into v_user from auth.users where id = v_uid;
  if not found then raise exception 'UNAUTHORIZED'; end if;

  v_type := case
    when coalesce(v_user.is_anonymous, false) then 'GUEST'
    when exists (select 1 from auth.identities where user_id = v_uid and provider = 'google') then 'GOOGLE'
    else 'EMAIL' end;
  v_confirmed := v_type = 'GOOGLE' or v_user.email_confirmed_at is not null;

  if p_pseudo is not null and p_pseudo !~ '^[A-Za-z0-9_]{3,16}$' then
    raise exception 'INVALID_PSEUDO';
  end if;

  select * into v_profile from public.profiles where id = v_uid for update;

  begin
    if not found then
      -- ---------- Nouveau profil ----------
      if v_type = 'GUEST' then
        if p_device_id is not null and
           (select count(*) from public.guest_creations
             where device_id = p_device_id and created_at > now() - interval '24 hours')
           >= private.cfg_int('guest.max_per_device_per_day') then
          raise exception 'GUEST_LIMIT_REACHED';
        end if;
        insert into public.profiles (id, account_type, status, pseudo, device_id, guest_bonus_granted)
        values (v_uid, 'GUEST', 'ACTIVE', private.random_guest_pseudo(), p_device_id, true);
        if p_device_id is not null then
          insert into public.guest_creations (device_id, user_id) values (p_device_id, v_uid);
        end if;
        perform private.ensure_wallet(v_uid::text);
        perform private.transfer('SYSTEM:MINT', v_uid::text, private.cfg_int('economy.guest_bonus'),
                                 'GUEST_BONUS', null, null, 'guest:' || v_uid::text);
        v_bonus := 'GUEST_BONUS';
      else
        if p_pseudo is null then
          return jsonb_build_object('needs_pseudo', true, 'account_type', v_type);
        end if;
        insert into public.profiles (id, account_type, status, pseudo, device_id)
        values (v_uid, v_type,
                case when v_confirmed then 'ACTIVE'::public.account_status
                     else 'PENDING_VERIFICATION'::public.account_status end,
                p_pseudo, p_device_id);
        perform private.ensure_wallet(v_uid::text);
      end if;
    else
      -- ---------- Profil existant ----------
      if v_profile.account_type = 'GUEST' and v_type <> 'GUEST' then
        update public.profiles
           set account_type = v_type, converted_at = now(),
               pseudo = coalesce(p_pseudo, pseudo)
         where id = v_uid;
      elsif p_pseudo is not null and v_profile.pseudo <> p_pseudo and v_type <> 'GUEST' then
        update public.profiles set pseudo = p_pseudo where id = v_uid;
      end if;
      update public.profiles
         set status = case when v_type = 'GUEST' or v_confirmed then 'ACTIVE'::public.account_status
                           else 'PENDING_VERIFICATION'::public.account_status end,
             device_id = coalesce(p_device_id, device_id),
             last_seen_at = now()
       where id = v_uid;
    end if;
  exception
    when unique_violation then raise exception 'PSEUDO_TAKEN';
  end;

  -- ---------- Bonus de bienvenue / de conversion (spécification §9) ----------
  select * into v_profile from public.profiles where id = v_uid for update;
  if v_type <> 'GUEST' and v_confirmed and v_profile.welcome_bonus_status = 'PENDING' then
    v_hashes := private.identity_hashes(v_uid);
    if exists (select 1 from public.used_identities where identity_hash = any (v_hashes)) then
      update public.profiles set welcome_bonus_status = 'DENIED' where id = v_uid;
      v_bonus := 'DENIED_IDENTITY';
    elsif v_profile.device_id is not null and
          (select count(*) from public.device_bonus_grants where device_id = v_profile.device_id)
          >= private.cfg_int('antiabuse.max_welcome_bonus_per_device') then
      update public.profiles set welcome_bonus_status = 'DENIED' where id = v_uid;
      v_bonus := 'DENIED_DEVICE';
    else
      if v_profile.guest_bonus_granted then
        v_amount := private.cfg_int('economy.guest_conversion_bonus');
        v_ltype  := 'GUEST_CONVERSION_BONUS';
      else
        v_amount := private.cfg_int('economy.welcome_bonus');
        v_ltype  := 'WELCOME_BONUS';
      end if;
      perform private.transfer('SYSTEM:MINT', v_uid::text, v_amount, v_ltype, null, null,
                               'welcome:' || v_uid::text);
      update public.profiles set welcome_bonus_status = 'GRANTED' where id = v_uid;
      insert into public.used_identities (identity_hash)
        select unnest(v_hashes) on conflict do nothing;
      if v_profile.device_id is not null then
        insert into public.device_bonus_grants (device_id, user_id)
        values (v_profile.device_id, v_uid) on conflict do nothing;
      end if;
      v_bonus := v_ltype::text;
    end if;
  end if;

  return private.account_json(v_uid, v_bonus);
end $$;

-- Bonus quotidien (spécification §8).
-- Erreurs : UNAUTHORIZED, NOT_ELIGIBLE, DAILY_BONUS_ALREADY_CLAIMED
create or replace function public.claim_daily_bonus() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_p   public.profiles%rowtype;
  v_done boolean;
begin
  if v_uid is null then raise exception 'UNAUTHORIZED'; end if;
  select * into v_p from public.profiles where id = v_uid;
  if not found or v_p.account_type = 'GUEST' or v_p.status <> 'ACTIVE' then
    raise exception 'NOT_ELIGIBLE';
  end if;
  v_done := private.transfer('SYSTEM:MINT', v_uid::text, private.cfg_int('economy.daily_bonus'),
                             'DAILY_BONUS', null, null, private.daily_key(v_uid));
  if not v_done then raise exception 'DAILY_BONUS_ALREADY_CLAIMED'; end if;
  return jsonb_build_object(
    'amount',            private.cfg_int('economy.daily_bonus'),
    'balance',           private.balance_of(v_uid::text),
    'next_available_at', private.next_daily_reset());
end $$;

-- -----------------------------------------------------------------------------
-- 7. Fonctions réservées au serveur Cloudflare (rôle service_role)
-- -----------------------------------------------------------------------------

-- Vérifie qu'un joueur peut créer (p_is_creator) ou rejoindre un salon.
-- Erreurs : UNAUTHORIZED, EMAIL_NOT_VERIFIED, GUEST_NOT_ALLOWED, INVALID_FEE,
--           INSUFFICIENT_BALANCE:<manquant>
create or replace function public.check_can_join(
  p_user_id uuid, p_fee bigint, p_room_type text, p_is_creator boolean default false
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_p public.profiles%rowtype;
  v_balance bigint;
begin
  select * into v_p from public.profiles where id = p_user_id;
  if not found or v_p.status = 'EXPIRED' then raise exception 'UNAUTHORIZED'; end if;
  if v_p.status = 'PENDING_VERIFICATION' then raise exception 'EMAIL_NOT_VERIFIED'; end if;
  if v_p.account_type = 'GUEST' and p_room_type <> 'PUBLIC' then raise exception 'GUEST_NOT_ALLOWED'; end if;
  if p_fee is null
     or p_fee < private.cfg_int('fees.min') or p_fee > private.cfg_int('fees.max')
     or p_fee % private.cfg_int('fees.step') <> 0 then
    raise exception 'INVALID_FEE';
  end if;
  v_balance := private.balance_of(p_user_id::text);
  if v_balance < p_fee then raise exception 'INSUFFICIENT_BALANCE:%', p_fee - v_balance; end if;
  return jsonb_build_object('ok', true, 'pseudo', v_p.pseudo, 'account_type', v_p.account_type,
                            'balance', v_balance);
end $$;

-- Débite les frais au lancement (spécification §6.3). Idempotente par p_game_id.
-- Renvoie { started, debited[], failed[], pot }.
create or replace function public.start_game(
  p_game_id uuid, p_room_id text, p_fee bigint, p_player_ids uuid[], p_options jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_game_wallet text := 'GAME:' || p_game_id::text;
  v_debited uuid[] := '{}';
  v_failed  uuid[] := '{}';
  v_uid uuid;
  v_existing public.games%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('game:' || p_game_id::text, 0));
  select * into v_existing from public.games where id = p_game_id;
  if found then
    return jsonb_build_object('started', v_existing.status <> 'ABORTED',
                              'debited', to_jsonb(v_existing.player_ids), 'failed', '[]'::jsonb,
                              'pot', v_existing.pot);
  end if;

  perform private.ensure_wallet(v_game_wallet, true);
  foreach v_uid in array p_player_ids loop
    begin
      perform private.transfer(v_uid::text, v_game_wallet, p_fee, 'ENTRY_FEE', 'GAME',
                               p_game_id::text, 'fee:' || p_game_id::text || ':' || v_uid::text);
      v_debited := v_debited || v_uid;
    exception when others then
      if sqlerrm like 'INSUFFICIENT_BALANCE%' or sqlerrm like 'WALLET_NOT_FOUND%' then
        v_failed := v_failed || v_uid;
      else
        raise;
      end if;
    end;
  end loop;

  if coalesce(array_length(v_debited, 1), 0) < 2 then
    foreach v_uid in array v_debited loop
      perform private.transfer(v_game_wallet, v_uid::text, p_fee, 'REFUND', 'GAME',
                               p_game_id::text, 'refund:' || p_game_id::text || ':' || v_uid::text);
    end loop;
    insert into public.games (id, room_id, fee, options, player_ids, status, pot, end_reason, ended_at)
    values (p_game_id, p_room_id, p_fee, p_options, v_debited, 'ABORTED', 0, 'NOT_ENOUGH_PLAYERS', now());
    return jsonb_build_object('started', false, 'debited', '[]'::jsonb,
                              'failed', to_jsonb(v_failed), 'pot', 0);
  end if;

  insert into public.games (id, room_id, fee, options, player_ids, status, pot)
  values (p_game_id, p_room_id, p_fee, p_options, v_debited, 'PLAYING',
          p_fee * array_length(v_debited, 1));
  return jsonb_build_object('started', true, 'debited', to_jsonb(v_debited),
                            'failed', to_jsonb(v_failed), 'pot', p_fee * array_length(v_debited, 1));
end $$;

-- Verse la cagnotte au gagnant moins la commission (spécification §6.4). Idempotente.
-- Erreurs : GAME_NOT_FOUND, GAME_NOT_PLAYING, WINNER_NOT_IN_GAME, GAME_WALLET_NOT_EMPTY
create or replace function public.settle_game(p_game_id uuid, p_winner_id uuid, p_reason text default 'EMPTY_HAND')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_g public.games%rowtype;
  v_wallet text := 'GAME:' || p_game_id::text;
  v_pot bigint; v_commission bigint; v_payout bigint;
begin
  select * into v_g from public.games where id = p_game_id for update;
  if not found then raise exception 'GAME_NOT_FOUND'; end if;
  if v_g.status = 'FINISHED' then
    return jsonb_build_object('pot', v_g.pot, 'commission', v_g.commission,
                              'payout', v_g.payout, 'winner_id', v_g.winner_id);
  end if;
  if v_g.status <> 'PLAYING' then raise exception 'GAME_NOT_PLAYING'; end if;
  if not (p_winner_id = any (v_g.player_ids)) then raise exception 'WINNER_NOT_IN_GAME'; end if;

  v_pot := private.balance_of(v_wallet);
  v_commission := floor(v_pot * private.cfg_int('economy.house_commission_percent') / 100.0);
  v_payout := v_pot - v_commission;

  if v_payout > 0 then
    perform private.transfer(v_wallet, p_winner_id::text, v_payout, 'POT_PAYOUT', 'GAME',
                             p_game_id::text, 'payout:' || p_game_id::text);
  end if;
  if v_commission > 0 then
    perform private.transfer(v_wallet, 'SYSTEM:HOUSE', v_commission, 'HOUSE_COMMISSION', 'GAME',
                             p_game_id::text, 'commission:' || p_game_id::text);
  end if;
  if private.balance_of(v_wallet) <> 0 then raise exception 'GAME_WALLET_NOT_EMPTY'; end if;

  update public.games
     set status = 'FINISHED', winner_id = p_winner_id, commission = v_commission,
         payout = v_payout, end_reason = p_reason, ended_at = now()
   where id = p_game_id;
  return jsonb_build_object('pot', v_pot, 'commission', v_commission,
                            'payout', v_payout, 'winner_id', p_winner_id);
end $$;

-- Rembourse tous les joueurs débités (partie nulle ou annulée, spécification §7). Idempotente.
-- p_reason : 'BLOCKED' (nulle) ou 'TECHNICAL' (annulée).
create or replace function public.refund_game(p_game_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_g public.games%rowtype;
  v_wallet text := 'GAME:' || p_game_id::text;
  v_uid uuid;
begin
  select * into v_g from public.games where id = p_game_id for update;
  if not found then raise exception 'GAME_NOT_FOUND'; end if;
  if v_g.status in ('DRAW', 'ABORTED') then
    return jsonb_build_object('refunded', to_jsonb(v_g.player_ids), 'amount', v_g.fee);
  end if;
  if v_g.status <> 'PLAYING' then raise exception 'GAME_NOT_PLAYING'; end if;

  foreach v_uid in array v_g.player_ids loop
    perform private.ensure_wallet(v_uid::text);  -- au cas où le compte aurait été supprimé
    perform private.transfer(v_wallet, v_uid::text, v_g.fee, 'REFUND', 'GAME',
                             p_game_id::text, 'refund:' || p_game_id::text || ':' || v_uid::text);
  end loop;

  update public.games
     set status = case when p_reason = 'BLOCKED' then 'DRAW'::public.game_status
                       else 'ABORTED'::public.game_status end,
         end_reason = p_reason, ended_at = now()
   where id = p_game_id;
  return jsonb_build_object('refunded', to_jsonb(v_g.player_ids), 'amount', v_g.fee);
end $$;

-- Expire un invité (spécification §4.3). À suivre de la suppression de l'utilisateur
-- par l'API d'administration de Supabase. Idempotente.
create or replace function public.expire_guest(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_p public.profiles%rowtype;
  v_balance bigint;
begin
  select * into v_p from public.profiles where id = p_user_id for update;
  if not found then return jsonb_build_object('expired', true, 'burned', 0); end if;
  if v_p.account_type <> 'GUEST' then raise exception 'NOT_A_GUEST'; end if;
  v_balance := private.balance_of(p_user_id::text);
  if v_balance > 0 then
    perform private.transfer(p_user_id::text, 'SYSTEM:BURN', v_balance, 'GUEST_EXPIRY', null, null,
                             'expiry:' || p_user_id::text);
  end if;
  update public.profiles set status = 'EXPIRED' where id = p_user_id;
  return jsonb_build_object('expired', true, 'burned', v_balance);
end $$;

-- Prépare la suppression d'un compte (spécification §4.5). À suivre de la suppression
-- de l'utilisateur par l'API d'administration de Supabase.
create or replace function public.prepare_account_deletion(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_balance bigint;
begin
  v_balance := private.balance_of(p_user_id::text);
  if v_balance > 0 then
    perform private.transfer(p_user_id::text, 'SYSTEM:BURN', v_balance, 'ACCOUNT_DELETION', null, null,
                             'deletion:' || p_user_id::text);
  end if;
  insert into public.used_identities (identity_hash)
    select unnest(private.identity_hashes(p_user_id)) on conflict do nothing;
  return jsonb_build_object('burned', v_balance);
end $$;

-- Mise à jour de la dernière activité (appelée par le UserDO à la connexion et toutes les 30 min).
create or replace function public.touch_user(p_user_id uuid) returns void
language sql security definer set search_path = '' as $$
  update public.profiles set last_seen_at = now() where id = p_user_id;
$$;

-- -----------------------------------------------------------------------------
-- 8. Droits
-- -----------------------------------------------------------------------------
-- Par défaut, Supabase donne EXECUTE à anon et authenticated : on retire tout,
-- puis on accorde explicitement.
revoke execute on all functions in schema public  from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;

grant execute on function public.sync_account(text, text) to authenticated;
grant execute on function public.claim_daily_bonus()       to authenticated;

grant execute on function public.check_can_join(uuid, bigint, text, boolean)      to service_role;
grant execute on function public.start_game(uuid, text, bigint, uuid[], jsonb)    to service_role;
grant execute on function public.settle_game(uuid, uuid, text)                    to service_role;
grant execute on function public.refund_game(uuid, text)                          to service_role;
grant execute on function public.expire_guest(uuid)                               to service_role;
grant execute on function public.prepare_account_deletion(uuid)                   to service_role;
grant execute on function public.touch_user(uuid)                                 to service_role;

revoke insert, update, delete on all tables in schema public from anon, authenticated;
grant select on public.profiles, public.wallets, public.ledger_entries, public.games, public.app_config to authenticated;
grant select on public.app_config to anon;

-- -----------------------------------------------------------------------------
-- 9. Row Level Security (lecture de ses propres lignes uniquement)
-- -----------------------------------------------------------------------------
alter table public.app_config          enable row level security;
alter table public.profiles            enable row level security;
alter table public.wallets             enable row level security;
alter table public.ledger_entries      enable row level security;
alter table public.games               enable row level security;
alter table public.used_identities     enable row level security;
alter table public.device_bonus_grants enable row level security;
alter table public.guest_creations     enable row level security;
alter table public.ops_alerts          enable row level security;

create policy "config lisible par tous" on public.app_config
  for select to anon, authenticated using (true);
create policy "profil : lecture de soi" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "portefeuille : lecture de soi" on public.wallets
  for select to authenticated using (owner_id = (select auth.uid())::text);
create policy "journal : lecture de soi" on public.ledger_entries
  for select to authenticated using (wallet_id = (select auth.uid())::text);
create policy "parties : lecture des siennes" on public.games
  for select to authenticated using ((select auth.uid()) = any (player_ids));
-- used_identities, device_bonus_grants, guest_creations, ops_alerts : aucune politique = aucun accès client.

-- -----------------------------------------------------------------------------
-- 10. Realtime : le navigateur suit son propre solde
-- -----------------------------------------------------------------------------
alter publication supabase_realtime add table public.wallets;

-- =============================================================================
-- Fichier : supabase/migrations/0002_cron.sql
-- Prérequis : activer l'extension pg_cron (Database → Extensions).
-- =============================================================================

-- Filet de sécurité : invités inactifs depuis 24 h (spécification §4.3).
create or replace function private.cron_expire_stale_guests() returns void
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select id from public.profiles
            where account_type = 'GUEST' and last_seen_at < now() - interval '24 hours'
            limit 500 loop
    perform public.expire_guest(r.id);
    delete from auth.users where id = r.id;
  end loop;
end $$;

-- Utilisateurs anonymes créés sans profil (sync_account jamais appelé ou refusé).
create or replace function private.cron_delete_orphan_anonymous() returns void
language sql security definer set search_path = '' as $$
  delete from auth.users u
   where u.is_anonymous
     and u.created_at < now() - interval '1 hour'
     and not exists (select 1 from public.profiles p where p.id = u.id);
$$;

-- Parties bloquées (le RoomDO aurait dû rembourser après 2 h).
create or replace function private.cron_refund_stuck_games() returns void
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select id from public.games
            where status = 'PLAYING' and started_at < now() - interval '3 hours' loop
    perform public.refund_game(r.id, 'TECHNICAL');
    insert into public.ops_alerts (kind, details) values ('STUCK_GAME_REFUNDED', jsonb_build_object('game_id', r.id));
  end loop;
end $$;

-- Contrôle de conservation des jetons (cas de test T28).
create or replace function private.cron_check_conservation() returns void
language plpgsql security definer set search_path = '' as $$
declare v_sum numeric;
begin
  select sum(balance) into v_sum from public.wallets;
  if v_sum <> 0 then
    insert into public.ops_alerts (kind, details) values ('CONSERVATION_BROKEN', jsonb_build_object('sum', v_sum));
  end if;
end $$;

revoke execute on all functions in schema private from public, anon, authenticated;

select cron.schedule('expire-stale-guests',     '7 * * * *',    'select private.cron_expire_stale_guests()');
select cron.schedule('delete-orphan-anonymous', '17 * * * *',   'select private.cron_delete_orphan_anonymous()');
select cron.schedule('refund-stuck-games',      '*/15 * * * *', 'select private.cron_refund_stuck_games()');
select cron.schedule('check-conservation',      '23 3 * * *',   'select private.cron_check_conservation()');
