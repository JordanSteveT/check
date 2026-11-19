-- =============================================================================
-- Check — Scénarios de test du schéma Supabase (tests_schema_supabase.sql)
-- Version 1.0 — 19/11/2026
--
-- Usage hors Supabase (PostgreSQL 15+ vierge) :
--   1. exécuter la partie « BOUCHONS » ci-dessous (simule auth.users, auth.uid(), rôles) ;
--   2. exécuter schema_supabase.sql ;
--   3. exécuter la partie « SCÉNARIOS » et comparer avec les lignes « Attendu ».
-- Avec Supabase local (supabase start) : sauter les bouchons et créer les utilisateurs
-- de test via l'API d'administration, puis adapter les identifiants.
-- Ces scénarios ont été exécutés avec succès sur PostgreSQL 16 le 19/11/2026.
-- =============================================================================

-- ------------------------------ BOUCHONS -------------------------------------
do $$ begin if not exists (select 1 from pg_roles where rolname=$q$anon$q$) then create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; end if; end $$;
create schema auth;
create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, is_anonymous boolean default false, created_at timestamptz default now());
create table auth.identities (user_id uuid references auth.users(id) on delete cascade, provider text, provider_id text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
create publication supabase_realtime;
create schema cron; create function cron.schedule(a text, b text, c text) returns bigint language sql as $$ select 1::bigint $$;

-- ------------------------------ SCÉNARIOS ------------------------------------
\set ON_ERROR_STOP 0
-- Utilisateurs
insert into auth.users(id,email,email_confirmed_at,is_anonymous) values
 ('11111111-1111-1111-1111-111111111111','jordan@gmail.com',now(),false),   -- Google
 ('22222222-2222-2222-2222-222222222222','ami@mail.cm',null,false),          -- Email non confirmé
 ('33333333-3333-3333-3333-333333333333',null,null,true),                    -- Invité
 ('44444444-4444-4444-4444-444444444444','trois@mail.cm',now(),false);       -- Email confirmé, même appareil
insert into auth.identities values ('11111111-1111-1111-1111-111111111111','google','g-sub-1'),
 ('22222222-2222-2222-2222-222222222222','email','ami@mail.cm'),('44444444-4444-4444-4444-444444444444','email','trois@mail.cm');

select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false);
-- Attendu : {"needs_pseudo": true, "account_type": "GOOGLE"}
select 'T1a google sans pseudo' t, public.sync_account(null,'dev1');
-- Attendu : WELCOME_BONUS, solde 5000
select 'T1b google avec pseudo' t, public.sync_account('Jordan','dev1')->>'bonus_granted' bonus, public.sync_account('Jordan','dev1')->>'balance' bal;

select set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',false);
-- Attendu : PENDING_VERIFICATION
select 'T2 email non confirmé' t, (public.sync_account('Ami_237','dev1'))->>'status' st;
update auth.users set email_confirmed_at=now() where id='22222222-2222-2222-2222-222222222222';
-- Attendu : WELCOME_BONUS
select 'T3 après confirmation' t, (public.sync_account(null,'dev1'))->>'bonus_granted' bonus;
-- Attendu : 5000 (pas de second bonus)
select 'T3b re-sync' t, (public.sync_account(null,'dev1'))->>'balance' bal;

select set_config('request.jwt.claim.sub','44444444-4444-4444-4444-444444444444',false);
-- Attendu : DENIED_DEVICE
select 'T11 3e compte même appareil' t, (public.sync_account('Trois','dev1'))->>'bonus_granted' bonus;

select set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333',false);
select 'T4 invité' t, public.sync_account(null,'dev2')->>'pseudo' pseudo, private.balance_of('33333333-3333-3333-3333-333333333333') bal;
select 'pseudo pris' t; select public.sync_account('jordan','dev2');
-- Attendu : erreur NOT_ELIGIBLE
select 'invité bonus du jour' t; select public.claim_daily_bonus();

select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false);
-- Attendu : 5400
select 'T13 bonus du jour' t, public.claim_daily_bonus()->>'balance' bal;
-- Attendu : erreur DAILY_BONUS_ALREADY_CLAIMED
select 'T14 deuxième fois' t; select public.claim_daily_bonus();

-- check_can_join
select 'join ok' t, public.check_can_join('11111111-1111-1111-1111-111111111111',200,'PRIVATE',true)->>'ok';
-- Attendu : erreur GUEST_NOT_ALLOWED
select 'invité privé' t; select public.check_can_join('33333333-3333-3333-3333-333333333333',200,'PRIVATE',false);
-- Attendu : erreur INVALID_FEE
select 'frais 150' t; select public.check_can_join('11111111-1111-1111-1111-111111111111',150,'PUBLIC',false);
-- Attendu : erreur INVALID_FEE
select 'frais 100' t; select public.check_can_join('11111111-1111-1111-1111-111111111111',100,'PUBLIC',false);
-- Attendu : erreur INSUFFICIENT_BALANCE:200
select 'solde insuffisant' t; select public.check_can_join('44444444-4444-4444-4444-444444444444',200,'PUBLIC',false);

-- Partie à 3 joueurs (le 4444 n'a rien) frais 200
-- Attendu : started true, pot 600, failed = [4444…]
select 'start' t, public.start_game('aaaaaaaa-0000-0000-0000-000000000001','room1',200,
  array['11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444']::uuid[],'{}');
select 'start idempotent' t, public.start_game('aaaaaaaa-0000-0000-0000-000000000001','room1',200,array['11111111-1111-1111-1111-111111111111']::uuid[],'{}');
-- Attendu : pot 600, commission 60, payout 540
select 'settle' t, public.settle_game('aaaaaaaa-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222');
select 'settle idempotent' t, public.settle_game('aaaaaaaa-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222');
select owner_id, balance from public.wallets order by owner_id;

-- Partie remboursée
select 'start2' t, public.start_game('aaaaaaaa-0000-0000-0000-000000000002','room2',500,
  array['11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222']::uuid[],'{}')->>'pot' pot;
-- Attendu : remboursement de 500 à chacun
select 'refund' t, public.refund_game('aaaaaaaa-0000-0000-0000-000000000002','BLOCKED');
select 'refund idempotent' t, public.refund_game('aaaaaaaa-0000-0000-0000-000000000002','BLOCKED');
-- Partie avec 1 seul joueur solvable
-- Attendu : started false (un seul joueur solvable), aucun débit conservé
select 'start3 <2' t, public.start_game('aaaaaaaa-0000-0000-0000-000000000003','room3',200,
  array['11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444']::uuid[],'{}');

-- Conversion de l'invité vers Google
update auth.users set is_anonymous=false, email='guest.conv@gmail.com' where id='33333333-3333-3333-3333-333333333333';
insert into auth.identities values ('33333333-3333-3333-3333-333333333333','google','g-sub-3');
select set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333',false);
-- Attendu : GUEST_CONVERSION_BONUS ; vérifier ensuite : type GOOGLE, solde 4800
select 'T9 conversion' t, public.sync_account(null,'dev2')->>'bonus_granted' bonus, private.balance_of('33333333-3333-3333-3333-333333333333') bal,
       (select account_type from public.profiles where id='33333333-3333-3333-3333-333333333333') typ;

-- Expiration d'un nouvel invité
insert into auth.users(id,is_anonymous) values ('55555555-5555-5555-5555-555555555555',true);
select set_config('request.jwt.claim.sub','55555555-5555-5555-5555-555555555555',false);
select public.sync_account(null,'dev3')->>'balance';
select 'expire' t, public.expire_guest('55555555-5555-5555-5555-555555555555');
delete from auth.users where id='55555555-5555-5555-5555-555555555555';

-- Suppression de compte puis réinscription Google
select 'delete' t, public.prepare_account_deletion('11111111-1111-1111-1111-111111111111');
delete from auth.users where id='11111111-1111-1111-1111-111111111111';
insert into auth.users(id,email,email_confirmed_at) values ('66666666-6666-6666-6666-666666666666','jordan@gmail.com',now());
insert into auth.identities values ('66666666-6666-6666-6666-666666666666','google','g-sub-1');
select set_config('request.jwt.claim.sub','66666666-6666-6666-6666-666666666666',false);
-- Attendu : DENIED_IDENTITY
select 'T27 réinscription' t, public.sync_account('Jordan2','dev9')->>'bonus_granted' bonus;

-- Journal non modifiable
-- Attendu : erreur LEDGER_IS_APPEND_ONLY
select 'ledger update' t; update public.ledger_entries set amount=1;
-- Conservation
-- Attendu : 0
select 'T28 somme' t, sum(balance) from public.wallets;
-- Droits : rôle authenticated
set role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',false);
select 'rls wallets' t, count(*) from public.wallets;
select 'rls ledger' t, count(*) from public.ledger_entries;
-- Attendu : permission denied
select 'start interdit' t; select public.start_game('aaaaaaaa-0000-0000-0000-000000000009','x',200,'{}'::uuid[],'{}');
-- Attendu : permission denied
select 'transfer interdit' t; select private.transfer('SYSTEM:MINT','22222222-2222-2222-2222-222222222222',1000,'ADMIN_ADJUSTMENT',null,null,'hack');
-- Attendu : permission denied
select 'insert interdit' t; insert into public.wallets(owner_id,balance) values('x',1);
select 'sync autorisé' t, public.sync_account(null,null)->>'balance';
reset role;
