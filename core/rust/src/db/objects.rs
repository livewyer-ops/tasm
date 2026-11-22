// TASM adaptation of rust-tams-api (Apache-2.0), shared by the browser and
// Cloudflare adapters through their db::dialect modules; see NOTICE.
use super::dialect::{self, Connection, Engine, NOW, RecordRow, sqlx};
use super::{DbError, records::MediaObjectRecord};
use serde_json::Value;
use sqlx::Row;
use std::collections::BTreeSet;

const COLUMNS: &str = "SELECT id,first_referenced_by_flow,referenced_by_flows,object_kind,content_type,record,created_at,updated_at FROM tamoss_media_objects";

pub async fn get<'e, E>(executor: E, id: &str) -> Result<Option<MediaObjectRecord>, DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    dialect::query(&format!("{COLUMNS} WHERE id=$1"))
        .bind(id)
        .fetch_optional(executor)
        .await?
        .map(map)
        .transpose()
}
pub async fn get_many<'e, E>(executor: E, ids: &[String]) -> Result<Vec<MediaObjectRecord>, DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    dialect::query(&format!(
        "{COLUMNS} WHERE {} ORDER BY id",
        dialect::in_array("id", "$1")
    ))
    .bind(ids)
    .fetch_all(executor)
    .await?
    .into_iter()
    .map(map)
    .collect()
}
/// Locks the objects in id order so concurrent writers cannot deadlock.
pub async fn lock_sorted(
    e: &mut Connection,
    ids: impl IntoIterator<Item = String>,
) -> Result<(), DbError> {
    if dialect::SERIALISED {
        return dialect::lock(&mut *e, "tamoss_media_objects").await;
    }
    for id in ids.into_iter().collect::<BTreeSet<_>>() {
        dialect::lock(&mut *e, &format!("tamoss_media_objects:{id}")).await?;
        dialect::query(&format!(
            "SELECT id FROM tamoss_media_objects WHERE id=$1{}",
            dialect::FOR_UPDATE
        ))
        .bind(id)
        .fetch_optional(&mut *e)
        .await?;
    }
    Ok(())
}
pub async fn save<'e, E>(e: E, v: &MediaObjectRecord) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    dialect::query(&format!("INSERT INTO tamoss_media_objects(id,first_referenced_by_flow,referenced_by_flows,object_kind,content_type,record,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,{NOW})ON CONFLICT(id)DO UPDATE SET first_referenced_by_flow=EXCLUDED.first_referenced_by_flow,referenced_by_flows=EXCLUDED.referenced_by_flows,object_kind=EXCLUDED.object_kind,content_type=EXCLUDED.content_type,record=EXCLUDED.record,updated_at={NOW}")).bind(&v.id).bind(v.first_referenced_by_flow).bind(&v.referenced_by_flows).bind(&v.object_kind).bind(&v.content_type).bind(sqlx::types::Json(&v.record)).bind(v.created_at).execute(e).await?;
    Ok(())
}
pub async fn create<'e, E>(e: E, v: &MediaObjectRecord) -> Result<bool, DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    Ok(dialect::query(&format!("INSERT INTO tamoss_media_objects(id,first_referenced_by_flow,referenced_by_flows,object_kind,content_type,record,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,{NOW})ON CONFLICT(id)DO NOTHING")).bind(&v.id).bind(v.first_referenced_by_flow).bind(&v.referenced_by_flows).bind(&v.object_kind).bind(&v.content_type).bind(sqlx::types::Json(&v.record)).bind(v.created_at).execute(e).await?.rows_affected()==1)
}
pub async fn delete<'e, E>(e: E, id: &str) -> Result<bool, DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    Ok(
        dialect::query("DELETE FROM tamoss_media_objects WHERE id=$1")
            .bind(id)
            .execute(e)
            .await?
            .rows_affected()
            == 1,
    )
}
fn map(r: RecordRow) -> Result<MediaObjectRecord, DbError> {
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
