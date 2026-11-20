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

pub const CLAIM_CLEANUPS: &str = "UPDATE tamoss_object_cleanups
                 SET status='started',claimed_at=NOW(),claimed_by=$2,
                     claim_expires_at=NOW()+($3*INTERVAL '1 second'),
                     record=jsonb_set(jsonb_set(record,'{status}','\"started\"',true),'{updated}',to_jsonb(NOW()),true),
                     updated=NOW(),updated_at=NOW()
                 WHERE delete_request_id=$1
                   AND status=ANY(ARRAY['pending','started','error'])
                   AND (claim_expires_at IS NULL OR claim_expires_at<=NOW() OR claimed_by=$2)";

pub const CLEAR_REMAINING: &str = "UPDATE tamoss_delete_requests
                 SET record=jsonb_set(record,'{timerange_remaining}','null',true)
                 WHERE id=$1 AND claimed_by=$2";

pub const UPDATE_REMAINING: &str = "UPDATE tamoss_delete_requests
                 SET record=jsonb_set(record,'{timerange_remaining}',to_jsonb($2::text),true),
                     updated=NOW(),updated_at=NOW()
                 WHERE id=$1 AND claimed_by=$3";

pub const REMAINING_BOUNDS: &str =
    "SELECT MIN(timerange_start),MAX(timerange_end) FROM tamoss_segments
             WHERE flow_id=$1 AND timerange_start>=$2 AND timerange_end<=$3";

pub const OBJECT_BOUNDS: &str = "SELECT MIN(timerange_start),MAX(timerange_end)
                     FROM tamoss_segments WHERE object_id=$1";

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

pub const FLOW_SEGMENTS: &str = "SELECT flow_id,object_id,init_object_id,timerange,timerange_start,timerange_end,record,created FROM tamoss_segments WHERE flow_id=$1 ORDER BY timerange_start,object_id,timerange";

pub const HAS_REFERENCES: &str = "SELECT EXISTS(SELECT 1 FROM tamoss_segments WHERE flow_id=$1 AND (object_id=$2 OR init_object_id=$2))";

pub const DELETE_SEGMENT: &str =
    "DELETE FROM tamoss_segments WHERE flow_id=$1 AND object_id=$2 AND timerange=$3";
