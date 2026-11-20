// Cloudflare adaptation of TASM and rust-tams-api (Apache-2.0); see NOTICE.
use crate::sqlite as sqlx;
use serde_json::Value;
use sqlx::{Pool, Row, Sqlite, SqliteRow};
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
    E: sqlx::Executor<'e, Database = Sqlite>,
{
    sqlx::query("INSERT INTO tamoss_delete_requests(id,flow_id,status,claimed_at,claimed_by,claim_expires_at,record,updated,created_at,updated_at)VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'))ON CONFLICT(id)DO UPDATE SET flow_id=EXCLUDED.flow_id,status=EXCLUDED.status,claimed_at=EXCLUDED.claimed_at,claimed_by=EXCLUDED.claimed_by,claim_expires_at=EXCLUDED.claim_expires_at,record=EXCLUDED.record,updated=EXCLUDED.updated,created_at=EXCLUDED.created_at,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')").bind(v.id).bind(v.flow_id).bind(&v.status).bind(v.claimed_at).bind(&v.claimed_by).bind(v.claim_expires_at).bind(sqlx::types::Json(&v.record)).bind(v.updated).bind(v.created_at).execute(e).await?;
    Ok(())
}
pub async fn claim_delete_requests(
    pool: &Pool,
    worker: &str,
    limit: i64,
    lease: i64,
) -> Result<Vec<DeleteRequest>, DbError> {
    let (limit, lease) = claim_bounds(limit, lease)?;
    sqlx::query("UPDATE tamoss_delete_requests SET status='started',claimed_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),claimed_by=?2,claim_expires_at=(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',?3)) || '000000Z'),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id IN (SELECT id FROM tamoss_delete_requests WHERE status IN ('created','started','error') AND(claim_expires_at IS NULL OR claim_expires_at<=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'))ORDER BY created_at,id LIMIT ?1) RETURNING id,flow_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at").bind(limit).bind(worker).bind(lease).fetch_all(pool).await?.into_iter().map(map_delete).collect()
}
pub async fn fail_delete_request(
    pool: &Pool,
    id: Uuid,
    worker: &str,
    error: Value,
) -> Result<bool, DbError> {
    Ok(sqlx::query("UPDATE tamoss_delete_requests SET status='error',claimed_at=NULL,claimed_by=NULL,record=json_set(json_set(json_set(record,'$.status',json('\"error\"')),'$.error',json(?3)),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2").bind(id).bind(worker).bind(sqlx::types::Json(error)).execute(pool).await?.rows_affected()==1)
}
pub async fn release_delete_request(pool: &Pool, id: Uuid, worker: &str) -> Result<bool, DbError> {
    Ok(sqlx::query("UPDATE tamoss_delete_requests SET status='started',claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=json_set(json_set(record,'$.status',json('\"started\"')),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2").bind(id).bind(worker).execute(pool).await?.rows_affected()==1)
}
pub async fn complete_delete_request(pool: &Pool, id: Uuid, worker: &str) -> Result<bool, DbError> {
    Ok(sqlx::query("UPDATE tamoss_delete_requests SET status='done',claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=json_set(json_set(json_set(record,'$.status',json('\"done\"')),'$.error',json('null')),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2").bind(id).bind(worker).execute(pool).await?.rows_affected()==1)
}

pub async fn save_cleanup<'e, E>(e: E, v: &ObjectCleanup) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Sqlite>,
{
    sqlx::query("INSERT INTO tamoss_object_cleanups(id,delete_request_id,object_id,storage_backend_id,status,claimed_at,claimed_by,claim_expires_at,record,updated,created_at,updated_at)VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'))ON CONFLICT(id)DO UPDATE SET delete_request_id=EXCLUDED.delete_request_id,object_id=EXCLUDED.object_id,storage_backend_id=EXCLUDED.storage_backend_id,status=EXCLUDED.status,claimed_at=EXCLUDED.claimed_at,claimed_by=EXCLUDED.claimed_by,claim_expires_at=EXCLUDED.claim_expires_at,record=EXCLUDED.record,updated=EXCLUDED.updated,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')").bind(v.id).bind(v.delete_request_id).bind(&v.object_id).bind(v.storage_backend_id).bind(&v.status).bind(v.claimed_at).bind(&v.claimed_by).bind(v.claim_expires_at).bind(sqlx::types::Json(&v.record)).bind(v.updated).bind(v.created_at).execute(e).await?;
    Ok(())
}
pub async fn claim_cleanups(
    pool: &Pool,
    worker: &str,
    limit: i64,
    lease: i64,
) -> Result<Vec<ObjectCleanup>, DbError> {
    let (limit, lease) = claim_bounds(limit, lease)?;
    sqlx::query("UPDATE tamoss_object_cleanups SET status='started',claimed_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),claimed_by=?2,claim_expires_at=(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',?3)) || '000000Z'),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id IN (SELECT id FROM tamoss_object_cleanups WHERE delete_request_id IS NULL AND status IN ('pending','started','error') AND(claim_expires_at IS NULL OR claim_expires_at<=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'))ORDER BY created_at,id LIMIT ?1) RETURNING id,delete_request_id,object_id,storage_backend_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at").bind(limit).bind(worker).bind(lease).fetch_all(pool).await?.into_iter().map(map_cleanup).collect()
}
pub async fn list_parent_cleanups(
    pool: &Pool,
    parent: Uuid,
) -> Result<Vec<ObjectCleanup>, DbError> {
    sqlx::query("SELECT id,delete_request_id,object_id,storage_backend_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at FROM tamoss_object_cleanups WHERE delete_request_id=?1 ORDER BY created_at,id").bind(parent).fetch_all(pool).await?.into_iter().map(map_cleanup).collect()
}
pub async fn begin_cleanup_attempt(pool: &Pool, id: Uuid, worker: &str) -> Result<bool, DbError> {
    begin_attempt(pool, "tamoss_object_cleanups", id, worker).await
}
pub async fn fail_cleanup(
    pool: &Pool,
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
pub async fn complete_cleanup(pool: &Pool, id: Uuid, worker: &str) -> Result<bool, DbError> {
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
    E: sqlx::Executor<'e, Database = Sqlite>,
{
    sqlx::query("INSERT INTO tamoss_object_copies(id,object_id,source_storage_backend_id,destination_storage_backend_id,status,claimed_at,claimed_by,claim_expires_at,record,updated,created_at,updated_at)VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'))ON CONFLICT(id)DO UPDATE SET object_id=EXCLUDED.object_id,source_storage_backend_id=EXCLUDED.source_storage_backend_id,destination_storage_backend_id=EXCLUDED.destination_storage_backend_id,status=EXCLUDED.status,claimed_at=EXCLUDED.claimed_at,claimed_by=EXCLUDED.claimed_by,claim_expires_at=EXCLUDED.claim_expires_at,record=EXCLUDED.record,updated=EXCLUDED.updated,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')").bind(v.id).bind(&v.object_id).bind(v.source_storage_backend_id).bind(v.destination_storage_backend_id).bind(&v.status).bind(v.claimed_at).bind(&v.claimed_by).bind(v.claim_expires_at).bind(sqlx::types::Json(&v.record)).bind(v.updated).bind(v.created_at).execute(e).await?;
    Ok(())
}
pub async fn claim_copies(
    pool: &Pool,
    worker: &str,
    limit: i64,
    lease: i64,
) -> Result<Vec<ObjectCopy>, DbError> {
    let (limit, lease) = claim_bounds(limit, lease)?;
    sqlx::query("UPDATE tamoss_object_copies SET status='started',claimed_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),claimed_by=?2,claim_expires_at=(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',?3)) || '000000Z'),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id IN (SELECT id FROM tamoss_object_copies WHERE status IN ('pending','started','error') AND(claim_expires_at IS NULL OR claim_expires_at<=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'))ORDER BY created_at,id LIMIT ?1) RETURNING id,object_id,source_storage_backend_id,destination_storage_backend_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at").bind(limit).bind(worker).bind(lease).fetch_all(pool).await?.into_iter().map(map_copy).collect()
}
pub async fn begin_copy_attempt(pool: &Pool, id: Uuid, worker: &str) -> Result<bool, DbError> {
    begin_attempt(pool, "tamoss_object_copies", id, worker).await
}
pub async fn fail_copy(pool: &Pool, id: Uuid, worker: &str, error: Value) -> Result<bool, DbError> {
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
pub async fn complete_copy(pool: &Pool, id: Uuid, worker: &str) -> Result<bool, DbError> {
    finish_simple(pool, "tamoss_object_copies", id, worker, "done", None, true).await
}

pub async fn save_webhook_delivery<'e, E>(e: E, v: &WebhookDelivery) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Sqlite>,
{
    sqlx::query("INSERT INTO tamoss_webhook_deliveries(id,webhook_id,status,next_attempt_at,claimed_at,claimed_by,claim_expires_at,record,created_at,updated_at)VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'))ON CONFLICT(id)DO UPDATE SET webhook_id=EXCLUDED.webhook_id,status=EXCLUDED.status,next_attempt_at=EXCLUDED.next_attempt_at,claimed_at=EXCLUDED.claimed_at,claimed_by=EXCLUDED.claimed_by,claim_expires_at=EXCLUDED.claim_expires_at,record=EXCLUDED.record,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')").bind(v.id).bind(v.webhook_id).bind(&v.status).bind(v.next_attempt_at).bind(v.claimed_at).bind(&v.claimed_by).bind(v.claim_expires_at).bind(sqlx::types::Json(&v.record)).bind(v.created_at).execute(e).await?;
    Ok(())
}
pub async fn claim_webhooks(
    pool: &Pool,
    worker: &str,
    limit: i64,
    lease: i64,
) -> Result<Vec<WebhookDelivery>, DbError> {
    let (limit, lease) = claim_bounds(limit, lease)?;
    sqlx::query("UPDATE tamoss_webhook_deliveries SET status='started',claimed_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),claimed_by=?2,claim_expires_at=(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',?3)) || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id IN (SELECT id FROM tamoss_webhook_deliveries WHERE status IN ('pending','started') AND(next_attempt_at IS NULL OR next_attempt_at<=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'))AND(claim_expires_at IS NULL OR claim_expires_at<=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'))ORDER BY created_at,id LIMIT ?1) RETURNING id,webhook_id,status,next_attempt_at,record,created_at,updated_at,claimed_at,claimed_by,claim_expires_at").bind(limit).bind(worker).bind(lease).fetch_all(pool).await?.into_iter().map(map_webhook).collect()
}
pub async fn begin_webhook_attempt(pool: &Pool, id: Uuid, worker: &str) -> Result<bool, DbError> {
    Ok(sqlx::query("UPDATE tamoss_webhook_deliveries SET record=json_set(json_set(record,'$.attempt_count',COALESCE((record->>'attempt_count'),0)+1),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2 AND claim_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')").bind(id).bind(worker).execute(pool).await?.rows_affected()==1)
}
pub async fn retry_webhook(
    pool: &Pool,
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
    Ok(sqlx::query("UPDATE tamoss_webhook_deliveries SET status='pending',next_attempt_at=(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',?3)) || '000000Z'),claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=json_set(json_set(json_set(json_set(json_set(record,'$.status',json('\"pending\"')),'$.next_attempt_at',(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',?3)) || '000000Z')),'$.response_status',json(COALESCE(?4,'null'))),'$.error',json(COALESCE(?5,'null'))),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2").bind(id).bind(worker).bind(delay_seconds).bind(response).bind(error.map(sqlx::types::Json)).execute(pool).await?.rows_affected()==1)
}
pub async fn terminal_webhook(
    pool: &Pool,
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
    Ok(sqlx::query("UPDATE tamoss_webhook_deliveries SET status=?3,next_attempt_at=NULL,claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=json_set(json_set(json_set(json_set(json_set(record,'$.status',?3),'$.next_attempt_at',json('null')),'$.response_status',json(COALESCE(?4,'null'))),'$.error',json(COALESCE(?5,'null'))),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2").bind(id).bind(worker).bind(status).bind(response).bind(error.map(sqlx::types::Json)).execute(pool).await?.rows_affected()==1)
}

async fn begin_attempt(pool: &Pool, table: &str, id: Uuid, worker: &str) -> Result<bool, DbError> {
    let sql = match table {
        "tamoss_object_cleanups" => {
            "UPDATE tamoss_object_cleanups SET record=json_set(json_set(json_set(record,'$.attempt_count',COALESCE((record->>'attempt_count'),0)+1),'$.error',json('null')),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2 AND claim_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')"
        }
        "tamoss_object_copies" => {
            "UPDATE tamoss_object_copies SET record=json_set(json_set(json_set(record,'$.attempt_count',COALESCE((record->>'attempt_count'),0)+1),'$.error',json('null')),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2 AND claim_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')"
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
    pool: &Pool,
    table: &str,
    id: Uuid,
    worker: &str,
    status: &str,
    error: Option<Value>,
    clear: bool,
) -> Result<bool, DbError> {
    let sql = match (table, clear) {
        ("tamoss_object_cleanups", true) => {
            "UPDATE tamoss_object_cleanups SET status=?3,claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=json_set(json_set(json_set(record,'$.status',?3),'$.error',json(COALESCE(?4,'null'))),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2"
        }
        ("tamoss_object_cleanups", false) => {
            "UPDATE tamoss_object_cleanups SET status=?3,claimed_at=NULL,claimed_by=NULL,record=json_set(json_set(json_set(record,'$.status',?3),'$.error',json(COALESCE(?4,'null'))),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2"
        }
        ("tamoss_object_copies", true) => {
            "UPDATE tamoss_object_copies SET status=?3,claimed_at=NULL,claimed_by=NULL,claim_expires_at=NULL,record=json_set(json_set(json_set(record,'$.status',?3),'$.error',json(COALESCE(?4,'null'))),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2"
        }
        ("tamoss_object_copies", false) => {
            "UPDATE tamoss_object_copies SET status=?3,claimed_at=NULL,claimed_by=NULL,record=json_set(json_set(json_set(record,'$.status',?3),'$.error',json(COALESCE(?4,'null'))),'$.updated',(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')),updated=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'),updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z') WHERE id=?1 AND status='started' AND claimed_by=?2"
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
pub async fn purge(pool: &Pool, retention_seconds: i64, limit: i64) -> Result<u64, DbError> {
    if retention_seconds <= 0 || limit < 1 {
        return Ok(0);
    }
    let mut total = 0;
    for sql in [
        "DELETE FROM tamoss_webhook_deliveries WHERE id IN (SELECT id FROM tamoss_webhook_deliveries WHERE status IN ('done','dead')AND updated_at<(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',-?1)) || '000000Z') ORDER BY updated_at,id LIMIT ?2)",
        "DELETE FROM tamoss_delete_requests WHERE id IN (SELECT id FROM tamoss_delete_requests WHERE status='done' AND updated_at<(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',-?1)) || '000000Z') ORDER BY updated_at,id LIMIT ?2)",
        "DELETE FROM tamoss_object_cleanups WHERE id IN (SELECT id FROM tamoss_object_cleanups WHERE status='done' AND updated_at<(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',-?1)) || '000000Z') ORDER BY updated_at,id LIMIT ?2)",
        "DELETE FROM tamoss_object_copies WHERE id IN (SELECT id FROM tamoss_object_copies WHERE status='done' AND updated_at<(strftime('%Y-%m-%dT%H:%M:%f','now',printf('%+d seconds',-?1)) || '000000Z') ORDER BY updated_at,id LIMIT ?2)",
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

pub async fn get_delete_request(pool: &Pool, id: Uuid) -> Result<Option<DeleteRequest>, DbError> {
    sqlx::query("SELECT id,flow_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at FROM tamoss_delete_requests WHERE id=?1").bind(id).fetch_optional(pool).await?.map(map_delete).transpose()
}

pub async fn list_delete_requests(
    pool: &Pool,
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
        DeleteRequestSort::Expiry => "NULL",
    };
    let order = if reverse {
        format!("{value} ASC NULLS FIRST,id ASC")
    } else {
        format!("{value} DESC NULLS LAST,id DESC")
    };
    let query = format!(
        "SELECT id,flow_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at FROM tamoss_delete_requests ORDER BY {order} LIMIT ?2 OFFSET ?1"
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
    pool: &Pool,
    id: Uuid,
) -> Result<Option<WebhookDelivery>, DbError> {
    sqlx::query("SELECT id,webhook_id,status,next_attempt_at,record,created_at,updated_at,claimed_at,claimed_by,claim_expires_at FROM tamoss_webhook_deliveries WHERE id=?1").bind(id).fetch_optional(pool).await?.map(map_webhook).transpose()
}

pub async fn list_object_copies(
    pool: &Pool,
    statuses: Option<&[String]>,
) -> Result<Vec<ObjectCopy>, DbError> {
    match statuses{
        Some(statuses)=>sqlx::query("SELECT id,object_id,source_storage_backend_id,destination_storage_backend_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at FROM tamoss_object_copies WHERE status IN (SELECT value FROM json_each(?1)) ORDER BY created_at,id").bind(statuses).fetch_all(pool).await?.into_iter().map(map_copy).collect(),
        None=>sqlx::query("SELECT id,object_id,source_storage_backend_id,destination_storage_backend_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at FROM tamoss_object_copies ORDER BY created_at,id").fetch_all(pool).await?.into_iter().map(map_copy).collect(),
    }
}

fn map_delete(r: SqliteRow) -> Result<DeleteRequest, DbError> {
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
fn map_cleanup(r: SqliteRow) -> Result<ObjectCleanup, DbError> {
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
fn map_copy(r: SqliteRow) -> Result<ObjectCopy, DbError> {
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
fn map_webhook(r: SqliteRow) -> Result<WebhookDelivery, DbError> {
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
