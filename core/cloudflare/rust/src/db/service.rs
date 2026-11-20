// Cloudflare adaptation of TASM and rust-tams-api (Apache-2.0); see NOTICE.
use crate::sqlite as sqlx;
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Row, Sqlite, SqliteRow};
use uuid::Uuid;

use super::{
    DbError,
    records::{
        Page, PageRequest, ServiceMetadata, StorageBackend, TagFilters, Tags, WebhookRecord,
        finish_page,
    },
};

pub async fn get_metadata(pool: &sqlx::Pool) -> Result<Option<ServiceMetadata>, DbError> {
    let row =
        sqlx::query("SELECT name, description FROM tamoss_service_metadata WHERE id = 'default'")
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|r| ServiceMetadata {
        name: r.get(0),
        description: r.get(1),
    }))
}
pub async fn save_metadata<'e, E>(executor: E, value: &ServiceMetadata) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Sqlite>,
{
    sqlx::query("INSERT INTO tamoss_service_metadata(id,name,description,updated_at) VALUES ('default',?1,?2,(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')")
        .bind(&value.name).bind(&value.description).execute(executor).await?;
    Ok(())
}
pub async fn get_storage_backend(
    pool: &sqlx::Pool,
    id: Uuid,
) -> Result<Option<StorageBackend>, DbError> {
    sqlx::query("SELECT id,label,provider,region,store_product,store_type,default_storage,bucket_name,endpoint_url,public_endpoint_url,tags,record FROM tamoss_storage_backends WHERE id=?1").bind(id).fetch_optional(pool).await?.map(map_backend).transpose()
}
pub async fn default_storage_backend(pool: &sqlx::Pool) -> Result<Option<StorageBackend>, DbError> {
    sqlx::query("SELECT id,label,provider,region,store_product,store_type,default_storage,bucket_name,endpoint_url,public_endpoint_url,tags,record FROM tamoss_storage_backends WHERE default_storage IS TRUE").fetch_optional(pool).await?.map(map_backend).transpose()
}
pub async fn list_storage_backends(
    pool: &sqlx::Pool,
    filters: &TagFilters,
    reverse: bool,
    page: &PageRequest,
) -> Result<Page<StorageBackend>, DbError> {
    let mut q = QueryBuilder::<Sqlite>::new(
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
pub async fn save_storage_backend<'e, E>(executor: E, b: &StorageBackend) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Sqlite>,
{
    let record = if b.record.is_null() {
        json!({"id":b.id,"label":b.label,"provider":b.provider,"region":b.region,"store_product":b.store_product,"store_type":b.store_type,"default_storage":b.default_storage,"bucket_name":b.bucket_name,"endpoint_url":b.endpoint_url,"public_endpoint_url":b.public_endpoint_url,"tags":b.tags})
    } else {
        b.record.clone()
    };
    sqlx::query("INSERT INTO tamoss_storage_backends(id,label,provider,region,store_product,store_type,default_storage,bucket_name,endpoint_url,public_endpoint_url,tags,record,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')) ON CONFLICT(id) DO UPDATE SET label=EXCLUDED.label,provider=EXCLUDED.provider,region=EXCLUDED.region,store_product=EXCLUDED.store_product,store_type=EXCLUDED.store_type,default_storage=EXCLUDED.default_storage,bucket_name=EXCLUDED.bucket_name,endpoint_url=EXCLUDED.endpoint_url,public_endpoint_url=EXCLUDED.public_endpoint_url,tags=EXCLUDED.tags,record=EXCLUDED.record,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')")
    .bind(b.id).bind(&b.label).bind(&b.provider).bind(&b.region).bind(&b.store_product).bind(&b.store_type).bind(b.default_storage).bind(&b.bucket_name).bind(&b.endpoint_url).bind(&b.public_endpoint_url).bind(sqlx::types::Json(&b.tags)).bind(sqlx::types::Json(record)).execute(executor).await?;
    Ok(())
}
fn map_backend(r: SqliteRow) -> Result<StorageBackend, DbError> {
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
    E: sqlx::Executor<'e, Database = Sqlite>,
{
    sqlx::query("SELECT id,status,tags,record FROM tamoss_webhooks WHERE id=?1")
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
        QueryBuilder::<Sqlite>::new("SELECT id,status,tags,record FROM tamoss_webhooks webhook");
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
    E: sqlx::Executor<'e, Database = Sqlite>,
{
    sqlx::query("SELECT id,status,tags,record FROM tamoss_webhooks WHERE status IN ('created','started') AND EXISTS(SELECT 1 FROM json_each(record, '$.data.events') WHERE value=?1) ORDER BY id")
        .bind(event)
        .fetch_all(executor)
        .await?
        .into_iter()
        .map(map_webhook)
        .collect()
}
pub async fn save_webhook<'e, E>(e: E, v: &WebhookRecord) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Sqlite>,
{
    sqlx::query("INSERT INTO tamoss_webhooks(id,status,tags,record,updated_at)VALUES(?1,?2,?3,?4,(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'))ON CONFLICT(id)DO UPDATE SET status=EXCLUDED.status,tags=EXCLUDED.tags,record=EXCLUDED.record,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')").bind(v.id).bind(&v.status).bind(sqlx::types::Json(&v.tags)).bind(sqlx::types::Json(&v.record)).execute(e).await?;
    Ok(())
}
pub async fn delete_webhook<'e, E>(e: E, id: Uuid) -> Result<bool, DbError>
where
    E: sqlx::Executor<'e, Database = Sqlite>,
{
    Ok(sqlx::query("DELETE FROM tamoss_webhooks WHERE id=?1")
        .bind(id)
        .execute(e)
        .await?
        .rows_affected()
        == 1)
}
fn map_webhook(r: SqliteRow) -> Result<WebhookRecord, DbError> {
    Ok(WebhookRecord {
        id: r.try_get(0)?,
        status: r.try_get(1)?,
        tags: r.try_get::<sqlx::types::Json<Tags>, _>(2)?.0,
        record: r.try_get::<sqlx::types::Json<Value>, _>(3)?.0,
    })
}

pub(crate) fn append_tags<'a>(
    q: &mut QueryBuilder<'a, Sqlite>,
    column: &str,
    filters: &'a TagFilters,
    has_where: bool,
) {
    let mut has_where = has_where;
    for (name, values) in &filters.values {
        q.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        let values: Vec<_> = values.iter().cloned().collect();
        q.push("EXISTS(SELECT 1 FROM json_each(").push(column).push(") tag WHERE tag.key=").push_bind(name)
            .push(" AND ((tag.type='text' AND tag.value IN (SELECT value FROM json_each(").push_bind(&values)
            .push("))) OR (tag.type='array' AND EXISTS(SELECT 1 FROM json_each(CASE WHEN tag.type='array' THEN tag.value ELSE '[]' END) item WHERE item.type='text' AND item.value IN (SELECT value FROM json_each(").push_bind(&values).push("))))))");
    }
    for (name, exists) in &filters.exists {
        q.push(if has_where { " AND " } else { " WHERE " });
        has_where = true;
        if !exists {
            q.push("NOT ");
        }
        q.push("EXISTS(SELECT 1 FROM json_each(")
            .push(column)
            .push(") tag WHERE tag.key=")
            .push_bind(name)
            .push(")");
    }
}
