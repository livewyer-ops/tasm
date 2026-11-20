// TASM adaptation of rust-tams-api (Apache-2.0), shared by the browser and
// Cloudflare adapters through their db::dialect modules; see NOTICE.
use super::dialect::{self, Engine, Pool, RecordRow, sqlx};
use serde_json::Value;
use sqlx::{QueryBuilder, Row};
use uuid::Uuid;

use super::{
    DbError,
    records::{Page, PageRequest, ProfileRecord, Tags, finish_page},
};

pub async fn list(
    pool: &Pool,
    format: Option<&str>,
    codec: Option<&str>,
    label: Option<&str>,
    page: &PageRequest,
) -> Result<Page<ProfileRecord>, DbError> {
    let mut query = QueryBuilder::<Engine>::new(
        "SELECT id,format,codec,label,tags,record,created FROM tamoss_profiles",
    );
    let mut first = true;
    for (column, value) in [("format", format), ("codec", codec), ("label", label)] {
        if let Some(value) = value {
            query.push(if first { " WHERE " } else { " AND " });
            first = false;
            query.push(column).push("=").push_bind(value);
        }
    }
    query
        .push(" ORDER BY id ASC LIMIT ")
        .push_bind(page.limit + 1)
        .push(" OFFSET ")
        .push_bind(page.offset);
    Ok(finish_page(
        query
            .build()
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(map)
            .collect::<Result<_, _>>()?,
        page,
    ))
}

pub async fn get(pool: &Pool, id: Uuid) -> Result<Option<ProfileRecord>, DbError> {
    get_with(pool, id).await
}

pub async fn get_with<'e, E>(executor: E, id: Uuid) -> Result<Option<ProfileRecord>, DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    dialect::query(
        "SELECT id,format,codec,label,tags,record,created FROM tamoss_profiles WHERE id=$1",
    )
    .bind(id)
    .fetch_optional(executor)
    .await?
    .map(map)
    .transpose()
}

pub async fn create<'e, E>(executor: E, value: &ProfileRecord) -> Result<bool, DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    Ok(dialect::query("INSERT INTO tamoss_profiles(id,format,codec,label,tags,record,created)VALUES($1,$2,$3,$4,$5,$6,$7)ON CONFLICT(id)DO NOTHING")
        .bind(value.id)
        .bind(&value.format)
        .bind(&value.codec)
        .bind(&value.label)
        .bind(sqlx::types::Json(&value.tags))
        .bind(sqlx::types::Json(&value.record))
        .bind(value.created)
        .execute(executor)
        .await?
        .rows_affected()
        == 1)
}

pub async fn lock<'e, E>(executor: E, id: Uuid) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    dialect::lock(executor, &format!("tamoss-profile:{id}")).await
}

pub async fn lock_row<'e, E>(executor: E, id: Uuid) -> Result<bool, DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    Ok(dialect::query(&format!(
        "SELECT id FROM tamoss_profiles WHERE id=$1{}",
        dialect::FOR_UPDATE
    ))
    .bind(id)
    .fetch_optional(executor)
    .await?
    .is_some())
}

pub async fn flow_count(pool: &Pool, id: Uuid) -> Result<i64, DbError> {
    flow_count_with(pool, id).await
}

pub async fn flow_count_with<'e, E>(executor: E, id: Uuid) -> Result<i64, DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    Ok(
        dialect::query_scalar("SELECT count(*) FROM tamoss_flows WHERE profile_id=$1")
            .bind(id)
            .fetch_one(executor)
            .await?,
    )
}

pub async fn delete<'e, E>(executor: E, id: Uuid) -> Result<bool, DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    Ok(dialect::query("DELETE FROM tamoss_profiles WHERE id=$1")
        .bind(id)
        .execute(executor)
        .await?
        .rows_affected()
        == 1)
}

fn map(row: RecordRow) -> Result<ProfileRecord, DbError> {
    Ok(ProfileRecord {
        id: row.try_get(0)?,
        format: row.try_get(1)?,
        codec: row.try_get(2)?,
        label: row.try_get(3)?,
        tags: row.try_get::<sqlx::types::Json<Tags>, _>(4)?.0,
        record: row.try_get::<sqlx::types::Json<Value>, _>(5)?.0,
        created: row.try_get(6)?,
    })
}
