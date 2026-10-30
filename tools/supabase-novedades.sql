-- Binder: apuntados a las novedades desde la portada.
-- Ejecutar una vez en Supabase → SQL Editor → New query → Run.
-- Cualquiera puede apuntarse, pero nadie puede leer la lista desde la web:
-- solo se ve en Supabase → Table Editor → novedades.

create table if not exists public.novedades (
  id bigint generated always as identity primary key,
  email text not null check (char_length(email) between 3 and 254),
  juego text check (char_length(juego) <= 200),
  perfil text check (char_length(perfil) <= 200),
  created_at timestamptz not null default now()
);

alter table public.novedades enable row level security;

drop policy if exists "apuntarse" on public.novedades;
create policy "apuntarse" on public.novedades
  for insert to anon, authenticated with check (true);

grant insert on public.novedades to anon, authenticated;
