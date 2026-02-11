-- GeoPuzzle Walks: minimal schema + RLS

-- Enable extensions
create extension if not exists "pgcrypto";

-- Routes created by admin
create table if not exists public.routes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  center_lat double precision not null,
  center_lng double precision not null,
  radius_m integer not null default 800,
  puzzle_image_url text,
  grid_cols integer not null default 3,
  grid_rows integer not null default 3,
  created_by text not null,
  created_at timestamp with time zone not null default now()
);

-- If you already created the table, add new columns:
-- alter table public.routes add column if not exists puzzle_image_url text;
-- alter table public.routes add column if not exists grid_cols integer not null default 3;
-- alter table public.routes add column if not exists grid_rows integer not null default 3;

-- Pieces placed along a route
create table if not exists public.pieces (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  piece_order integer not null,
  image_fragment_url text,
  created_at timestamp with time zone not null default now()
);

create index if not exists pieces_route_id_idx on public.pieces(route_id);

-- Progress per device
create table if not exists public.progress (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete cascade,
  device_id text not null,
  collected_piece_ids uuid[] not null default '{}',
  completed_at timestamp with time zone,
  updated_at timestamp with time zone not null default now()
);

create unique index if not exists progress_route_device_uidx
  on public.progress(route_id, device_id);

-- RLS
alter table public.routes enable row level security;
alter table public.pieces enable row level security;
alter table public.progress enable row level security;

-- Public read-only access (safe: no precise location history)
create policy "routes_read" on public.routes
  for select using (true);

create policy "pieces_read" on public.pieces
  for select using (true);

create policy "progress_read" on public.progress
  for select using (true);

-- Admin write access: any authenticated user (swap to email/role check later)
create policy "routes_write_admin" on public.routes
  for insert with check (auth.role() = 'authenticated');

create policy "routes_update_admin" on public.routes
  for update using (auth.role() = 'authenticated');

create policy "routes_delete_admin" on public.routes
  for delete using (auth.role() = 'authenticated');

create policy "pieces_write_admin" on public.pieces
  for insert with check (auth.role() = 'authenticated');

create policy "pieces_update_admin" on public.pieces
  for update using (auth.role() = 'authenticated');

create policy "pieces_delete_admin" on public.pieces
  for delete using (auth.role() = 'authenticated');

-- Progress updates allowed (public) with minimal data (device_id + piece ids)
create policy "progress_write" on public.progress
  for insert with check (true);

create policy "progress_update" on public.progress
  for update using (true);
