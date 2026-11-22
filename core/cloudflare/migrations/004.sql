-- The alarm checks the oldest terminal row in each queue on every request.
CREATE INDEX IF NOT EXISTS idx_tamoss_delete_requests_retention
ON tamoss_delete_requests(status,updated_at) WHERE status='done';
CREATE INDEX IF NOT EXISTS idx_tamoss_object_copies_retention
ON tamoss_object_copies(status,updated_at) WHERE status='done';
CREATE INDEX IF NOT EXISTS idx_tamoss_object_cleanups_retention
ON tamoss_object_cleanups(status,updated_at) WHERE status='done';
CREATE INDEX IF NOT EXISTS idx_tamoss_webhook_deliveries_retention
ON tamoss_webhook_deliveries(status,updated_at) WHERE status IN ('done','dead');
