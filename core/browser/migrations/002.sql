CREATE INDEX idx_tamoss_unfinished_cleanup
ON tamoss_object_cleanups(delete_request_id, claim_expires_at NULLS FIRST) WHERE status <> 'done';
