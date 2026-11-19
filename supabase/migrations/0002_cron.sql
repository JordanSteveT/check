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
