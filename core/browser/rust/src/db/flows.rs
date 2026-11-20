// TASM browser adaptation of rust-tams-api (Apache-2.0); see NOTICE for changes.
use crate::pglite as sqlx;
use std::collections::BTreeMap;

use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, QueryBuilder, Row, postgres::PgRow};
use uuid::Uuid;

use super::{
    DbError,
    records::{
        FlowRecord, Page, PageRequest, SegmentRecord, SourceRecord, TagFilters, Tags, finish_page,
    },
    service::append_tags,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowSort {
    Created,
    Updated,
    Label,
}
#[derive(Debug, Clone, Default)]
pub struct FlowFilters {
    pub source_id: Option<Uuid>,
    pub format: Option<String>,
    pub profile_id: Option<Uuid>,
    pub status: Option<String>,
    pub init_segments: Option<bool>,
    pub codec: Option<String>,
    pub frame_width: Option<i32>,
    pub frame_height: Option<i32>,
    pub label: Option<String>,
    pub collected_by_ids: Option<Vec<Uuid>>,
    pub top_level_only: bool,
    pub timerange_start: Option<i128>,
    pub timerange_end: Option<i128>,
    pub timerange_is_empty: bool,
    pub timerange_is_point: bool,
    pub tags: TagFilters,
}
#[derive(Debug, Clone, Default)]
pub struct SegmentSummary {
    pub count: i64,
    pub start: Option<i128>,
    pub end: Option<i128>,
    pub timerange: Option<String>,
}
#[derive(Debug, Clone, Default)]
pub struct SegmentFilters {
    pub object_id: Option<String>,
    pub timerange_start: Option<i128>,
    pub timerange_end: Option<i128>,
    pub timerange_is_point: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceSort {
    Created,
    Updated,
    Label,
}
#[derive(Debug, Clone, Default)]
pub struct SourceFilters {
    pub format: Option<String>,
    pub label: Option<String>,
    pub collected_by_ids: Option<Vec<Uuid>>,
    pub top_level_only: bool,
    pub tags: TagFilters,
}

pub async fn get_flow(pool: &PgPool, id: Uuid) -> Result<Option<FlowRecord>, DbError> {
    get_flow_with(pool, id).await
}

pub async fn get_flow_with<'e, E>(executor: E, id: Uuid) -> Result<Option<FlowRecord>, DbError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    sqlx::query(FLOW_SELECT)
        .bind(id)
        .fetch_optional(executor)
        .await?
        .map(map_flow)
        .transpose()
}
pub async fn list_flows(pool: &PgPool) -> Result<Vec<FlowRecord>, DbError> {
    sqlx::query(&format!("{FLOW_COLUMNS} ORDER BY id"))
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(map_flow)
        .collect()
}
pub async fn list_flows_page(
    pool: &PgPool,
    f: &FlowFilters,
    sort: FlowSort,
    reverse: bool,
    page: &PageRequest,
) -> Result<Page<FlowRecord>, DbError> {
    let mut q = QueryBuilder::<Postgres>::new(FLOW_COLUMNS);
    let mut where_started = false;
    macro_rules! clause {
        ($sql:expr) => {{
            if !where_started {
                q.push(" WHERE ");
                where_started = true
            } else {
                q.push(" AND ");
            }
            q.push($sql)
        }};
    }
    if let Some(v) = f.source_id {
        clause!("flow.source_id=").push_bind(v);
    }
    if let Some(v) = &f.format {
        clause!("flow.format=").push_bind(v);
    }
    if let Some(v) = f.profile_id {
        clause!("flow.profile_id=").push_bind(v);
    }
    if let Some(v) = &f.status {
        clause!("flow.status=").push_bind(v);
    }
    if let Some(v) = f.init_segments {
        clause!("flow.init_segments=").push_bind(v);
    }
    if let Some(v) = &f.codec {
        clause!("flow.record #>> '{data,codec}'=").push_bind(v);
    }
    if let Some(v) = f.frame_width {
        clause!("flow.record #> '{data,essence_parameters,frame_width}'=to_jsonb(")
            .push_bind(v)
            .push("::int)");
    }
    if let Some(v) = f.frame_height {
        clause!("flow.record #> '{data,essence_parameters,frame_height}'=to_jsonb(")
            .push_bind(v)
            .push("::int)");
    }
    if let Some(v) = &f.label {
        clause!("flow.label=").push_bind(v);
    }
    if f.timerange_is_empty {
        clause!("NOT EXISTS(SELECT 1 FROM tamoss_segments segment WHERE segment.flow_id=flow.id)");
    } else if f.timerange_start.is_some() || f.timerange_end.is_some() {
        // MIN(start)<end AND MAX(end)>start, written as two EXISTS checks so
        // each can use a segment index instead of aggregating the flow.
        let mut first = true;
        if let Some(mut end) = f.timerange_end {
            if f.timerange_is_point && f.timerange_start == Some(end) {
                end += 1
            }
            clause!("EXISTS(SELECT 1 FROM tamoss_segments segment WHERE segment.flow_id=flow.id AND segment.timerange_start<")
                .push_bind(end)
                .push(")");
            first = false;
        }
        if let Some(start) = f.timerange_start {
            if first {
                clause!(
                    "EXISTS(SELECT 1 FROM tamoss_segments segment WHERE segment.flow_id=flow.id AND segment.timerange_end>"
                );
            } else {
                q.push(" AND EXISTS(SELECT 1 FROM tamoss_segments segment WHERE segment.flow_id=flow.id AND segment.timerange_end>");
            }
            q.push_bind(start).push(")");
        }
    }
    if f.top_level_only || f.collected_by_ids.is_some() {
        clause!(if f.top_level_only {
            "NOT EXISTS(SELECT 1 FROM tamoss_flows parent WHERE parent.flow_collection_ids @> ARRAY[flow.id])"
        } else {
            "EXISTS(SELECT 1 FROM tamoss_flows parent WHERE parent.flow_collection_ids @> ARRAY[flow.id] AND parent.id = ANY("
        });
        if !f.top_level_only {
            q.push_bind(f.collected_by_ids.as_ref().unwrap()).push("))");
        }
    }
    append_tags(&mut q, "flow.tags", &f.tags, where_started);
    // Tag filters are applied in an outer query to keep binding/order exact without unsafe SQL interpolation.
    let (order, descending) = match sort {
        FlowSort::Created => ("created", !reverse),
        FlowSort::Updated => ("metadata_updated", !reverse),
        FlowSort::Label => ("label", reverse),
    };
    q.push(" ORDER BY flow.")
        .push(order)
        .push(if descending { " DESC" } else { " ASC" })
        .push(if reverse {
            " NULLS FIRST,flow.id "
        } else {
            " NULLS LAST,flow.id "
        })
        .push(if descending { "DESC" } else { "ASC" })
        .push(" OFFSET ")
        .push_bind(page.offset)
        .push(" LIMIT ")
        .push_bind(page.limit + 1);
    Ok(finish_page(
        q.build()
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(map_flow)
            .collect::<Result<_, _>>()?,
        page,
    ))
}
pub async fn save_flow<'e, E>(e: E, v: &FlowRecord) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    sqlx::query("INSERT INTO tamoss_flows(id,source_id,format,container,profile_id,status,init_segments,label,flow_collection_ids,read_only,tags,record,metadata_updated,created,segments_updated,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())ON CONFLICT(id)DO UPDATE SET source_id=EXCLUDED.source_id,format=EXCLUDED.format,container=EXCLUDED.container,profile_id=EXCLUDED.profile_id,status=EXCLUDED.status,init_segments=EXCLUDED.init_segments,label=EXCLUDED.label,flow_collection_ids=EXCLUDED.flow_collection_ids,read_only=EXCLUDED.read_only,tags=EXCLUDED.tags,record=EXCLUDED.record,metadata_updated=EXCLUDED.metadata_updated,created=EXCLUDED.created,segments_updated=EXCLUDED.segments_updated,updated_at=NOW()").bind(v.id).bind(v.source_id).bind(&v.format).bind(&v.container).bind(v.profile_id).bind(&v.status).bind(v.init_segments).bind(&v.label).bind(&v.flow_collection_ids).bind(v.read_only).bind(sqlx::types::Json(&v.tags)).bind(sqlx::types::Json(&v.record)).bind(v.metadata_updated).bind(v.created).bind(v.segments_updated).execute(e).await?;
    Ok(())
}
pub async fn delete_flow<'e, E>(e: E, id: Uuid) -> Result<bool, DbError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    Ok(sqlx::query("DELETE FROM tamoss_flows WHERE id=$1")
        .bind(id)
        .execute(e)
        .await?
        .rows_affected()
        == 1)
}
pub async fn lock_flow_segments<'e, E>(e: E, id: Uuid) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("tamoss_segments:{id}"))
        .execute(e)
        .await?;
    Ok(())
}

pub async fn has_segments<'e, E>(executor: E, id: Uuid) -> Result<bool, DbError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    Ok(
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM tamoss_segments WHERE flow_id=$1)")
            .bind(id)
            .fetch_one(executor)
            .await?,
    )
}

pub async fn list_flows_collecting<'e, E>(
    executor: E,
    child_ids: &[Uuid],
) -> Result<Vec<FlowRecord>, DbError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    if child_ids.is_empty() {
        return Ok(Vec::new());
    }
    sqlx::query(&format!(
        "{FLOW_COLUMNS} WHERE flow.flow_collection_ids && $1 ORDER BY flow.id"
    ))
    .bind(child_ids)
    .fetch_all(executor)
    .await?
    .into_iter()
    .map(map_flow)
    .collect()
}

pub async fn flow_timeranges<'e, E>(
    executor: E,
    ids: &[Uuid],
    bounds: crate::domain::timerange::Bounds,
) -> Result<BTreeMap<Uuid, Option<(i128, i128)>>, DbError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    let rows = sqlx::query("SELECT flow.id,MIN(segment.timerange_start),MAX(segment.timerange_end) FROM tamoss_flows flow LEFT JOIN tamoss_segments segment ON (segment.flow_id=flow.id OR segment.flow_id =ANY(flow.flow_collection_ids)) AND NOT $2 AND ($3 IS NULL OR segment.timerange_end>$3) AND ($4 IS NULL OR segment.timerange_start<$4) WHERE flow.id =ANY($1) GROUP BY flow.id")
        .bind(ids).bind(bounds.empty).bind(bounds.start).bind(if bounds.point { bounds.start.map(|start| start.saturating_add(1)) } else { bounds.end }).fetch_all(executor).await?;
    rows.into_iter()
        .map(|row| {
            let id: Uuid = row.try_get(0)?;
            let start: Option<i128> = row.try_get(1)?;
            let end: Option<i128> = row.try_get(2)?;
            Ok((id, start.zip(end)))
        })
        .collect()
}

pub async fn source_relationships<'e, E>(
    executor: E,
    ids: &[Uuid],
) -> Result<BTreeMap<Uuid, crate::domain::model::SourceRelationships>, DbError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    let mut result = ids
        .iter()
        .copied()
        .map(|id| (id, crate::domain::model::SourceRelationships::default()))
        .collect::<BTreeMap<_, _>>();
    if ids.is_empty() {
        return Ok(result);
    }
    let rows = sqlx::query("SELECT target_source,kind,related_source,role FROM (SELECT parent.source_id target_source,0 kind,child.source_id related_source,item.value->>'role' role,parent.id flow_order,item.ordinality item_order FROM tamoss_flows parent CROSS JOIN LATERAL jsonb_array_elements(COALESCE(parent.record#>'{data,flow_collection}','[]'::jsonb)) WITH ORDINALITY item(value,ordinality) JOIN tamoss_flows child ON child.id=(item.value->>'id')::uuid WHERE parent.source_id=ANY($1) UNION ALL SELECT child.source_id target_source,1 kind,parent.source_id related_source,NULL role,parent.id flow_order,item.ordinality item_order FROM tamoss_flows parent CROSS JOIN LATERAL jsonb_array_elements(COALESCE(parent.record#>'{data,flow_collection}','[]'::jsonb)) WITH ORDINALITY item(value,ordinality) JOIN tamoss_flows child ON child.id=(item.value->>'id')::uuid WHERE child.source_id=ANY($1)) relationships ORDER BY target_source,kind,flow_order,item_order")
        .bind(ids).fetch_all(executor).await?;
    for row in rows {
        let target: Uuid = row.try_get(0)?;
        let kind: i32 = row.try_get(1)?;
        let related: Uuid = row.try_get(2)?;
        let role: Option<String> = row.try_get(3)?;
        let relationships = result.entry(target).or_default();
        if kind == 0 {
            let mut item = json!({"id": related});
            if let Some(role) = role {
                item.as_object_mut()
                    .unwrap()
                    .insert("role".into(), json!(role));
            }
            if !relationships.source_collection.contains(&item) {
                relationships.source_collection.push(item);
            }
        } else if !relationships.collected_by.contains(&related) {
            relationships.collected_by.push(related);
        }
    }
    Ok(result)
}
pub async fn get_source(pool: &PgPool, id: Uuid) -> Result<Option<SourceRecord>, DbError> {
    get_source_with(pool, id).await
}

pub async fn get_source_with<'e, E>(executor: E, id: Uuid) -> Result<Option<SourceRecord>, DbError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    sqlx::query(SOURCE_SELECT)
        .bind(id)
        .fetch_optional(executor)
        .await?
        .map(map_source)
        .transpose()
}

pub async fn get_source_for_update<'e, E>(
    executor: E,
    id: Uuid,
) -> Result<Option<SourceRecord>, DbError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    sqlx::query("SELECT id,format,label,tags,record,metadata_updated,created FROM tamoss_sources WHERE id=$1 FOR UPDATE")
        .bind(id).fetch_optional(executor).await?.map(map_source).transpose()
}
pub async fn save_source<'e, E>(e: E, v: &SourceRecord) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    sqlx::query("INSERT INTO tamoss_sources(id,format,label,tags,record,metadata_updated,created,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,NOW())ON CONFLICT(id)DO UPDATE SET format=EXCLUDED.format,label=EXCLUDED.label,tags=EXCLUDED.tags,record=EXCLUDED.record,metadata_updated=EXCLUDED.metadata_updated,created=EXCLUDED.created,updated_at=NOW()").bind(v.id).bind(&v.format).bind(&v.label).bind(sqlx::types::Json(&v.tags)).bind(sqlx::types::Json(&v.record)).bind(v.metadata_updated).bind(v.created).execute(e).await?;
    Ok(())
}

pub async fn delete_source<'e, E>(executor: E, id: Uuid) -> Result<bool, DbError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    Ok(sqlx::query("DELETE FROM tamoss_sources source WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM tamoss_flows WHERE source_id=source.id)")
        .bind(id).execute(executor).await?.rows_affected() == 1)
}
pub async fn list_sources_page(
    pool: &PgPool,
    f: &SourceFilters,
    sort: SourceSort,
    reverse: bool,
    page: &PageRequest,
) -> Result<Page<SourceRecord>, DbError> {
    let mut q = QueryBuilder::<Postgres>::new(
        "SELECT source.id,source.format,source.label,source.tags,source.record,source.metadata_updated,source.created FROM tamoss_sources source",
    );
    let mut wh = false;
    if let Some(v) = &f.format {
        q.push(" WHERE source.format=").push_bind(v);
        wh = true
    }
    if let Some(v) = &f.label {
        q.push(if wh { " AND " } else { " WHERE " })
            .push("source.label=")
            .push_bind(v);
        wh = true
    }
    if f.top_level_only || f.collected_by_ids.is_some() {
        q.push(if wh { " AND " } else { " WHERE " });
        wh = true;
        if f.top_level_only {
            q.push("NOT EXISTS(SELECT 1 FROM tamoss_flows child JOIN tamoss_flows parent ON parent.flow_collection_ids @> ARRAY[child.id] WHERE child.source_id=source.id)");
        } else {
            q.push("EXISTS(SELECT 1 FROM tamoss_flows child JOIN tamoss_flows parent ON parent.flow_collection_ids @> ARRAY[child.id] WHERE child.source_id=source.id AND parent.source_id=ANY(").push_bind(f.collected_by_ids.as_ref().unwrap()).push("))");
        }
    }
    append_tags(&mut q, "source.tags", &f.tags, wh);
    let (key, descending) = match sort {
        SourceSort::Created => ("created", !reverse),
        SourceSort::Updated => ("metadata_updated", !reverse),
        SourceSort::Label => ("label", reverse),
    };
    q.push(" ORDER BY source.")
        .push(key)
        .push(if descending { " DESC" } else { " ASC" })
        .push(if reverse {
            " NULLS FIRST,source.id "
        } else {
            " NULLS LAST,source.id "
        })
        .push(if descending { "DESC" } else { "ASC" })
        .push(" OFFSET ")
        .push_bind(page.offset)
        .push(" LIMIT ")
        .push_bind(page.limit + 1);
    Ok(finish_page(
        q.build()
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(map_source)
            .collect::<Result<_, _>>()?,
        page,
    ))
}
fn push_segment_filters(q: &mut QueryBuilder<'_, Postgres>, flow_id: Uuid, f: &SegmentFilters) {
    q.push_bind(flow_id);
    if let Some(id) = &f.object_id {
        q.push(" AND object_id=").push_bind(id.clone());
    }
    if let Some(start) = f.timerange_start {
        q.push(" AND timerange_end>").push_bind(start);
    }
    if let Some(mut end) = f.timerange_end {
        if f.timerange_is_point && f.timerange_start == Some(end) {
            end += 1
        }
        q.push(" AND timerange_start<").push_bind(end);
    }
}
pub async fn list_segments_page(
    pool: &PgPool,
    flow_id: Uuid,
    f: &SegmentFilters,
    reverse: bool,
    page: &PageRequest,
) -> Result<Page<SegmentRecord>, DbError> {
    let mut q = QueryBuilder::<Postgres>::new(
        "SELECT flow_id,object_id,init_object_id,timerange,timerange_start,timerange_end,record,created FROM tamoss_segments WHERE flow_id=",
    );
    push_segment_filters(&mut q, flow_id, f);
    q.push(if reverse {
        " ORDER BY timerange_start DESC,object_id DESC,timerange DESC"
    } else {
        " ORDER BY timerange_start ASC,object_id ASC,timerange ASC"
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
            .map(map_segment)
            .collect::<Result<_, _>>()?,
        page,
    ))
}
/// Count and outer bounds of the segments matching a segment list query.
pub async fn segment_summary(
    pool: &PgPool,
    flow_id: Uuid,
    f: &SegmentFilters,
) -> Result<SegmentSummary, DbError> {
    let mut q = QueryBuilder::<Postgres>::new(
        "SELECT COUNT(*),MIN(timerange_start),MAX(timerange_end),MIN(timerange) FROM tamoss_segments WHERE flow_id=",
    );
    push_segment_filters(&mut q, flow_id, f);
    let row = q.build().fetch_one(pool).await?;
    Ok(SegmentSummary {
        count: row.try_get(0)?,
        start: row.try_get(1)?,
        end: row.try_get(2)?,
        timerange: row.try_get(3)?,
    })
}
pub async fn append_segment<'e, E>(e: E, v: &SegmentRecord) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    sqlx::query("INSERT INTO tamoss_segments(flow_id,object_id,init_object_id,timerange,timerange_start,timerange_end,record,created,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW())ON CONFLICT(flow_id,object_id,timerange)DO UPDATE SET init_object_id=EXCLUDED.init_object_id,timerange_start=EXCLUDED.timerange_start,timerange_end=EXCLUDED.timerange_end,record=EXCLUDED.record,created=EXCLUDED.created,updated_at=NOW()").bind(v.flow_id).bind(&v.object_id).bind(&v.init_object_id).bind(&v.timerange).bind(v.timerange_start).bind(v.timerange_end).bind(sqlx::types::Json(&v.record)).bind(v.created).execute(e).await?;
    Ok(())
}
const FLOW_COLUMNS: &str = "SELECT flow.id,flow.source_id,flow.format,flow.container,flow.profile_id,flow.status,flow.init_segments,flow.label,flow.flow_collection_ids,flow.read_only,flow.tags,flow.record,flow.metadata_updated,flow.created,flow.segments_updated FROM tamoss_flows flow";
const FLOW_SELECT: &str = "SELECT id,source_id,format,container,profile_id,status,init_segments,label,flow_collection_ids,read_only,tags,record,metadata_updated,created,segments_updated FROM tamoss_flows WHERE id=$1";
const SOURCE_SELECT: &str =
    "SELECT id,format,label,tags,record,metadata_updated,created FROM tamoss_sources WHERE id=$1";
fn map_flow(r: PgRow) -> Result<FlowRecord, DbError> {
    Ok(FlowRecord {
        id: r.try_get(0)?,
        source_id: r.try_get(1)?,
        format: r.try_get(2)?,
        container: r.try_get(3)?,
        profile_id: r.try_get(4)?,
        status: r.try_get(5)?,
        init_segments: r.try_get(6)?,
        label: r.try_get(7)?,
        flow_collection_ids: r.try_get(8)?,
        read_only: r.try_get(9)?,
        tags: r.try_get::<sqlx::types::Json<Tags>, _>(10)?.0,
        record: r.try_get::<sqlx::types::Json<Value>, _>(11)?.0,
        metadata_updated: r.try_get(12)?,
        created: r.try_get(13)?,
        segments_updated: r.try_get(14)?,
    })
}
fn map_source(r: PgRow) -> Result<SourceRecord, DbError> {
    Ok(SourceRecord {
        id: r.try_get(0)?,
        format: r.try_get(1)?,
        label: r.try_get(2)?,
        tags: r.try_get::<sqlx::types::Json<Tags>, _>(3)?.0,
        record: r.try_get::<sqlx::types::Json<Value>, _>(4)?.0,
        metadata_updated: r.try_get(5)?,
        created: r.try_get(6)?,
    })
}
fn map_segment(r: PgRow) -> Result<SegmentRecord, DbError> {
    Ok(SegmentRecord {
        flow_id: r.try_get(0)?,
        object_id: r.try_get(1)?,
        init_object_id: r.try_get(2)?,
        timerange: r.try_get(3)?,
        timerange_start: r.try_get(4)?,
        timerange_end: r.try_get(5)?,
        record: r.try_get::<sqlx::types::Json<Value>, _>(6)?.0,
        created: r.try_get(7)?,
    })
}
