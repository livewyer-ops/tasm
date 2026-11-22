-- Preserve the minimum retention promised to allocations made by older versions.
UPDATE tamoss_media_objects SET access_expires_at=unixepoch(created_at)+86400
WHERE access_expires_at < unixepoch(created_at)+86400;

CREATE UNIQUE INDEX wasm_media_allocation ON tamoss_media_objects(allocation_id);
DROP TRIGGER wasm_cleanup_insert;
CREATE TRIGGER wasm_cleanup_insert AFTER INSERT ON tamoss_object_cleanups
BEGIN
    UPDATE tamoss_object_cleanups SET record=json_set(record,
        '$.allocation_id',(SELECT allocation_id FROM tamoss_media_objects WHERE id=NEW.object_id),
        '$.not_before',(SELECT access_expires_at FROM tamoss_media_objects WHERE id=NEW.object_id))
    WHERE id=NEW.id;
END;
