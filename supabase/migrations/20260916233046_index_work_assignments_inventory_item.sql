create index if not exists work_assignments_inventory_item_idx
  on public.work_assignments(inventory_item_id)
  where inventory_item_id is not null;
