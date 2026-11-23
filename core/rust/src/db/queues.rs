// TASM adaptation of rust-tams-api (Apache-2.0), shared by the browser and
// Cloudflare adapters through their db::dialect modules; see NOTICE.
// Claims, attempts, transitions and purges stay engine-specific in each
// adapter's db/statements.rs: Postgres claims with FOR UPDATE SKIP LOCKED and
// edits JSONB, the Durable Object claims with UPDATE ... RETURNING and edits
// JSON text, and the two engines express interval arithmetic differently.
use super::dialect::{self, Engine, NOW, Pool, RecordRow, sqlx};
use super::statements;
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

use super::{
    DbError,
    records::{
        DeleteRequest, ObjectCleanup, ObjectCopy, Page, PageRequest, WebhookDelivery, finish_page,
    },
};

/// SQLite does not order `UPDATE ... RETURNING` rows, so restore queue order on both engines.
fn claimed_in_order<T: Queued>(mut rows: Vec<T>) -> Vec<T> {
    rows.sort_by_key(|row| row.queue_key());
    rows
}
trait Queued {
    fn queue_key(&self) -> (time::OffsetDateTime, Uuid);
}
macro_rules! queued {
    ($($record:ty),*) => {$(
        impl Queued for $record {
            fn queue_key(&self) -> (time::OffsetDateTime, Uuid) {
                (self.created_at, self.id)
            }
        }
    )*};
}
queued!(DeleteRequest, ObjectCleanup, ObjectCopy, WebhookDelivery);

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
    E: sqlx::Executor<'e, Database = Engine>,
{
    dialect::query(&format!("INSERT INTO tamoss_delete_requests(id,flow_id,status,claimed_at,claimed_by,claim_expires_at,record,updated,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,{NOW})ON CONFLICT(id)DO UPDATE SET flow_id=EXCLUDED.flow_id,status=EXCLUDED.status,claimed_at=EXCLUDED.claimed_at,claimed_by=EXCLUDED.claimed_by,claim_expires_at=EXCLUDED.claim_expires_at,record=EXCLUDED.record,updated=EXCLUDED.updated,created_at=EXCLUDED.created_at,updated_at={NOW}")).bind(v.id).bind(v.flow_id).bind(&v.status).bind(v.claimed_at).bind(&v.claimed_by).bind(v.claim_expires_at).bind(sqlx::types::Json(&v.record)).bind(v.updated).bind(v.created_at).execute(e).await?;
    Ok(())
}
pub async fn claim_delete_requests(
    pool: &Pool,
    worker: &str,
    limit: i64,
    lease: i64,
) -> Result<Vec<DeleteRequest>, DbError> {
    let (limit, lease) = claim_bounds(limit, lease)?;
    sqlx::query(statements::CLAIM_DELETE_REQUESTS)
        .bind(limit)
        .bind(worker)
        .bind(lease)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(map_delete)
        .collect::<Result<Vec<_>, _>>()
        .map(claimed_in_order)
}
pub async fn fail_delete_request(
    pool: &Pool,
    id: Uuid,
    worker: &str,
    error: Value,
    ready_at: Option<String>,
) -> Result<bool, DbError> {
    Ok(sqlx::query(statements::FAIL_DELETE_REQUEST)
        .bind(id)
        .bind(worker)
        .bind(sqlx::types::Json(error))
        .bind(ready_at)
        .execute(pool)
        .await?
        .rows_affected()
        == 1)
}
pub async fn release_delete_request(
    pool: &Pool,
    id: Uuid,
    worker: &str,
    ready_at: Option<String>,
) -> Result<bool, DbError> {
    Ok(sqlx::query(statements::RELEASE_DELETE_REQUEST)
        .bind(id)
        .bind(worker)
        .bind(ready_at)
        .execute(pool)
        .await?
        .rows_affected()
        == 1)
}
pub async fn complete_delete_request(pool: &Pool, id: Uuid, worker: &str) -> Result<bool, DbError> {
    Ok(sqlx::query(statements::COMPLETE_DELETE_REQUEST)
        .bind(id)
        .bind(worker)
        .execute(pool)
        .await?
        .rows_affected()
        == 1)
}

pub async fn save_cleanup<'e, E>(e: E, v: &ObjectCleanup) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    dialect::query(&format!("INSERT INTO tamoss_object_cleanups(id,delete_request_id,object_id,storage_backend_id,status,claimed_at,claimed_by,claim_expires_at,record,updated,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,{NOW})ON CONFLICT(id)DO UPDATE SET delete_request_id=EXCLUDED.delete_request_id,object_id=EXCLUDED.object_id,storage_backend_id=EXCLUDED.storage_backend_id,status=EXCLUDED.status,claimed_at=EXCLUDED.claimed_at,claimed_by=EXCLUDED.claimed_by,claim_expires_at=EXCLUDED.claim_expires_at,record=EXCLUDED.record,updated=EXCLUDED.updated,updated_at={NOW}")).bind(v.id).bind(v.delete_request_id).bind(&v.object_id).bind(v.storage_backend_id).bind(&v.status).bind(v.claimed_at).bind(&v.claimed_by).bind(v.claim_expires_at).bind(sqlx::types::Json(&v.record)).bind(v.updated).bind(v.created_at).execute(e).await?;
    Ok(())
}
pub async fn claim_cleanups(
    pool: &Pool,
    parent: Option<Uuid>,
    worker: &str,
    limit: i64,
    lease: i64,
) -> Result<Vec<ObjectCleanup>, DbError> {
    let (limit, lease) = claim_bounds(limit, lease)?;
    sqlx::query(statements::CLAIM_CLEANUPS)
        .bind(limit)
        .bind(worker)
        .bind(lease)
        .bind(parent)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(map_cleanup)
        .collect::<Result<Vec<_>, _>>()
        .map(claimed_in_order)
}
/// Keep the database deadline at its stored precision across the JavaScript bridge.
pub async fn next_unfinished_cleanup(
    pool: &Pool,
    parent: Uuid,
) -> Result<Option<(String, Option<String>)>, DbError> {
    let row = dialect::query(
        "SELECT status, CAST(claim_expires_at AS TEXT) AS deadline
         FROM tamoss_object_cleanups WHERE delete_request_id=$1 AND status<>'done'
         ORDER BY claim_expires_at NULLS FIRST LIMIT 1",
    )
    .bind(parent)
    .fetch_optional(pool)
    .await?;
    row.map(|row| Ok((row.try_get(0)?, row.try_get(1)?)))
        .transpose()
}
pub async fn begin_cleanup_attempt(pool: &Pool, id: Uuid, worker: &str) -> Result<bool, DbError> {
    begin_attempt(pool, statements::BEGIN_CLEANUP_ATTEMPT, id, worker).await
}
pub async fn fail_cleanup(
    pool: &Pool,
    id: Uuid,
    worker: &str,
    error: Value,
) -> Result<bool, DbError> {
    finish_attempt(
        pool,
        statements::FINISH_CLEANUP_WITH_BACKOFF,
        id,
        worker,
        "error",
        Some(error),
    )
    .await
}
pub async fn complete_cleanup(pool: &Pool, id: Uuid, worker: &str) -> Result<bool, DbError> {
    finish_attempt(pool, statements::FINISH_CLEANUP, id, worker, "done", None).await
}

pub async fn enqueue_copy<'e, E>(
    executor: E,
    object: &super::MediaObjectRecord,
    source: Uuid,
    destination: Uuid,
) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    let now = crate::now();
    let stamp = crate::domain::model::timestamp(now);
    let record = serde_json::json!({
        "object_id":object.id, "source_storage_backend_id":source,
        "destination_storage_backend_id":destination, "status":"pending",
        "allocation_id":object.record.get("allocation_id"), "attempt_count":0,
        "error":null, "created":stamp, "updated":stamp
    });
    dialect::query(&format!("INSERT INTO tamoss_object_copies
        (id,object_id,source_storage_backend_id,destination_storage_backend_id,status,record,updated,created_at,updated_at)
        SELECT $1,$2,$3,$4,'pending',$5,$6,$6,{NOW}
        WHERE NOT EXISTS (SELECT 1 FROM tamoss_object_copies
            WHERE object_id=$2 AND source_storage_backend_id=$3 AND destination_storage_backend_id=$4
            AND status IN ('pending','started','error') AND created_at >= $7
            AND COALESCE(record->>'allocation_id','')=COALESCE($8,''))"))
        .bind(Uuid::new_v4()).bind(&object.id).bind(source).bind(destination)
        .bind(sqlx::types::Json(record)).bind(now).bind(object.created_at)
        .bind(object.record["allocation_id"].as_str().map(str::to_owned))
        .execute(executor).await?;
    Ok(())
}

pub async fn owns_copy<'e, E>(executor: E, copy: &ObjectCopy) -> Result<bool, DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    Ok(dialect::query(&format!("SELECT 1 FROM tamoss_object_copies
        WHERE id=$1 AND status='started' AND claimed_by=$2 AND claimed_at=$3 AND claim_expires_at>{NOW}"))
        .bind(copy.id).bind(&copy.claimed_by).bind(copy.claimed_at)
        .fetch_optional(executor).await?.is_some())
}
pub async fn claim_copies(
    pool: &Pool,
    worker: &str,
    limit: i64,
    lease: i64,
) -> Result<Vec<ObjectCopy>, DbError> {
    let (limit, lease) = claim_bounds(limit, lease)?;
    sqlx::query(statements::CLAIM_COPIES)
        .bind(limit)
        .bind(worker)
        .bind(lease)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(map_copy)
        .collect::<Result<Vec<_>, _>>()
        .map(claimed_in_order)
}
pub async fn begin_copy_attempt(pool: &Pool, id: Uuid, worker: &str) -> Result<bool, DbError> {
    begin_attempt(pool, statements::BEGIN_COPY_ATTEMPT, id, worker).await
}
pub async fn fail_copy(pool: &Pool, id: Uuid, worker: &str, error: Value) -> Result<bool, DbError> {
    finish_attempt(
        pool,
        statements::FINISH_COPY_WITH_BACKOFF,
        id,
        worker,
        "error",
        Some(error),
    )
    .await
}
pub async fn complete_copy(pool: &Pool, id: Uuid, worker: &str) -> Result<bool, DbError> {
    finish_attempt(pool, statements::FINISH_COPY, id, worker, "done", None).await
}

pub async fn save_webhook_delivery<'e, E>(e: E, v: &WebhookDelivery) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    dialect::query(&format!("INSERT INTO tamoss_webhook_deliveries(id,webhook_id,status,next_attempt_at,claimed_at,claimed_by,claim_expires_at,record,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,{NOW})ON CONFLICT(id)DO UPDATE SET webhook_id=EXCLUDED.webhook_id,status=EXCLUDED.status,next_attempt_at=EXCLUDED.next_attempt_at,claimed_at=EXCLUDED.claimed_at,claimed_by=EXCLUDED.claimed_by,claim_expires_at=EXCLUDED.claim_expires_at,record=EXCLUDED.record,updated_at={NOW}")).bind(v.id).bind(v.webhook_id).bind(&v.status).bind(v.next_attempt_at).bind(v.claimed_at).bind(&v.claimed_by).bind(v.claim_expires_at).bind(sqlx::types::Json(&v.record)).bind(v.created_at).execute(e).await?;
    Ok(())
}
pub async fn claim_webhooks(
    pool: &Pool,
    worker: &str,
    limit: i64,
    lease: i64,
) -> Result<Vec<WebhookDelivery>, DbError> {
    let (limit, lease) = claim_bounds(limit, lease)?;
    sqlx::query(statements::CLAIM_WEBHOOKS)
        .bind(limit)
        .bind(worker)
        .bind(lease)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(map_webhook)
        .collect::<Result<Vec<_>, _>>()
        .map(claimed_in_order)
}
pub async fn begin_webhook_attempt(pool: &Pool, id: Uuid, worker: &str) -> Result<bool, DbError> {
    Ok(sqlx::query(statements::BEGIN_WEBHOOK_ATTEMPT)
        .bind(id)
        .bind(worker)
        .execute(pool)
        .await?
        .rows_affected()
        == 1)
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
    Ok(sqlx::query(statements::RETRY_WEBHOOK)
        .bind(id)
        .bind(worker)
        .bind(delay_seconds)
        .bind(response)
        .bind(error.map(sqlx::types::Json))
        .execute(pool)
        .await?
        .rows_affected()
        == 1)
}
pub async fn retire_webhooks<'e, E>(executor: E, id: Uuid) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    sqlx::query(statements::RETIRE_WEBHOOKS)
        .bind(id)
        .bind(sqlx::types::Json(crate::webhooks::destination_changed()))
        .execute(executor)
        .await?;
    Ok(())
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
    Ok(sqlx::query(statements::FINISH_WEBHOOK)
        .bind(id)
        .bind(worker)
        .bind(status)
        .bind(response)
        .bind(error.map(sqlx::types::Json))
        .execute(pool)
        .await?
        .rows_affected()
        == 1)
}

async fn begin_attempt(
    pool: &Pool,
    sql: &'static str,
    id: Uuid,
    worker: &str,
) -> Result<bool, DbError> {
    Ok(sqlx::query(sql)
        .bind(id)
        .bind(worker)
        .execute(pool)
        .await?
        .rows_affected()
        == 1)
}
async fn finish_attempt(
    pool: &Pool,
    sql: &'static str,
    id: Uuid,
    worker: &str,
    status: &str,
    error: Option<Value>,
) -> Result<bool, DbError> {
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
        statements::PURGE_WEBHOOK_DELIVERIES,
        statements::PURGE_DELETE_REQUESTS,
        statements::PURGE_OBJECT_CLEANUPS,
        statements::PURGE_OBJECT_COPIES,
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
    dialect::query("SELECT id,flow_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at FROM tamoss_delete_requests WHERE id=$1").bind(id).fetch_optional(pool).await?.map(map_delete).transpose()
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
        DeleteRequestSort::Expiry => dialect::NULL_TIMESTAMP,
    };
    let order = if reverse {
        format!("{value} ASC NULLS FIRST,id ASC")
    } else {
        format!("{value} DESC NULLS LAST,id DESC")
    };
    let query = format!(
        "SELECT id,flow_id,status,record,updated,created_at,claimed_at,claimed_by,claim_expires_at FROM tamoss_delete_requests ORDER BY {order} LIMIT $2 OFFSET $1"
    );
    Ok(finish_page(
        dialect::query(&query)
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

fn map_delete(r: RecordRow) -> Result<DeleteRequest, DbError> {
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
fn map_cleanup(r: RecordRow) -> Result<ObjectCleanup, DbError> {
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
fn map_copy(r: RecordRow) -> Result<ObjectCopy, DbError> {
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
fn map_webhook(r: RecordRow) -> Result<WebhookDelivery, DbError> {
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
