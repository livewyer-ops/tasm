// TASM browser adaptation of rust-tams-api (Apache-2.0); see NOTICE for changes.
use crate::pglite as sqlx;
use serde_json::Value;
use sqlx::{PgPool, Postgres, Row, postgres::PgRow};
use uuid::Uuid;

use super::{
    DbError,
    records::{
        DeleteRequest, ObjectCleanup, ObjectCopy, Page, PageRequest, WebhookDelivery, finish_page,
    },
};

fn claim_bounds(limit: i64, lease_seconds: i64) -> Result<(i64, i64), DbError> {
    if !(1..=1000).contains(&limit) || lease_seconds < 1 {
        return Err(DbError::Record(
            "claim limit must be 1..=1000 and lease must be positive".into(),
        ));
    }
    Ok((limit, lease_seconds))
}

pub async fn save_delete_request<'e, E>(e: E, v: &DeleteRequest) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    sqlx::query("INSERT INTO tamoss_delete_requests(id,flow_id,status,claimed_at,claimed_by,claim_expires_at,record,updated,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())ON CONFLICT(id)DO UPDATE SET flow_id=EXCLUDED.flow_id,status=EXCLUDED.status,claimed_at=EXCLUDED.claimed_at,claimed_by=EXCLUDED.claimed_by,claim_expires_at=EXCLUDED.claim_expires_at,record=EXCLUDED.record,updated=EXCLUDED.updated,created_at=EXCLUDED.created_at,updated_at=NOW()").bind(v.id).bind(v.flow_id).bind(&v.status).bind(v.claimed_at).bind(&v.claimed_by).bind(v.claim_expires_at).bind(sqlx::types::Json(&v.record)).bind(v.updated).bind(v.created_at).execute(e).await?;
    Ok(())
}
pub async fn claim_delete_requests(
    pool: &PgPool,
    worker: &str,
    limit: i64,
    lease: i64,
) -> Result<Vec<DeleteRequest>, DbError> {
    let (limit, lease) = claim_bounds(limit, lease)?;
    sqlx::query("WITH candidates AS(SELECT id FROM tamoss_delete_requests WHERE status=ANY(ARRAY['created','started','error']) AND(claim_expires_at IS NULL OR claim_expires_at<=NOW())ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED),claimed AS(UPDATE tamoss_delete_requests q SET status='started',claimed_at=NOW(),claimed_by=$2,claim_expires_at=NOW()+($3*INTERVAL '1 second'),updated=NOW(),updated_at=NOW() FROM candidates WHERE q.id=candidates.id RETURNING q.*)SELECT id,flow_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at FROM claimed ORDER BY created_at,id").bind(limit).bind(worker).bind(lease).fetch_all(pool).await?.into_iter().map(map_delete).collect()
}
pub async fn fail_delete_request(
    pool: &PgPool,
    id: Uuid,
    worker: &str,
    error: Value,
) -> Result<bool, DbError> {
    Ok(sqlx::query("UPDATE tamoss_delete_requests SET status='error',claimed_at=NULL,claimed_by=NULL,record=jsonb_set(jsonb_set(jsonb_set(record,'{status}','\"error\"',true),'{error}',$3,true),'{updated}',to_jsonb(NOW()),true),updated=NOW(),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2").bind(id).bind(worker).bind(sqlx::types::Json(error)).execute(pool).await?.rows_affected()==1)
}
pub async fn release_delete_request(
    pool: &PgPool,
    id: Uuid,
    worker: &str,
) -> Result<bool, DbError> {
    Ok(sqlx::query("UPDATE tamoss_delete_requests SET status='started',claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=jsonb_set(jsonb_set(record,'{status}','\"started\"',true),'{updated}',to_jsonb(NOW()),true),updated=NOW(),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2").bind(id).bind(worker).execute(pool).await?.rows_affected()==1)
}
pub async fn complete_delete_request(
    pool: &PgPool,
    id: Uuid,
    worker: &str,
) -> Result<bool, DbError> {
    Ok(sqlx::query("UPDATE tamoss_delete_requests SET status='done',claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=jsonb_set(jsonb_set(jsonb_set(record,'{status}','\"done\"',true),'{error}','null',true),'{updated}',to_jsonb(NOW()),true),updated=NOW(),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2").bind(id).bind(worker).execute(pool).await?.rows_affected()==1)
}

pub async fn save_cleanup<'e, E>(e: E, v: &ObjectCleanup) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    sqlx::query("INSERT INTO tamoss_object_cleanups(id,delete_request_id,object_id,storage_backend_id,status,claimed_at,claimed_by,claim_expires_at,record,updated,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())ON CONFLICT(id)DO UPDATE SET delete_request_id=EXCLUDED.delete_request_id,object_id=EXCLUDED.object_id,storage_backend_id=EXCLUDED.storage_backend_id,status=EXCLUDED.status,claimed_at=EXCLUDED.claimed_at,claimed_by=EXCLUDED.claimed_by,claim_expires_at=EXCLUDED.claim_expires_at,record=EXCLUDED.record,updated=EXCLUDED.updated,updated_at=NOW()").bind(v.id).bind(v.delete_request_id).bind(&v.object_id).bind(v.storage_backend_id).bind(&v.status).bind(v.claimed_at).bind(&v.claimed_by).bind(v.claim_expires_at).bind(sqlx::types::Json(&v.record)).bind(v.updated).bind(v.created_at).execute(e).await?;
    Ok(())
}
pub async fn claim_cleanups(
    pool: &PgPool,
    worker: &str,
    limit: i64,
    lease: i64,
) -> Result<Vec<ObjectCleanup>, DbError> {
    let (limit, lease) = claim_bounds(limit, lease)?;
    sqlx::query("WITH candidates AS(SELECT id FROM tamoss_object_cleanups WHERE delete_request_id IS NULL AND status=ANY(ARRAY['pending','started','error']) AND(claim_expires_at IS NULL OR claim_expires_at<=NOW())ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED),claimed AS(UPDATE tamoss_object_cleanups q SET status='started',claimed_at=NOW(),claimed_by=$2,claim_expires_at=NOW()+($3*INTERVAL '1 second'),updated=NOW(),updated_at=NOW() FROM candidates WHERE q.id=candidates.id RETURNING q.*)SELECT id,delete_request_id,object_id,storage_backend_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at FROM claimed ORDER BY created_at,id").bind(limit).bind(worker).bind(lease).fetch_all(pool).await?.into_iter().map(map_cleanup).collect()
}
pub async fn list_parent_cleanups(
    pool: &PgPool,
    parent: Uuid,
) -> Result<Vec<ObjectCleanup>, DbError> {
    sqlx::query("SELECT id,delete_request_id,object_id,storage_backend_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at FROM tamoss_object_cleanups WHERE delete_request_id=$1 ORDER BY created_at,id").bind(parent).fetch_all(pool).await?.into_iter().map(map_cleanup).collect()
}
pub async fn begin_cleanup_attempt(pool: &PgPool, id: Uuid, worker: &str) -> Result<bool, DbError> {
    begin_attempt(pool, "tamoss_object_cleanups", id, worker).await
}
pub async fn fail_cleanup(
    pool: &PgPool,
    id: Uuid,
    worker: &str,
    error: Value,
) -> Result<bool, DbError> {
    finish_simple(
        pool,
        "tamoss_object_cleanups",
        id,
        worker,
        "error",
        Some(error),
        false,
    )
    .await
}
pub async fn complete_cleanup(pool: &PgPool, id: Uuid, worker: &str) -> Result<bool, DbError> {
    finish_simple(
        pool,
        "tamoss_object_cleanups",
        id,
        worker,
        "done",
        None,
        true,
    )
    .await
}

pub async fn save_copy<'e, E>(e: E, v: &ObjectCopy) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    sqlx::query("INSERT INTO tamoss_object_copies(id,object_id,source_storage_backend_id,destination_storage_backend_id,status,claimed_at,claimed_by,claim_expires_at,record,updated,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())ON CONFLICT(id)DO UPDATE SET object_id=EXCLUDED.object_id,source_storage_backend_id=EXCLUDED.source_storage_backend_id,destination_storage_backend_id=EXCLUDED.destination_storage_backend_id,status=EXCLUDED.status,claimed_at=EXCLUDED.claimed_at,claimed_by=EXCLUDED.claimed_by,claim_expires_at=EXCLUDED.claim_expires_at,record=EXCLUDED.record,updated=EXCLUDED.updated,updated_at=NOW()").bind(v.id).bind(&v.object_id).bind(v.source_storage_backend_id).bind(v.destination_storage_backend_id).bind(&v.status).bind(v.claimed_at).bind(&v.claimed_by).bind(v.claim_expires_at).bind(sqlx::types::Json(&v.record)).bind(v.updated).bind(v.created_at).execute(e).await?;
    Ok(())
}
pub async fn claim_copies(
    pool: &PgPool,
    worker: &str,
    limit: i64,
    lease: i64,
) -> Result<Vec<ObjectCopy>, DbError> {
    let (limit, lease) = claim_bounds(limit, lease)?;
    sqlx::query("WITH candidates AS(SELECT id FROM tamoss_object_copies WHERE status=ANY(ARRAY['pending','started','error']) AND(claim_expires_at IS NULL OR claim_expires_at<=NOW())ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED),claimed AS(UPDATE tamoss_object_copies q SET status='started',claimed_at=NOW(),claimed_by=$2,claim_expires_at=NOW()+($3*INTERVAL '1 second'),updated=NOW(),updated_at=NOW() FROM candidates WHERE q.id=candidates.id RETURNING q.*)SELECT id,object_id,source_storage_backend_id,destination_storage_backend_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at FROM claimed ORDER BY created_at,id").bind(limit).bind(worker).bind(lease).fetch_all(pool).await?.into_iter().map(map_copy).collect()
}
pub async fn begin_copy_attempt(pool: &PgPool, id: Uuid, worker: &str) -> Result<bool, DbError> {
    begin_attempt(pool, "tamoss_object_copies", id, worker).await
}
pub async fn fail_copy(
    pool: &PgPool,
    id: Uuid,
    worker: &str,
    error: Value,
) -> Result<bool, DbError> {
    finish_simple(
        pool,
        "tamoss_object_copies",
        id,
        worker,
        "error",
        Some(error),
        false,
    )
    .await
}
pub async fn complete_copy(pool: &PgPool, id: Uuid, worker: &str) -> Result<bool, DbError> {
    finish_simple(pool, "tamoss_object_copies", id, worker, "done", None, true).await
}

pub async fn save_webhook_delivery<'e, E>(e: E, v: &WebhookDelivery) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    sqlx::query("INSERT INTO tamoss_webhook_deliveries(id,webhook_id,status,next_attempt_at,claimed_at,claimed_by,claim_expires_at,record,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())ON CONFLICT(id)DO UPDATE SET webhook_id=EXCLUDED.webhook_id,status=EXCLUDED.status,next_attempt_at=EXCLUDED.next_attempt_at,claimed_at=EXCLUDED.claimed_at,claimed_by=EXCLUDED.claimed_by,claim_expires_at=EXCLUDED.claim_expires_at,record=EXCLUDED.record,updated_at=NOW()").bind(v.id).bind(v.webhook_id).bind(&v.status).bind(v.next_attempt_at).bind(v.claimed_at).bind(&v.claimed_by).bind(v.claim_expires_at).bind(sqlx::types::Json(&v.record)).bind(v.created_at).execute(e).await?;
    Ok(())
}
pub async fn claim_webhooks(
    pool: &PgPool,
    worker: &str,
    limit: i64,
    lease: i64,
) -> Result<Vec<WebhookDelivery>, DbError> {
    let (limit, lease) = claim_bounds(limit, lease)?;
    sqlx::query("WITH candidates AS(SELECT id FROM tamoss_webhook_deliveries WHERE status=ANY(ARRAY['pending','started']) AND(next_attempt_at IS NULL OR next_attempt_at<=NOW())AND(claim_expires_at IS NULL OR claim_expires_at<=NOW())ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED),claimed AS(UPDATE tamoss_webhook_deliveries q SET status='started',claimed_at=NOW(),claimed_by=$2,claim_expires_at=NOW()+($3*INTERVAL '1 second'),updated_at=NOW() FROM candidates WHERE q.id=candidates.id RETURNING q.*)SELECT id,webhook_id,status,next_attempt_at,record,created_at,updated_at,claimed_at,claimed_by,claim_expires_at FROM claimed ORDER BY created_at,id").bind(limit).bind(worker).bind(lease).fetch_all(pool).await?.into_iter().map(map_webhook).collect()
}
pub async fn begin_webhook_attempt(pool: &PgPool, id: Uuid, worker: &str) -> Result<bool, DbError> {
    Ok(sqlx::query("UPDATE tamoss_webhook_deliveries SET record=jsonb_set(jsonb_set(record,'{attempt_count}',to_jsonb(COALESCE((record->>'attempt_count')::int,0)+1),true),'{updated}',to_jsonb(NOW()),true),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2 AND claim_expires_at>NOW()").bind(id).bind(worker).execute(pool).await?.rows_affected()==1)
}
pub async fn retry_webhook(
    pool: &PgPool,
    id: Uuid,
    worker: &str,
    delay_seconds: i64,
    response: Option<i32>,
    error: Option<Value>,
) -> Result<bool, DbError> {
    if delay_seconds < 0 {
        return Err(DbError::Record(
            "webhook retry delay must be nonnegative".into(),
        ));
    }
    Ok(sqlx::query("UPDATE tamoss_webhook_deliveries SET status='pending',next_attempt_at=NOW()+($3*INTERVAL '1 second'),claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(record,'{status}','\"pending\"',true),'{next_attempt_at}',to_jsonb(NOW()+($3*INTERVAL '1 second')),true),'{response_status}',COALESCE(to_jsonb($4),'null'::jsonb),true),'{error}',COALESCE($5,'null'::jsonb),true),'{updated}',to_jsonb(NOW()),true),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2").bind(id).bind(worker).bind(delay_seconds).bind(response).bind(error.map(sqlx::types::Json)).execute(pool).await?.rows_affected()==1)
}
pub async fn terminal_webhook(
    pool: &PgPool,
    id: Uuid,
    worker: &str,
    status: &str,
    response: Option<i32>,
    error: Option<Value>,
) -> Result<bool, DbError> {
    if status != "done" && status != "dead" {
        return Err(DbError::Record(
            "webhook terminal status must be done or dead".into(),
        ));
    }
    Ok(sqlx::query("UPDATE tamoss_webhook_deliveries SET status=$3,next_attempt_at=NULL,claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(record,'{status}',to_jsonb($3::text),true),'{next_attempt_at}','null',true),'{response_status}',COALESCE(to_jsonb($4),'null'::jsonb),true),'{error}',COALESCE($5,'null'::jsonb),true),'{updated}',to_jsonb(NOW()),true),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2").bind(id).bind(worker).bind(status).bind(response).bind(error.map(sqlx::types::Json)).execute(pool).await?.rows_affected()==1)
}

async fn begin_attempt(
    pool: &PgPool,
    table: &str,
    id: Uuid,
    worker: &str,
) -> Result<bool, DbError> {
    let sql = match table {
        "tamoss_object_cleanups" => {
            "UPDATE tamoss_object_cleanups SET record=jsonb_set(jsonb_set(jsonb_set(record,'{attempt_count}',to_jsonb(COALESCE((record->>'attempt_count')::int,0)+1),true),'{error}','null',true),'{updated}',to_jsonb(NOW()),true),updated=NOW(),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2 AND claim_expires_at>NOW()"
        }
        "tamoss_object_copies" => {
            "UPDATE tamoss_object_copies SET record=jsonb_set(jsonb_set(jsonb_set(record,'{attempt_count}',to_jsonb(COALESCE((record->>'attempt_count')::int,0)+1),true),'{error}','null',true),'{updated}',to_jsonb(NOW()),true),updated=NOW(),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2 AND claim_expires_at>NOW()"
        }
        _ => return Err(DbError::Record("unknown queue".into())),
    };
    Ok(sqlx::query(sql)
        .bind(id)
        .bind(worker)
        .execute(pool)
        .await?
        .rows_affected()
        == 1)
}
async fn finish_simple(
    pool: &PgPool,
    table: &str,
    id: Uuid,
    worker: &str,
    status: &str,
    error: Option<Value>,
    clear: bool,
) -> Result<bool, DbError> {
    let sql = match (table, clear) {
        ("tamoss_object_cleanups", true) => {
            "UPDATE tamoss_object_cleanups SET status=$3,claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=jsonb_set(jsonb_set(jsonb_set(record,'{status}',to_jsonb($3::text),true),'{error}',COALESCE($4,'null'::jsonb),true),'{updated}',to_jsonb(NOW()),true),updated=NOW(),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2"
        }
        ("tamoss_object_cleanups", false) => {
            "UPDATE tamoss_object_cleanups SET status=$3,claimed_at=NULL,claimed_by=NULL,record=jsonb_set(jsonb_set(jsonb_set(record,'{status}',to_jsonb($3::text),true),'{error}',COALESCE($4,'null'::jsonb),true),'{updated}',to_jsonb(NOW()),true),updated=NOW(),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2"
        }
        ("tamoss_object_copies", true) => {
            "UPDATE tamoss_object_copies SET status=$3,claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=jsonb_set(jsonb_set(jsonb_set(record,'{status}',to_jsonb($3::text),true),'{error}',COALESCE($4,'null'::jsonb),true),'{updated}',to_jsonb(NOW()),true),updated=NOW(),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2"
        }
        ("tamoss_object_copies", false) => {
            "UPDATE tamoss_object_copies SET status=$3,claimed_at=NULL,claimed_by=NULL,record=jsonb_set(jsonb_set(jsonb_set(record,'{status}',to_jsonb($3::text),true),'{error}',COALESCE($4,'null'::jsonb),true),'{updated}',to_jsonb(NOW()),true),updated=NOW(),updated_at=NOW() WHERE id=$1 AND status='started' AND claimed_by=$2"
        }
        _ => return Err(DbError::Record("unknown queue".into())),
    };
    Ok(sqlx::query(sql)
        .bind(id)
        .bind(worker)
        .bind(status)
        .bind(error.map(sqlx::types::Json))
        .execute(pool)
        .await?
        .rows_affected()
        == 1)
}
pub async fn purge(pool: &PgPool, retention_seconds: i64, limit: i64) -> Result<u64, DbError> {
    if retention_seconds <= 0 || limit < 1 {
        return Ok(0);
    }
    let mut total = 0;
    for sql in [
        "WITH target AS(SELECT id FROM tamoss_webhook_deliveries WHERE status=ANY(ARRAY['done','dead'])AND updated_at<NOW()-($1*INTERVAL '1 second') ORDER BY updated_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)DELETE FROM tamoss_webhook_deliveries q USING target WHERE q.id=target.id",
        "WITH target AS(SELECT id FROM tamoss_delete_requests WHERE status='done' AND updated_at<NOW()-($1*INTERVAL '1 second') ORDER BY updated_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)DELETE FROM tamoss_delete_requests q USING target WHERE q.id=target.id",
        "WITH target AS(SELECT id FROM tamoss_object_cleanups WHERE status='done' AND updated_at<NOW()-($1*INTERVAL '1 second') ORDER BY updated_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)DELETE FROM tamoss_object_cleanups q USING target WHERE q.id=target.id",
        "WITH target AS(SELECT id FROM tamoss_object_copies WHERE status='done' AND updated_at<NOW()-($1*INTERVAL '1 second') ORDER BY updated_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)DELETE FROM tamoss_object_copies q USING target WHERE q.id=target.id",
    ] {
        total += sqlx::query(sql)
            .bind(retention_seconds)
            .bind(limit.min(1000))
            .execute(pool)
            .await?
            .rows_affected()
    }
    Ok(total)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteRequestSort {
    Created,
    Expiry,
}

pub async fn get_delete_request(pool: &PgPool, id: Uuid) -> Result<Option<DeleteRequest>, DbError> {
    sqlx::query("SELECT id,flow_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at FROM tamoss_delete_requests WHERE id=$1").bind(id).fetch_optional(pool).await?.map(map_delete).transpose()
}

pub async fn list_delete_requests(
    pool: &PgPool,
    sort: DeleteRequestSort,
    reverse: bool,
    retention_seconds: i64,
    page: &PageRequest,
) -> Result<Page<DeleteRequest>, DbError> {
    let value = match sort {
        DeleteRequestSort::Created => "created_at",
        DeleteRequestSort::Expiry if retention_seconds > 0 => {
            "CASE WHEN status='done' THEN updated END"
        }
        DeleteRequestSort::Expiry => "NULL::timestamptz",
    };
    let order = if reverse {
        format!("{value} ASC NULLS FIRST,id ASC")
    } else {
        format!("{value} DESC NULLS LAST,id DESC")
    };
    let query = format!(
        "SELECT id,flow_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at FROM tamoss_delete_requests ORDER BY {order} OFFSET $1 LIMIT $2"
    );
    Ok(finish_page(
        sqlx::query(&query)
            .bind(page.offset)
            .bind(page.limit + 1)
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(map_delete)
            .collect::<Result<_, _>>()?,
        page,
    ))
}

pub async fn get_webhook_delivery(
    pool: &PgPool,
    id: Uuid,
) -> Result<Option<WebhookDelivery>, DbError> {
    sqlx::query("SELECT id,webhook_id,status,next_attempt_at,record,created_at,updated_at,claimed_at,claimed_by,claim_expires_at FROM tamoss_webhook_deliveries WHERE id=$1").bind(id).fetch_optional(pool).await?.map(map_webhook).transpose()
}

pub async fn list_object_copies(
    pool: &PgPool,
    statuses: Option<&[String]>,
) -> Result<Vec<ObjectCopy>, DbError> {
    match statuses{
        Some(statuses)=>sqlx::query("SELECT id,object_id,source_storage_backend_id,destination_storage_backend_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at FROM tamoss_object_copies WHERE status=ANY($1) ORDER BY created_at,id").bind(statuses).fetch_all(pool).await?.into_iter().map(map_copy).collect(),
        None=>sqlx::query("SELECT id,object_id,source_storage_backend_id,destination_storage_backend_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at FROM tamoss_object_copies ORDER BY created_at,id").fetch_all(pool).await?.into_iter().map(map_copy).collect(),
    }
}

fn map_delete(r: PgRow) -> Result<DeleteRequest, DbError> {
    Ok(DeleteRequest {
        id: r.try_get(0)?,
        flow_id: r.try_get(1)?,
        status: r.try_get(2)?,
        record: r.try_get::<sqlx::types::Json<Value>, _>(3)?.0,
        updated: r.try_get(4)?,
        created_at: r.try_get(5)?,
        claimed_at: r.try_get(6)?,
        claimed_by: r.try_get(7)?,
        claim_expires_at: r.try_get(8)?,
    })
}
fn map_cleanup(r: PgRow) -> Result<ObjectCleanup, DbError> {
    Ok(ObjectCleanup {
        id: r.try_get(0)?,
        delete_request_id: r.try_get(1)?,
        object_id: r.try_get(2)?,
        storage_backend_id: r.try_get(3)?,
        status: r.try_get(4)?,
        record: r.try_get::<sqlx::types::Json<Value>, _>(5)?.0,
        updated: r.try_get(6)?,
        created_at: r.try_get(7)?,
        claimed_at: r.try_get(8)?,
        claimed_by: r.try_get(9)?,
        claim_expires_at: r.try_get(10)?,
    })
}
fn map_copy(r: PgRow) -> Result<ObjectCopy, DbError> {
    Ok(ObjectCopy {
        id: r.try_get(0)?,
        object_id: r.try_get(1)?,
        source_storage_backend_id: r.try_get(2)?,
        destination_storage_backend_id: r.try_get(3)?,
        status: r.try_get(4)?,
        record: r.try_get::<sqlx::types::Json<Value>, _>(5)?.0,
        updated: r.try_get(6)?,
        created_at: r.try_get(7)?,
        claimed_at: r.try_get(8)?,
        claimed_by: r.try_get(9)?,
        claim_expires_at: r.try_get(10)?,
    })
}
fn map_webhook(r: PgRow) -> Result<WebhookDelivery, DbError> {
    Ok(WebhookDelivery {
        id: r.try_get(0)?,
        webhook_id: r.try_get(1)?,
        status: r.try_get(2)?,
        next_attempt_at: r.try_get(3)?,
        record: r.try_get::<sqlx::types::Json<Value>, _>(4)?.0,
        created_at: r.try_get(5)?,
        updated_at: r.try_get(6)?,
        claimed_at: r.try_get(7)?,
        claimed_by: r.try_get(8)?,
        claim_expires_at: r.try_get(9)?,
    })
}
