// TASM adaptation of rust-tams-api (Apache-2.0), shared by the browser and
// Cloudflare adapters through their db::dialect modules; see NOTICE.
pub(crate) use super::dialect::append_tags;
use super::dialect::{self, Engine, NOW, RecordRow, WEBHOOK_HAS_EVENT, sqlx};
use serde_json::Value;
use sqlx::{QueryBuilder, Row};
use uuid::Uuid;

use super::{
    DbError,
    records::{
        Page, PageRequest, ServiceMetadata, StorageBackend, TagFilters, Tags, WebhookRecord,
        finish_page,
    },
};

pub async fn get_metadata(pool: &sqlx::Pool) -> Result<Option<ServiceMetadata>, DbError> {
    let row = dialect::query(
        "SELECT name, description FROM tamoss_service_metadata WHERE id = 'default'",
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| ServiceMetadata {
        name: r.get(0),
        description: r.get(1),
    }))
}
pub async fn save_metadata<'e, E>(executor: E, value: &ServiceMetadata) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    dialect::query(&format!("INSERT INTO tamoss_service_metadata(id,name,description,updated_at) VALUES ('default',$1,$2,{NOW}) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,updated_at={NOW}"))
        .bind(&value.name).bind(&value.description).execute(executor).await?;
    Ok(())
}
pub async fn get_storage_backend(
    pool: &sqlx::Pool,
    id: Uuid,
) -> Result<Option<StorageBackend>, DbError> {
    dialect::query("SELECT id,label,provider,region,store_product,store_type,default_storage,bucket_name,endpoint_url,public_endpoint_url,tags,record FROM tamoss_storage_backends WHERE id=$1").bind(id).fetch_optional(pool).await?.map(map_backend).transpose()
}
pub async fn default_storage_backend(pool: &sqlx::Pool) -> Result<Option<StorageBackend>, DbError> {
    dialect::query("SELECT id,label,provider,region,store_product,store_type,default_storage,bucket_name,endpoint_url,public_endpoint_url,tags,record FROM tamoss_storage_backends WHERE default_storage IS TRUE").fetch_optional(pool).await?.map(map_backend).transpose()
}
pub async fn list_storage_backends(
    pool: &sqlx::Pool,
    filters: &TagFilters,
    reverse: bool,
    page: &PageRequest,
) -> Result<Page<StorageBackend>, DbError> {
    let mut q = QueryBuilder::<Engine>::new(
        "SELECT id,label,provider,region,store_product,store_type,default_storage,bucket_name,endpoint_url,public_endpoint_url,tags,record FROM tamoss_storage_backends backend",
    );
    append_tags(&mut q, "backend.tags", filters, false);
    q.push(if reverse {
        " ORDER BY label DESC,id DESC"
    } else {
        " ORDER BY label ASC,id ASC"
    });
    q.push(" LIMIT ")
        .push_bind(page.limit + 1)
        .push(" OFFSET ")
        .push_bind(page.offset);
    Ok(finish_page(
        q.build()
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(map_backend)
            .collect::<Result<_, _>>()?,
        page,
    ))
}
fn map_backend(r: RecordRow) -> Result<StorageBackend, DbError> {
    Ok(StorageBackend {
        id: r.try_get(0)?,
        label: r.try_get(1)?,
        provider: r.try_get(2)?,
        region: r.try_get(3)?,
        store_product: r.try_get(4)?,
        store_type: r.try_get(5)?,
        default_storage: r.try_get(6)?,
        bucket_name: r.try_get(7)?,
        endpoint_url: r.try_get(8)?,
        public_endpoint_url: r.try_get(9)?,
        tags: r.try_get::<sqlx::types::Json<Tags>, _>(10)?.0,
        record: r.try_get::<sqlx::types::Json<Value>, _>(11)?.0,
    })
}

pub async fn get_webhook(pool: &sqlx::Pool, id: Uuid) -> Result<Option<WebhookRecord>, DbError> {
    get_webhook_with(pool, id).await
}

pub async fn get_webhook_with<'e, E>(
    executor: E,
    id: Uuid,
) -> Result<Option<WebhookRecord>, DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    dialect::query("SELECT id,status,tags,record FROM tamoss_webhooks WHERE id=$1")
        .bind(id)
        .fetch_optional(executor)
        .await?
        .map(map_webhook)
        .transpose()
}
pub async fn list_webhooks(
    pool: &sqlx::Pool,
    filters: &TagFilters,
    reverse: bool,
    page: &PageRequest,
) -> Result<Page<WebhookRecord>, DbError> {
    let mut q =
        QueryBuilder::<Engine>::new("SELECT id,status,tags,record FROM tamoss_webhooks webhook");
    append_tags(&mut q, "webhook.tags", filters, false);
    q.push(if reverse {
        " ORDER BY record->'data'->>'url' DESC,id DESC"
    } else {
        " ORDER BY record->'data'->>'url' ASC,id ASC"
    })
    .push(" LIMIT ")
    .push_bind(page.limit + 1)
    .push(" OFFSET ")
    .push_bind(page.offset);
    Ok(finish_page(
        q.build()
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(map_webhook)
            .collect::<Result<_, _>>()?,
        page,
    ))
}

pub async fn active_webhooks_for_event<'e, E>(
    executor: E,
    event: &str,
) -> Result<Vec<WebhookRecord>, DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    dialect::query(&format!("SELECT id,status,tags,record FROM tamoss_webhooks WHERE status IN ('created','started') AND {WEBHOOK_HAS_EVENT} ORDER BY id"))
        .bind(event)
        .fetch_all(executor)
        .await?
        .into_iter()
        .map(map_webhook)
        .collect()
}
pub async fn save_webhook<'e, E>(e: E, v: &WebhookRecord) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    dialect::query(&format!("INSERT INTO tamoss_webhooks(id,status,tags,record,updated_at)VALUES($1,$2,$3,$4,{NOW})ON CONFLICT(id)DO UPDATE SET status=EXCLUDED.status,tags=EXCLUDED.tags,record=EXCLUDED.record,updated_at={NOW}")).bind(v.id).bind(&v.status).bind(sqlx::types::Json(&v.tags)).bind(sqlx::types::Json(&v.record)).execute(e).await?;
    Ok(())
}
pub async fn delete_webhook<'e, E>(e: E, id: Uuid) -> Result<bool, DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    Ok(dialect::query("DELETE FROM tamoss_webhooks WHERE id=$1")
        .bind(id)
        .execute(e)
        .await?
        .rows_affected()
        == 1)
}
fn map_webhook(r: RecordRow) -> Result<WebhookRecord, DbError> {
    Ok(WebhookRecord {
        id: r.try_get(0)?,
        status: r.try_get(1)?,
        tags: r.try_get::<sqlx::types::Json<Tags>, _>(2)?.0,
        record: r.try_get::<sqlx::types::Json<Value>, _>(3)?.0,
    })
}
