CREATE UNIQUE INDEX IF NOT EXISTS unique_active_auto_task
ON tasks ("driverId", source, "dedupeKey")
WHERE "isActive" = true AND source = 'auto';
