pub const FAIL_WEBHOOK: &str = "UPDATE tamoss_webhook_deliveries
                     SET status='dead',next_attempt_at=NULL,claimed_at=NULL,claimed_by=NULL,
                         claim_expires_at=NULL,
                         record=jsonb_set(
                             jsonb_set(
                                 jsonb_set(
                                     jsonb_set(
                                         jsonb_set(record,'{status}','\"dead\"',true),
                                         '{next_attempt_at}','null',true
                                     ),
                                     '{response_status}',COALESCE(to_jsonb($3),'null'::jsonb),true
                                 ),
                                 '{error}',COALESCE($4,'null'::jsonb),true
                             ),
                             '{updated}',to_jsonb(NOW()),true
                         ),
                         updated_at=NOW()
                     WHERE id=$1 AND status='started' AND claimed_by=$2";

pub const DATABASE_TIME: &str = "SELECT NOW()";

pub const EXPIRED_ALLOCATIONS: &str = "SELECT id,record FROM tamoss_media_objects WHERE cardinality(referenced_by_flows)=0 AND created_at<NOW()-($1*INTERVAL '1 second') ORDER BY created_at,id LIMIT $2 FOR UPDATE SKIP LOCKED";

pub const GET_OBJECT: &str = "SELECT id,first_referenced_by_flow,referenced_by_flows,object_kind,content_type,record,created_at,updated_at FROM tamoss_media_objects WHERE id=$1";

pub const UPDATE_REMAINING: &str = "UPDATE tamoss_delete_requests
                 SET record=jsonb_set(record,'{timerange_remaining}',to_jsonb($2::text),true),
                     updated=NOW(),updated_at=NOW()
                 WHERE id=$1 AND claimed_by=$3";

pub const REMAINING_BOUNDS: &str =
    "SELECT MIN(timerange_start),MAX(timerange_end) FROM tamoss_segments
             WHERE flow_id=$1 AND timerange_start>=$2 AND timerange_end<=$3";

pub const REFERENCING_FLOWS: &str = "SELECT DISTINCT flow_id FROM tamoss_segments
                 WHERE object_id=$1 OR init_object_id=$1 ORDER BY flow_id";

pub const DELETE_SEGMENTS: &str = "DELETE FROM tamoss_segments WHERE ctid IN (
                SELECT ctid FROM tamoss_segments
                WHERE flow_id=$1 AND timerange_start>=$2 AND timerange_end<=$3
                ORDER BY timerange_start,object_id,timerange
                LIMIT 1000 FOR UPDATE
             )
             RETURNING flow_id,object_id,init_object_id,timerange,timerange_start,timerange_end,record,created";

pub const OBJECT_RANGES: &str = "SELECT timerange,record FROM tamoss_segments WHERE object_id=$1";

pub const GET_OBJECTS: &str = "SELECT id,first_referenced_by_flow,referenced_by_flows,object_kind,content_type,record,created_at,updated_at FROM tamoss_media_objects WHERE id=ANY($1) ORDER BY id";

pub const OBJECT_SEGMENTS: &str = "SELECT flow_id,object_id,init_object_id,timerange,timerange_start,timerange_end,record,created FROM tamoss_segments WHERE flow_id=$1 AND object_id=$2 AND timerange_start>=$3 AND timerange_end<=$4 ORDER BY timerange_start,object_id,timerange";

pub const SEGMENT_SELECTION: &str = "SELECT MIN(timerange_start),MAX(timerange_end),COUNT(*),MIN(timerange) FROM tamoss_segments WHERE flow_id=$1 AND timerange_start>=$2 AND timerange_end<=$3";

pub const FLOW_SEGMENT_BOUNDS: &str = "SELECT timerange_start,timerange_end FROM tamoss_segments WHERE flow_id=$1 AND timerange_end>$2 AND timerange_start<$3";

pub const HAS_REFERENCES: &str = "SELECT EXISTS(SELECT 1 FROM tamoss_segments WHERE flow_id=$1 AND (object_id=$2 OR init_object_id=$2))";

pub const DELETE_SEGMENT: &str =
    "DELETE FROM tamoss_segments WHERE flow_id=$1 AND object_id=$2 AND timerange=$3";

pub const CLAIM_DELETE_REQUESTS: &str = "WITH candidates AS(SELECT id FROM tamoss_delete_requests WHERE status=ANY(ARRAY['created','started','error']) AND(claim_expires_at IS NULL OR claim_expires_at<=NOW())ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED),claimed AS(UPDATE tamoss_delete_requests q SET status='started',claimed_at=NOW(),claimed_by=$2,claim_expires_at=NOW()+($3*INTERVAL '1 second'),updated=NOW(),updated_at=NOW() FROM candidates WHERE q.id=candidates.id RETURNING q.*)SELECT id,flow_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at FROM claimed ORDER BY created_at,id";

pub const FAIL_DELETE_REQUEST: &str = "UPDATE tamoss_delete_requests SET status='error',claimed_at=NULL,claimed_by=NULL,claim_expires_at=COALESCE($4::timestamptz,NOW()+make_interval(secs=>LEAST(3600,60*power(2,LEAST(GREATEST(COALESCE((record->>'attempt_count')::int,0)+1,1)-1,6))))),record=jsonb_set(jsonb_set(jsonb_set(jsonb_set(record,'{status}','\"error\"',true),'{error}',$3,true),'{updated}',to_jsonb(NOW()),true),'{attempt_count}',to_jsonb(COALESCE((record->>'attempt_count')::int,0)+1),true),updated=NOW(),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2";

pub const RELEASE_DELETE_REQUEST: &str = "UPDATE tamoss_delete_requests SET status='started',claimed_at=NULL,claimed_by=NULL,claim_expires_at=$3::timestamptz,record=jsonb_set(jsonb_set(record,'{status}','\"started\"',true),'{updated}',to_jsonb(NOW()),true),updated=NOW(),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2";

pub const COMPLETE_DELETE_REQUEST: &str = "UPDATE tamoss_delete_requests SET status='done',claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=jsonb_set(jsonb_set(jsonb_set(record,'{status}','\"done\"',true),'{error}','null',true),'{updated}',to_jsonb(NOW()),true),updated=NOW(),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2";

pub const CLAIM_CLEANUPS: &str = "WITH candidates AS(SELECT id FROM tamoss_object_cleanups WHERE delete_request_id IS NOT DISTINCT FROM $4 AND status=ANY(ARRAY['pending','started','error']) AND(claim_expires_at IS NULL OR claim_expires_at<=NOW())ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED),claimed AS(UPDATE tamoss_object_cleanups q SET status='started',claimed_at=NOW(),claimed_by=$2,claim_expires_at=NOW()+($3*INTERVAL '1 second'),updated=NOW(),updated_at=NOW() FROM candidates WHERE q.id=candidates.id RETURNING q.*)SELECT id,delete_request_id,object_id,storage_backend_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at FROM claimed ORDER BY created_at,id";

pub const CLAIM_COPIES: &str = "WITH candidates AS(SELECT id FROM tamoss_object_copies WHERE status=ANY(ARRAY['pending','started','error']) AND(claim_expires_at IS NULL OR claim_expires_at<=NOW())ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED),claimed AS(UPDATE tamoss_object_copies q SET status='started',claimed_at=NOW(),claimed_by=$2,claim_expires_at=NOW()+($3*INTERVAL '1 second'),updated=NOW(),updated_at=NOW() FROM candidates WHERE q.id=candidates.id RETURNING q.*)SELECT id,object_id,source_storage_backend_id,destination_storage_backend_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at FROM claimed ORDER BY created_at,id";

pub const CLAIM_WEBHOOKS: &str = "WITH candidates AS(SELECT id FROM tamoss_webhook_deliveries WHERE status=ANY(ARRAY['pending','started']) AND(next_attempt_at IS NULL OR next_attempt_at<=NOW())AND(claim_expires_at IS NULL OR claim_expires_at<=NOW())ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED),claimed AS(UPDATE tamoss_webhook_deliveries q SET status='started',claimed_at=NOW(),claimed_by=$2,claim_expires_at=NOW()+($3*INTERVAL '1 second'),updated_at=NOW() FROM candidates WHERE q.id=candidates.id RETURNING q.*)SELECT id,webhook_id,status,next_attempt_at,record,created_at,updated_at,claimed_at,claimed_by,claim_expires_at FROM claimed ORDER BY created_at,id";

pub const BEGIN_WEBHOOK_ATTEMPT: &str = "UPDATE tamoss_webhook_deliveries SET record=jsonb_set(jsonb_set(record,'{attempt_count}',to_jsonb(COALESCE((record->>'attempt_count')::int,0)+1),true),'{updated}',to_jsonb(NOW()),true),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2 AND claim_expires_at>NOW()";

pub const RETRY_WEBHOOK: &str = "UPDATE tamoss_webhook_deliveries SET status='pending',next_attempt_at=NOW()+($3*INTERVAL '1 second'),claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(record,'{status}','\"pending\"',true),'{next_attempt_at}',to_jsonb(NOW()+($3*INTERVAL '1 second')),true),'{response_status}',COALESCE(to_jsonb($4),'null'::jsonb),true),'{error}',COALESCE($5,'null'::jsonb),true),'{updated}',to_jsonb(NOW()),true),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2";

pub const FINISH_WEBHOOK: &str = "UPDATE tamoss_webhook_deliveries SET status=$3,next_attempt_at=NULL,claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(record,'{status}',to_jsonb($3::text),true),'{next_attempt_at}','null',true),'{response_status}',COALESCE(to_jsonb($4),'null'::jsonb),true),'{error}',COALESCE($5,'null'::jsonb),true),'{updated}',to_jsonb(NOW()),true),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2";

pub const BEGIN_CLEANUP_ATTEMPT: &str = "UPDATE tamoss_object_cleanups SET record=jsonb_set(jsonb_set(jsonb_set(record,'{attempt_count}',to_jsonb(COALESCE((record->>'attempt_count')::int,0)+1),true),'{error}','null',true),'{updated}',to_jsonb(NOW()),true),updated=NOW(),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2 AND claim_expires_at>NOW()";

pub const BEGIN_COPY_ATTEMPT: &str = "UPDATE tamoss_object_copies SET record=jsonb_set(jsonb_set(jsonb_set(record,'{attempt_count}',to_jsonb(COALESCE((record->>'attempt_count')::int,0)+1),true),'{error}','null',true),'{updated}',to_jsonb(NOW()),true),updated=NOW(),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2 AND claim_expires_at>NOW()";

pub const FINISH_CLEANUP: &str = "UPDATE tamoss_object_cleanups SET status=$3,claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=jsonb_set(jsonb_set(jsonb_set(record,'{status}',to_jsonb($3::text),true),'{error}',COALESCE($4,'null'::jsonb),true),'{updated}',to_jsonb(NOW()),true),updated=NOW(),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2";

pub const FINISH_CLEANUP_WITH_BACKOFF: &str = "UPDATE tamoss_object_cleanups SET status=$3,claimed_at=NULL,claimed_by=NULL,claim_expires_at=NOW()+make_interval(secs=>LEAST(3600,60*power(2,LEAST(GREATEST(COALESCE((record->>'attempt_count')::int,1),1)-1,6)))),record=jsonb_set(jsonb_set(jsonb_set(record,'{status}',to_jsonb($3::text),true),'{error}',COALESCE($4,'null'::jsonb),true),'{updated}',to_jsonb(NOW()),true),updated=NOW(),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2";

pub const FINISH_COPY: &str = "UPDATE tamoss_object_copies SET status=$3,claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=jsonb_set(jsonb_set(jsonb_set(record,'{status}',to_jsonb($3::text),true),'{error}',COALESCE($4,'null'::jsonb),true),'{updated}',to_jsonb(NOW()),true),updated=NOW(),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2";

pub const FINISH_COPY_WITH_BACKOFF: &str = "UPDATE tamoss_object_copies SET status=$3,claimed_at=NULL,claimed_by=NULL,claim_expires_at=NOW()+make_interval(secs=>LEAST(3600,60*power(2,LEAST(GREATEST(COALESCE((record->>'attempt_count')::int,1),1)-1,6)))),record=jsonb_set(jsonb_set(jsonb_set(record,'{status}',to_jsonb($3::text),true),'{error}',COALESCE($4,'null'::jsonb),true),'{updated}',to_jsonb(NOW()),true),updated=NOW(),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2";

pub const PURGE_WEBHOOK_DELIVERIES: &str = "WITH target AS(SELECT id FROM tamoss_webhook_deliveries WHERE status=ANY(ARRAY['done','dead'])AND updated_at<NOW()-($1*INTERVAL '1 second') ORDER BY updated_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)DELETE FROM tamoss_webhook_deliveries q USING target WHERE q.id=target.id";

pub const PURGE_DELETE_REQUESTS: &str = "WITH target AS(SELECT id FROM tamoss_delete_requests WHERE status='done' AND updated_at<NOW()-($1*INTERVAL '1 second') ORDER BY updated_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)DELETE FROM tamoss_delete_requests q USING target WHERE q.id=target.id";

pub const PURGE_OBJECT_CLEANUPS: &str = "WITH target AS(SELECT id FROM tamoss_object_cleanups WHERE status='done' AND updated_at<NOW()-($1*INTERVAL '1 second') ORDER BY updated_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)DELETE FROM tamoss_object_cleanups q USING target WHERE q.id=target.id";

pub const PURGE_OBJECT_COPIES: &str = "WITH target AS(SELECT id FROM tamoss_object_copies WHERE status='done' AND updated_at<NOW()-($1*INTERVAL '1 second') ORDER BY updated_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)DELETE FROM tamoss_object_copies q USING target WHERE q.id=target.id";
