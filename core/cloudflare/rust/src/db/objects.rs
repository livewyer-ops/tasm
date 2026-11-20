// Cloudflare adaptation of TASM and rust-tams-api (Apache-2.0); see NOTICE.
use super::{DbError, records::MediaObjectRecord};
use crate::sqlite as sqlx;
use serde_json::Value;
use sqlx::{Pool, Row, Sqlite, SqliteRow};
use time::OffsetDateTime;
pub async fn get(pool: &Pool, id: &str) -> Result<Option<MediaObjectRecord>, DbError> {
    sqlx::query(SELECT_ONE)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .map(map)
        .transpose()
}
pub async fn get_many(pool: &Pool, ids: &[String]) -> Result<Vec<MediaObjectRecord>, DbError> {
    sqlx::query("SELECT id,first_referenced_by_flow,referenced_by_flows,object_kind,content_type,record,created_at,updated_at FROM tamoss_media_objects WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY id").bind(ids).fetch_all(pool).await?.into_iter().map(map).collect()
}
pub async fn lock_sorted(
    e: &mut sqlx::Connection,
    ids: impl IntoIterator<Item = String>,
) -> Result<(), DbError> {
    let _ = ids;
    e.0.call("transaction_check", Value::Null).await?;
    Ok(())
}
pub async fn save<'e, E>(e: E, v: &MediaObjectRecord) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Sqlite>,
{
    sqlx::query("INSERT INTO tamoss_media_objects(id,first_referenced_by_flow,referenced_by_flows,object_kind,content_type,record,created_at,updated_at)VALUES(?1,?2,?3,?4,?5,?6,?7,(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'))ON CONFLICT(id)DO UPDATE SET first_referenced_by_flow=EXCLUDED.first_referenced_by_flow,referenced_by_flows=EXCLUDED.referenced_by_flows,object_kind=EXCLUDED.object_kind,content_type=EXCLUDED.content_type,record=EXCLUDED.record,updated_at=(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')").bind(&v.id).bind(v.first_referenced_by_flow).bind(&v.referenced_by_flows).bind(&v.object_kind).bind(&v.content_type).bind(sqlx::types::Json(&v.record)).bind(v.created_at).execute(e).await?;
    Ok(())
}
pub async fn create<'e, E>(e: E, v: &MediaObjectRecord) -> Result<bool, DbError>
where
    E: sqlx::Executor<'e, Database = Sqlite>,
{
    Ok(sqlx::query("INSERT INTO tamoss_media_objects(id,first_referenced_by_flow,referenced_by_flows,object_kind,content_type,record,created_at,updated_at)VALUES(?1,?2,?3,?4,?5,?6,?7,(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z'))ON CONFLICT(id)DO NOTHING").bind(&v.id).bind(v.first_referenced_by_flow).bind(&v.referenced_by_flows).bind(&v.object_kind).bind(&v.content_type).bind(sqlx::types::Json(&v.record)).bind(v.created_at).execute(e).await?.rows_affected()==1)
}
pub async fn unreferenced_before(
    pool: &Pool,
    before: OffsetDateTime,
    limit: i64,
) -> Result<Vec<MediaObjectRecord>, DbError> {
    if limit < 1 {
        return Ok(vec![]);
    }
    sqlx::query("SELECT id,first_referenced_by_flow,referenced_by_flows,object_kind,content_type,record,created_at,updated_at FROM tamoss_media_objects WHERE json_array_length(referenced_by_flows)=0 AND created_at<?1 ORDER BY created_at,id LIMIT ?2").bind(before).bind(limit.min(1000)).fetch_all(pool).await?.into_iter().map(map).collect()
}
pub async fn delete<'e, E>(e: E, id: &str) -> Result<bool, DbError>
where
    E: sqlx::Executor<'e, Database = Sqlite>,
{
    Ok(sqlx::query("DELETE FROM tamoss_media_objects WHERE id=?1")
        .bind(id)
        .execute(e)
        .await?
        .rows_affected()
        == 1)
}
const SELECT_ONE: &str = "SELECT id,first_referenced_by_flow,referenced_by_flows,object_kind,content_type,record,created_at,updated_at FROM tamoss_media_objects WHERE id=?1";
fn map(r: SqliteRow) -> Result<MediaObjectRecord, DbError> {
    Ok(MediaObjectRecord {
        id: r.try_get(0)?,
        first_referenced_by_flow: r.try_get(1)?,
        referenced_by_flows: r.try_get(2)?,
        object_kind: r.try_get(3)?,
        content_type: r.try_get(4)?,
        record: r.try_get::<sqlx::types::Json<Value>, _>(5)?.0,
        created_at: r.try_get(6)?,
        updated_at: r.try_get(7)?,
    })
}
