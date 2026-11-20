-- Adapted from TASM core/rust/migrations/001.sql (Apache-2.0); see NOTICE.
-- Fixed-width biased TEXT bounds preserve signed nanosecond ordering.

CREATE TABLE IF NOT EXISTS tamoss_service_metadata (
    id TEXT PRIMARY KEY,
    name TEXT,
    description TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')
);

CREATE TABLE IF NOT EXISTS tamoss_storage_backends (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    provider TEXT NOT NULL,
    region TEXT NOT NULL,
    store_product TEXT NOT NULL,
    store_type TEXT NOT NULL DEFAULT 'http_object_store',
    default_storage INTEGER NOT NULL DEFAULT FALSE,
    bucket_name TEXT,
    endpoint_url TEXT,
    public_endpoint_url TEXT,
    tags TEXT NOT NULL DEFAULT '{}',
    record TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tamoss_storage_backends_one_default
ON tamoss_storage_backends(default_storage)
WHERE default_storage IS TRUE;

CREATE INDEX IF NOT EXISTS idx_tamoss_storage_backends_label
ON tamoss_storage_backends(label, id);

CREATE TABLE IF NOT EXISTS tamoss_profiles (
    id TEXT PRIMARY KEY,
    format TEXT NOT NULL,
    codec TEXT,
    label TEXT,
    tags TEXT NOT NULL DEFAULT '{}',
    record TEXT NOT NULL,
    created TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')
);

CREATE INDEX IF NOT EXISTS idx_tamoss_profiles_format_id
ON tamoss_profiles(format, id);
CREATE INDEX IF NOT EXISTS idx_tamoss_profiles_codec_id
ON tamoss_profiles(codec, id);
CREATE INDEX IF NOT EXISTS idx_tamoss_profiles_label_id
ON tamoss_profiles(label, id);

CREATE TABLE IF NOT EXISTS tamoss_sources (
    id TEXT PRIMARY KEY,
    format TEXT,
    label TEXT,
    tags TEXT NOT NULL DEFAULT '{}',
    record TEXT NOT NULL,
    metadata_updated TEXT NOT NULL,
    created TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')
);

CREATE INDEX IF NOT EXISTS idx_tamoss_sources_format ON tamoss_sources(format);

CREATE INDEX IF NOT EXISTS idx_tamoss_sources_created ON tamoss_sources(created, id);
CREATE INDEX IF NOT EXISTS idx_tamoss_sources_updated
ON tamoss_sources(metadata_updated, id);
CREATE INDEX IF NOT EXISTS idx_tamoss_sources_label ON tamoss_sources(label, id);

CREATE TABLE IF NOT EXISTS tamoss_flows (
    id TEXT PRIMARY KEY,
    source_id TEXT,
    format TEXT,
    container TEXT,
    profile_id TEXT,
    status TEXT,
    init_segments INTEGER NOT NULL DEFAULT FALSE,
    label TEXT,
    flow_collection_ids TEXT NOT NULL DEFAULT '[]',
    read_only INTEGER NOT NULL DEFAULT FALSE,
    tags TEXT NOT NULL DEFAULT '{}',
    record TEXT NOT NULL,
    metadata_updated TEXT NOT NULL,
    created TEXT NOT NULL,
    segments_updated TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')
);

CREATE INDEX IF NOT EXISTS idx_tamoss_flows_source_id ON tamoss_flows(source_id);
CREATE INDEX IF NOT EXISTS idx_tamoss_flows_format ON tamoss_flows(format);

CREATE INDEX IF NOT EXISTS idx_tamoss_flows_profile_id_id
ON tamoss_flows(profile_id, id);
CREATE INDEX IF NOT EXISTS idx_tamoss_flows_status_id
ON tamoss_flows(status, id);
CREATE INDEX IF NOT EXISTS idx_tamoss_flows_init_segments_id
ON tamoss_flows(init_segments, id);
CREATE INDEX IF NOT EXISTS idx_tamoss_flows_created ON tamoss_flows(created, id);
CREATE INDEX IF NOT EXISTS idx_tamoss_flows_metadata_updated
ON tamoss_flows(metadata_updated, id);
CREATE INDEX IF NOT EXISTS idx_tamoss_flows_label ON tamoss_flows(label, id);


CREATE TABLE IF NOT EXISTS tamoss_media_objects (
    id TEXT PRIMARY KEY,
    first_referenced_by_flow TEXT,
    referenced_by_flows TEXT NOT NULL DEFAULT '[]',
    object_kind TEXT NOT NULL DEFAULT 'unassigned' CHECK(object_kind IN ('unassigned','media','init')),
    allocation_id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
    access_expires_at INTEGER NOT NULL DEFAULT 0,
    content_type TEXT,
    record TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')
);


CREATE INDEX IF NOT EXISTS idx_tamoss_media_objects_unreferenced
ON tamoss_media_objects(created_at, id)
WHERE json_array_length(referenced_by_flows) = 0;



CREATE TABLE IF NOT EXISTS tamoss_segments (
    flow_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    init_object_id TEXT,
    timerange TEXT NOT NULL,
    timerange_start TEXT NOT NULL,
    timerange_end TEXT NOT NULL,
    record TEXT NOT NULL,
    created TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),
    CONSTRAINT chk_tamoss_segments_timerange_bounds
        CHECK (timerange_start <= timerange_end),
    PRIMARY KEY (flow_id, object_id, timerange),
    FOREIGN KEY (flow_id) REFERENCES tamoss_flows(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tamoss_segments_flow_timerange
ON tamoss_segments(flow_id, timerange_end, timerange_start);
CREATE INDEX IF NOT EXISTS idx_tamoss_segments_flow_object_timerange
ON tamoss_segments(flow_id, object_id, timerange_end, timerange_start);
CREATE INDEX IF NOT EXISTS idx_tamoss_segments_object_id
ON tamoss_segments(object_id);
CREATE INDEX IF NOT EXISTS idx_tamoss_segments_init_object_id
ON tamoss_segments(init_object_id);
CREATE INDEX IF NOT EXISTS idx_tamoss_segments_flow_timerange_start
ON tamoss_segments(flow_id, timerange_start);

CREATE TABLE IF NOT EXISTS tamoss_webhooks (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '{}',
    record TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')
);

CREATE INDEX IF NOT EXISTS idx_tamoss_webhooks_status ON tamoss_webhooks(status);

CREATE INDEX IF NOT EXISTS idx_tamoss_webhooks_url
ON tamoss_webhooks((record->'data'->>'url'), id);

CREATE TABLE IF NOT EXISTS tamoss_webhook_deliveries (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL,
    status TEXT NOT NULL,
    next_attempt_at TEXT,
    claimed_at TEXT,
    claimed_by TEXT,
    claim_expires_at TEXT,
    record TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')
);





CREATE INDEX IF NOT EXISTS idx_tamoss_webhook_deliveries_webhook_id
ON tamoss_webhook_deliveries(webhook_id);
CREATE INDEX IF NOT EXISTS idx_tamoss_webhook_deliveries_status
ON tamoss_webhook_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_tamoss_webhook_deliveries_claim
ON tamoss_webhook_deliveries(status, next_attempt_at, claim_expires_at);
CREATE INDEX IF NOT EXISTS idx_tamoss_webhook_deliveries_claimable
ON tamoss_webhook_deliveries(created_at, id)
WHERE status IN ('pending', 'started');

CREATE TABLE IF NOT EXISTS tamoss_delete_requests (
    id TEXT PRIMARY KEY,
    flow_id TEXT NOT NULL,
    status TEXT NOT NULL,
    claimed_at TEXT,
    claimed_by TEXT,
    claim_expires_at TEXT,
    record TEXT NOT NULL,
    updated TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')
);





CREATE INDEX IF NOT EXISTS idx_tamoss_delete_requests_flow_id
ON tamoss_delete_requests(flow_id);
CREATE INDEX IF NOT EXISTS idx_tamoss_delete_requests_status
ON tamoss_delete_requests(status);
CREATE INDEX IF NOT EXISTS idx_tamoss_delete_requests_claim
ON tamoss_delete_requests(status, claim_expires_at);
CREATE INDEX IF NOT EXISTS idx_tamoss_delete_requests_claimable
ON tamoss_delete_requests(created_at, id)
WHERE status IN ('created', 'started', 'error');
CREATE INDEX IF NOT EXISTS idx_tamoss_delete_requests_created
ON tamoss_delete_requests(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_tamoss_delete_requests_expiry
ON tamoss_delete_requests(
    (CASE WHEN status = 'done' THEN updated END) DESC,
    id DESC
);

CREATE TABLE IF NOT EXISTS tamoss_object_cleanups (
    id TEXT PRIMARY KEY,
    delete_request_id TEXT,
    object_id TEXT NOT NULL,
    storage_backend_id TEXT NOT NULL,
    status TEXT NOT NULL,
    claimed_at TEXT,
    claimed_by TEXT,
    claim_expires_at TEXT,
    record TEXT NOT NULL,
    updated TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')
);

CREATE INDEX IF NOT EXISTS idx_tamoss_object_cleanups_delete_request_id
ON tamoss_object_cleanups(delete_request_id);
CREATE INDEX IF NOT EXISTS idx_tamoss_object_cleanups_object_backend
ON tamoss_object_cleanups(object_id, storage_backend_id);
CREATE INDEX IF NOT EXISTS idx_tamoss_object_cleanups_claim
ON tamoss_object_cleanups(status, claim_expires_at);
CREATE INDEX IF NOT EXISTS idx_tamoss_object_cleanups_claimable
ON tamoss_object_cleanups(created_at, id)
WHERE status IN ('pending', 'started', 'error');

CREATE TABLE IF NOT EXISTS tamoss_object_copies (
    id TEXT PRIMARY KEY,
    object_id TEXT NOT NULL,
    source_storage_backend_id TEXT NOT NULL,
    destination_storage_backend_id TEXT NOT NULL,
    status TEXT NOT NULL,
    claimed_at TEXT,
    claimed_by TEXT,
    claim_expires_at TEXT,
    record TEXT NOT NULL,
    updated TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')
);

CREATE INDEX IF NOT EXISTS idx_tamoss_object_copies_object_id
ON tamoss_object_copies(object_id);
CREATE INDEX IF NOT EXISTS idx_tamoss_object_copies_destination
ON tamoss_object_copies(object_id, destination_storage_backend_id);
CREATE INDEX IF NOT EXISTS idx_tamoss_object_copies_claim
ON tamoss_object_copies(status, claim_expires_at);
CREATE INDEX IF NOT EXISTS idx_tamoss_object_copies_claimable
ON tamoss_object_copies(created_at, id)
WHERE status IN ('pending', 'started', 'error');

-- Retain the incarnation when domain records are reconstructed or removed.
CREATE TRIGGER IF NOT EXISTS wasm_object_insert AFTER INSERT ON tamoss_media_objects
BEGIN
    UPDATE tamoss_media_objects SET record=json_set(record,'$.allocation_id',allocation_id) WHERE id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS wasm_object_update AFTER UPDATE OF record ON tamoss_media_objects
WHEN json_extract(NEW.record,'$.allocation_id') IS NOT NEW.allocation_id
BEGIN
    UPDATE tamoss_media_objects SET record=json_set(record,'$.allocation_id',allocation_id) WHERE id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS wasm_cleanup_insert AFTER INSERT ON tamoss_object_cleanups
BEGIN
    UPDATE tamoss_object_cleanups SET record=json_set(record,
        '$.allocation_id',(SELECT allocation_id FROM tamoss_media_objects WHERE id=NEW.object_id),
        '$.not_before',(SELECT MAX(unixepoch(created_at)+86400,access_expires_at) FROM tamoss_media_objects WHERE id=NEW.object_id))
    WHERE id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS wasm_copy_insert AFTER INSERT ON tamoss_object_copies
BEGIN
    UPDATE tamoss_object_copies SET record=json_set(record,
        '$.allocation_id',(SELECT allocation_id FROM tamoss_media_objects WHERE id=NEW.object_id))
    WHERE id=NEW.id;
END;
CREATE TABLE IF NOT EXISTS wasm_r2_deletions (
    backend TEXT NOT NULL,
    allocation_id TEXT NOT NULL,
    not_before INTEGER NOT NULL,
    PRIMARY KEY(backend,allocation_id)
);
CREATE INDEX IF NOT EXISTS wasm_r2_deletions_due ON wasm_r2_deletions(not_before);

-- Flow collection membership, one row per flow_collection_ids entry, kept in
-- step with tamoss_flows by triggers so membership filters can use indexes.
CREATE TABLE IF NOT EXISTS tamoss_flow_collection_members (
    parent_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    child_id TEXT NOT NULL,
    PRIMARY KEY(parent_id, position)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_tamoss_flow_collection_members_child
ON tamoss_flow_collection_members(child_id, parent_id);
CREATE TRIGGER IF NOT EXISTS tamoss_flow_members_insert AFTER INSERT ON tamoss_flows
BEGIN
    INSERT INTO tamoss_flow_collection_members(parent_id,position,child_id)
    SELECT NEW.id, member.key, member.value FROM json_each(NEW.flow_collection_ids) AS member;
END;
-- Every flow UPSERT names flow_collection_ids, so compare values to skip unchanged collections.
CREATE TRIGGER IF NOT EXISTS tamoss_flow_members_update AFTER UPDATE OF id, flow_collection_ids ON tamoss_flows
WHEN OLD.id IS NOT NEW.id OR OLD.flow_collection_ids IS NOT NEW.flow_collection_ids
BEGIN
    DELETE FROM tamoss_flow_collection_members WHERE parent_id=OLD.id;
    INSERT INTO tamoss_flow_collection_members(parent_id,position,child_id)
    SELECT NEW.id, member.key, member.value FROM json_each(NEW.flow_collection_ids) AS member;
END;
CREATE TRIGGER IF NOT EXISTS tamoss_flow_members_delete AFTER DELETE ON tamoss_flows
BEGIN
    DELETE FROM tamoss_flow_collection_members WHERE parent_id=OLD.id;
END;

-- The alarm checks the oldest terminal row in each queue on every request.
CREATE INDEX IF NOT EXISTS idx_tamoss_delete_requests_retention
ON tamoss_delete_requests(status,updated_at) WHERE status='done';
CREATE INDEX IF NOT EXISTS idx_tamoss_object_copies_retention
ON tamoss_object_copies(status,updated_at) WHERE status='done';
CREATE INDEX IF NOT EXISTS idx_tamoss_object_cleanups_retention
ON tamoss_object_cleanups(status,updated_at) WHERE status='done';
CREATE INDEX IF NOT EXISTS idx_tamoss_webhook_deliveries_retention
ON tamoss_webhook_deliveries(status,updated_at) WHERE status IN ('done','dead');
