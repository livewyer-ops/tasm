pub const FAIL_WEBHOOK: &str = "UPDATE tamoss_webhook_deliveries
                     SET status='dead',next_attempt_at=NULL,claimed_at=NULL,claimed_by=NULL,
                         claim_expires_at=NULL,
                         record=json_set(json_set(json_set(json_set(json_set(record,'$.status',json('\"dead\"')),'$.next_attempt_at',json('null')),'$.response_status',json(COALESCE(?3,'null'))),'$.error',json(COALESCE(?4,'null'))),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),
                         updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')
                     WHERE id=?1 AND status='started' AND claimed_by=?2";

pub const DATABASE_TIME: &str = "SELECT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')";

pub const EXPIRED_ALLOCATIONS: &str = "SELECT id,record FROM tamoss_media_objects WHERE json_array_length(referenced_by_flows)=0 AND created_at<(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',-?1)) || '000000Z') ORDER BY created_at,id LIMIT ?2";

pub const GET_OBJECT: &str = "SELECT id,first_referenced_by_flow,referenced_by_flows,object_kind,content_type,record,created_at,updated_at FROM tamoss_media_objects WHERE id=?1";

pub const CLAIM_CLEANUPS: &str = "UPDATE tamoss_object_cleanups
                 SET status='started',claimed_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),claimed_by=?2,
                     claim_expires_at=(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',?3)) || '000000Z'),
                     record=json_set(json_set(record,'$.status',json('\"started\"')),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),
                     updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')
                 WHERE delete_request_id=?1
                   AND status IN ('pending','started','error')
                   AND (claim_expires_at IS NULL OR claim_expires_at<=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') OR claimed_by=?2)";

pub const UPDATE_REMAINING: &str = "UPDATE tamoss_delete_requests
                 SET record=json_set(record,'$.timerange_remaining',?2),
                     updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')
                 WHERE id=?1 AND claimed_by=?3";

pub const REMAINING_BOUNDS: &str =
    "SELECT MIN(timerange_start),MAX(timerange_end) FROM tamoss_segments
             WHERE flow_id=?1 AND timerange_start>=?2 AND timerange_end<=?3";

pub const OBJECT_BOUNDS: &str = "SELECT MIN(timerange_start),MAX(timerange_end)
                     FROM tamoss_segments WHERE object_id=?1";

pub const REFERENCING_FLOWS: &str = "SELECT DISTINCT flow_id FROM tamoss_segments
                 WHERE object_id=?1 OR init_object_id=?1 ORDER BY flow_id";

pub const DELETE_SEGMENTS: &str = "DELETE FROM tamoss_segments WHERE rowid IN (
                SELECT rowid FROM tamoss_segments
                WHERE flow_id=?1 AND timerange_start>=?2 AND timerange_end<=?3
                ORDER BY timerange_start,object_id,timerange
                LIMIT 1000
             )
             RETURNING flow_id,object_id,init_object_id,timerange,timerange_start,timerange_end,record,created";

pub const OBJECT_RANGES: &str = "SELECT timerange,record FROM tamoss_segments WHERE object_id=?1";

pub const GET_OBJECTS: &str = "SELECT id,first_referenced_by_flow,referenced_by_flows,object_kind,content_type,record,created_at,updated_at FROM tamoss_media_objects WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY id";

pub const FLOW_SEGMENTS: &str = "SELECT flow_id,object_id,init_object_id,timerange,timerange_start,timerange_end,record,created FROM tamoss_segments WHERE flow_id=?1 ORDER BY timerange_start,object_id,timerange";

pub const FLOW_SEGMENT_BOUNDS: &str = "SELECT timerange_start,timerange_end FROM tamoss_segments WHERE flow_id=?1 AND timerange_end>?2 AND timerange_start<?3";

pub const HAS_REFERENCES: &str = "SELECT EXISTS(SELECT 1 FROM tamoss_segments WHERE flow_id=?1 AND (object_id=?2 OR init_object_id=?2))";

pub const DELETE_SEGMENT: &str =
    "DELETE FROM tamoss_segments WHERE flow_id=?1 AND object_id=?2 AND timerange=?3";

pub const CLAIM_DELETE_REQUESTS: &str = "UPDATE tamoss_delete_requests SET status='started',claimed_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),claimed_by=?2,claim_expires_at=(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',?3)) || '000000Z'),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id IN (SELECT id FROM tamoss_delete_requests WHERE status IN ('created','started','error') AND(claim_expires_at IS NULL OR claim_expires_at<=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'))ORDER BY created_at,id LIMIT ?1) RETURNING id,flow_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at";

pub const FAIL_DELETE_REQUEST: &str = "UPDATE tamoss_delete_requests SET status='error',claimed_at=NULL,claimed_by=NULL,claim_expires_at=(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',MIN(3600,60*(1<<MIN(MAX(COALESCE(record->>'attempt_count',0)+1,1)-1,6))))) || '000000Z'),record=json_set(json_set(json_set(json_set(record,'$.status',json('\"error\"')),'$.error',json(?3)),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),'$.attempt_count',COALESCE(record->>'attempt_count',0)+1),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2";

pub const RELEASE_DELETE_REQUEST: &str = "UPDATE tamoss_delete_requests SET status='started',claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=json_set(json_set(record,'$.status',json('\"started\"')),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2";

pub const COMPLETE_DELETE_REQUEST: &str = "UPDATE tamoss_delete_requests SET status='done',claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=json_set(json_set(json_set(record,'$.status',json('\"done\"')),'$.error',json('null')),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2";

pub const CLAIM_UNPARENTED_CLEANUPS: &str = "UPDATE tamoss_object_cleanups SET status='started',claimed_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),claimed_by=?2,claim_expires_at=(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',?3)) || '000000Z'),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id IN (SELECT id FROM tamoss_object_cleanups WHERE delete_request_id IS NULL AND status IN ('pending','started','error') AND(claim_expires_at IS NULL OR claim_expires_at<=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'))ORDER BY created_at,id LIMIT ?1) RETURNING id,delete_request_id,object_id,storage_backend_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at";

pub const CLAIM_COPIES: &str = "UPDATE tamoss_object_copies SET status='started',claimed_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),claimed_by=?2,claim_expires_at=(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',?3)) || '000000Z'),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id IN (SELECT id FROM tamoss_object_copies WHERE status IN ('pending','started','error') AND(claim_expires_at IS NULL OR claim_expires_at<=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'))ORDER BY created_at,id LIMIT ?1) RETURNING id,object_id,source_storage_backend_id,destination_storage_backend_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at";

pub const CLAIM_WEBHOOKS: &str = "UPDATE tamoss_webhook_deliveries SET status='started',claimed_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),claimed_by=?2,claim_expires_at=(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',?3)) || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id IN (SELECT id FROM tamoss_webhook_deliveries WHERE status IN ('pending','started') AND(next_attempt_at IS NULL OR next_attempt_at<=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'))AND(claim_expires_at IS NULL OR claim_expires_at<=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'))ORDER BY created_at,id LIMIT ?1) RETURNING id,webhook_id,status,next_attempt_at,record,created_at,updated_at,claimed_at,claimed_by,claim_expires_at";

pub const BEGIN_WEBHOOK_ATTEMPT: &str = "UPDATE tamoss_webhook_deliveries SET record=json_set(json_set(record,'$.attempt_count',COALESCE((record->>'attempt_count'),0)+1),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2 AND claim_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')";

pub const RETRY_WEBHOOK: &str = "UPDATE tamoss_webhook_deliveries SET status='pending',next_attempt_at=(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',?3)) || '000000Z'),claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=json_set(json_set(json_set(json_set(json_set(record,'$.status',json('\"pending\"')),'$.next_attempt_at',(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',?3)) || '000000Z')),'$.response_status',json(COALESCE(?4,'null'))),'$.error',json(COALESCE(?5,'null'))),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2";

pub const FINISH_WEBHOOK: &str = "UPDATE tamoss_webhook_deliveries SET status=?3,next_attempt_at=NULL,claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=json_set(json_set(json_set(json_set(json_set(record,'$.status',?3),'$.next_attempt_at',json('null')),'$.response_status',json(COALESCE(?4,'null'))),'$.error',json(COALESCE(?5,'null'))),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2";

pub const BEGIN_CLEANUP_ATTEMPT: &str = "UPDATE tamoss_object_cleanups SET record=json_set(json_set(json_set(record,'$.attempt_count',COALESCE((record->>'attempt_count'),0)+1),'$.error',json('null')),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2 AND claim_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')";

pub const BEGIN_COPY_ATTEMPT: &str = "UPDATE tamoss_object_copies SET record=json_set(json_set(json_set(record,'$.attempt_count',COALESCE((record->>'attempt_count'),0)+1),'$.error',json('null')),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2 AND claim_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')";

pub const FINISH_CLEANUP: &str = "UPDATE tamoss_object_cleanups SET status=?3,claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=json_set(json_set(json_set(record,'$.status',?3),'$.error',json(COALESCE(?4,'null'))),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2";

pub const FINISH_CLEANUP_WITH_BACKOFF: &str = "UPDATE tamoss_object_cleanups SET status=?3,claimed_at=NULL,claimed_by=NULL,claim_expires_at=(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',MIN(3600,60*(1<<MIN(MAX(COALESCE(record->>'attempt_count',1),1)-1,6))))) || '000000Z'),record=json_set(json_set(json_set(record,'$.status',?3),'$.error',json(COALESCE(?4,'null'))),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2";

pub const FINISH_COPY: &str = "UPDATE tamoss_object_copies SET status=?3,claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=json_set(json_set(json_set(record,'$.status',?3),'$.error',json(COALESCE(?4,'null'))),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2";

pub const FINISH_COPY_WITH_BACKOFF: &str = "UPDATE tamoss_object_copies SET status=?3,claimed_at=NULL,claimed_by=NULL,claim_expires_at=(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',MIN(3600,60*(1<<MIN(MAX(COALESCE(record->>'attempt_count',1),1)-1,6))))) || '000000Z'),record=json_set(json_set(json_set(record,'$.status',?3),'$.error',json(COALESCE(?4,'null'))),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2";

pub const PURGE_WEBHOOK_DELIVERIES: &str = "DELETE FROM tamoss_webhook_deliveries WHERE id IN (SELECT id FROM tamoss_webhook_deliveries WHERE status IN ('done','dead')AND updated_at<(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',-?1)) || '000000Z') ORDER BY updated_at,id LIMIT ?2)";

pub const PURGE_DELETE_REQUESTS: &str = "DELETE FROM tamoss_delete_requests WHERE id IN (SELECT id FROM tamoss_delete_requests WHERE status='done' AND updated_at<(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',-?1)) || '000000Z') ORDER BY updated_at,id LIMIT ?2)";

pub const PURGE_OBJECT_CLEANUPS: &str = "DELETE FROM tamoss_object_cleanups WHERE id IN (SELECT id FROM tamoss_object_cleanups WHERE status='done' AND updated_at<(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',-?1)) || '000000Z') ORDER BY updated_at,id LIMIT ?2)";

pub const PURGE_OBJECT_COPIES: &str = "DELETE FROM tamoss_object_copies WHERE id IN (SELECT id FROM tamoss_object_copies WHERE status='done' AND updated_at<(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',-?1)) || '000000Z') ORDER BY updated_at,id LIMIT ?2)";
