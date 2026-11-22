// TASM adaptation of rust-tams-api (Apache-2.0), shared by the browser and
// Cloudflare adapters through their db::dialect modules; see NOTICE.
use super::dialect::{self, Engine, FLOW_SEGMENTS, NOW, Pool, RecordRow, sqlx};
use std::collections::BTreeMap;

use serde_json::{Value, json};
use sqlx::{QueryBuilder, Row};
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
pub struct SegmentFilters {
    pub object_id: Option<String>,
    pub timerange_start: Option<i128>,
    pub timerange_end: Option<i128>,
    pub timerange_is_point: bool,
    pub cursor: Option<i128>,
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

pub async fn all_flow_ids_exist<'e, E>(executor: E, ids: &[Uuid]) -> Result<bool, DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    if ids.is_empty() {
        return Ok(true);
    }
    let sql = format!(
        "SELECT COUNT(*) FROM tamoss_flows WHERE {}",
        dialect::in_array("id", "$1")
    );
    let count: i64 = dialect::query_scalar(&sql)
        .bind(ids)
        .fetch_one(executor)
        .await?;
    Ok(count as usize == ids.len())
}

pub async fn get_flow(pool: &Pool, id: Uuid) -> Result<Option<FlowRecord>, DbError> {
    get_flow_with(pool, id).await
}

pub async fn get_flow_with<'e, E>(executor: E, id: Uuid) -> Result<Option<FlowRecord>, DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    dialect::query(FLOW_SELECT)
        .bind(id)
        .fetch_optional(executor)
        .await?
        .map(map_flow)
        .transpose()
}
pub async fn list_flows_page(
    pool: &Pool,
    f: &FlowFilters,
    sort: FlowSort,
    reverse: bool,
    page: &PageRequest,
) -> Result<Page<FlowRecord>, DbError> {
    let mut q = QueryBuilder::<Engine>::new(FLOW_COLUMNS);
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
        clause!("");
        dialect::push_json_text_eq(&mut q, "flow.record", &["data", "codec"], v);
    }
    if let Some(v) = f.frame_width {
        clause!("");
        dialect::push_json_int_eq(
            &mut q,
            "flow.record",
            &["data", "essence_parameters", "frame_width"],
            v,
        );
    }
    if let Some(v) = f.frame_height {
        clause!("");
        dialect::push_json_int_eq(
            &mut q,
            "flow.record",
            &["data", "essence_parameters", "frame_height"],
            v,
        );
    }
    if let Some(v) = &f.label {
        clause!("flow.label=").push_bind(v);
    }
    if f.timerange_is_empty {
        clause!(format!("NOT EXISTS({FLOW_SEGMENTS})"));
    } else if f.timerange_start.is_some() || f.timerange_end.is_some() {
        // MIN(start)<end AND MAX(end)>start over the segments of the flow and its
        // direct collection members, the same set its reported timerange covers.
        // Two EXISTS checks let each use a segment index instead of aggregating.
        let mut first = true;
        if let Some(end) = f.timerange_end {
            let comparison = if f.timerange_is_point { "<=" } else { "<" };
            clause!(format!(
                "EXISTS({FLOW_SEGMENTS} AND segment.timerange_start{comparison}"
            ))
            .push_bind(end)
            .push(")");
            first = false;
        }
        if let Some(start) = f.timerange_start {
            if first {
                clause!(format!("EXISTS({FLOW_SEGMENTS} AND segment.timerange_end>"));
            } else {
                q.push(format!(
                    " AND EXISTS({FLOW_SEGMENTS} AND segment.timerange_end>"
                ));
            }
            q.push_bind(start).push(")");
        }
    }
    if f.top_level_only || f.collected_by_ids.is_some() {
        clause!("");
        dialect::push_flow_collected_by(
            &mut q,
            f.collected_by_ids.as_ref().filter(|_| !f.top_level_only),
        );
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
        .push(" LIMIT ")
        .push_bind(page.limit + 1)
        .push(" OFFSET ")
        .push_bind(page.offset);
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
    E: sqlx::Executor<'e, Database = Engine>,
{
    dialect::query(&format!("INSERT INTO tamoss_flows(id,source_id,format,container,profile_id,status,init_segments,label,flow_collection_ids,read_only,tags,record,metadata_updated,created,segments_updated,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,{NOW})ON CONFLICT(id)DO UPDATE SET source_id=EXCLUDED.source_id,format=EXCLUDED.format,container=EXCLUDED.container,profile_id=EXCLUDED.profile_id,status=EXCLUDED.status,init_segments=EXCLUDED.init_segments,label=EXCLUDED.label,flow_collection_ids=EXCLUDED.flow_collection_ids,read_only=EXCLUDED.read_only,tags=EXCLUDED.tags,record=EXCLUDED.record,metadata_updated=EXCLUDED.metadata_updated,created=EXCLUDED.created,segments_updated=EXCLUDED.segments_updated,updated_at={NOW}")).bind(v.id).bind(v.source_id).bind(&v.format).bind(&v.container).bind(v.profile_id).bind(&v.status).bind(v.init_segments).bind(&v.label).bind(&v.flow_collection_ids).bind(v.read_only).bind(sqlx::types::Json(&v.tags)).bind(sqlx::types::Json(&v.record)).bind(v.metadata_updated).bind(v.created).bind(v.segments_updated).execute(e).await?;
    Ok(())
}
pub async fn delete_flow<'e, E>(e: E, id: Uuid) -> Result<bool, DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    Ok(dialect::query("DELETE FROM tamoss_flows WHERE id=$1")
        .bind(id)
        .execute(e)
        .await?
        .rows_affected()
        == 1)
}
pub async fn lock_flow_segments<'e, E>(e: E, id: Uuid) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    dialect::lock(e, &format!("tamoss_segments:{id}")).await
}

pub async fn has_segments<'e, E>(executor: E, id: Uuid) -> Result<bool, DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    Ok(
        dialect::query_scalar("SELECT EXISTS(SELECT 1 FROM tamoss_segments WHERE flow_id=$1)")
            .bind(id)
            .fetch_one(executor)
            .await?,
    )
}

/// The flows among `ids` whose tags match, one page at a time in ID order.
pub async fn page_flow_ids_with_tags(
    pool: &Pool,
    ids: &[Uuid],
    tags: &TagFilters,
    page: &PageRequest,
) -> Result<Page<Uuid>, DbError> {
    let mut q = QueryBuilder::<Engine>::new("SELECT flow.id FROM tamoss_flows flow WHERE ");
    dialect::push_in_array(&mut q, "flow.id", ids);
    append_tags(&mut q, "flow.tags", tags, true);
    q.push(" ORDER BY flow.id LIMIT ")
        .push_bind(page.limit + 1)
        .push(" OFFSET ")
        .push_bind(page.offset);
    Ok(finish_page(
        q.build()
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|row| row.try_get(0))
            .collect::<Result<_, _>>()?,
        page,
    ))
}

pub async fn list_flows_collecting<'e, E>(
    executor: E,
    child_ids: &[Uuid],
) -> Result<Vec<FlowRecord>, DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    if child_ids.is_empty() {
        return Ok(Vec::new());
    }
    dialect::query(&format!(
        "{FLOW_COLUMNS} WHERE {} ORDER BY flow.id",
        dialect::COLLECTING_FLOWS
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
    E: sqlx::Executor<'e, Database = Engine>,
{
    // One pass per call: each requested flow and its collection members, with the
    // first and last matching segment of each found through the segment indexes.
    // Segments in a flow never overlap, so ordering by end and by start agree.
    let end = if bounds.point {
        bounds.start.map(|start| start.saturating_add(1))
    } else {
        bounds.end
    };
    // Only set bounds become placeholders, numbered after the id list.
    let (start, end) = if bounds.empty {
        (None, None)
    } else {
        (bounds.start, end)
    };
    let mut next = 1;
    let mut placeholder = |condition: &str| {
        next += 1;
        format!(" AND segment.{condition}${next}")
    };
    let (after, before) = if bounds.empty {
        (" AND false".to_owned(), " AND false".to_owned())
    } else {
        (
            start.map_or(String::new(), |_| placeholder("timerange_end>")),
            end.map_or(String::new(), |_| placeholder("timerange_start<")),
        )
    };
    let first_before = before.replace("segment.", "first.");
    let last_after = after.replace("segment.", "last.");
    let sql = format!(
        "{} SELECT members.flow_id,MIN((SELECT first.timerange_start FROM (SELECT segment.timerange_start FROM tamoss_segments segment WHERE segment.flow_id=members.member_id{after} ORDER BY segment.timerange_end LIMIT 1) first WHERE true{first_before})),MAX((SELECT last.timerange_end FROM (SELECT segment.timerange_end FROM tamoss_segments segment WHERE segment.flow_id=members.member_id{before} ORDER BY segment.timerange_start DESC LIMIT 1) last WHERE true{last_after})) FROM members GROUP BY members.flow_id",
        dialect::TIMERANGE_MEMBERS
    );
    let mut query = dialect::query(&sql).bind(ids);
    if let Some(start) = start {
        query = query.bind(start);
    }
    if let Some(end) = end {
        query = query.bind(end);
    }
    let rows = query.fetch_all(executor).await?;
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
    E: sqlx::Executor<'e, Database = Engine>,
{
    let mut result = ids
        .iter()
        .copied()
        .map(|id| (id, crate::domain::model::SourceRelationships::default()))
        .collect::<BTreeMap<_, _>>();
    if ids.is_empty() {
        return Ok(result);
    }
    let rows = dialect::query(dialect::SOURCE_RELATIONSHIPS)
        .bind(ids)
        .fetch_all(executor)
        .await?;
    let mut members = BTreeMap::<Uuid, Vec<_>>::new();
    for row in rows {
        let target: Uuid = row.try_get(0)?;
        let kind: i32 = row.try_get(1)?;
        let related: Uuid = row.try_get(2)?;
        let role: Option<String> = row.try_get(3)?;
        let relationships = result.entry(target).or_default();
        if kind == 0 {
            let parent: Uuid = row.try_get(4)?;
            members
                .entry(target)
                .or_default()
                .push((parent, related, role));
        } else if !relationships.collected_by.contains(&related) {
            relationships.collected_by.push(related);
        }
    }
    for (source, members) in members {
        let relationships = result.get_mut(&source).expect("queried Source");
        if let Some(collection) = crate::domain::model::source_collection(&members) {
            relationships.source_collection = collection;
        } else {
            // Keep previously stored contradictory representations readable until corrected.
            relationships.conflicting_collection = true;
            for (_, id, role) in members {
                let mut item = json!({"id":id});
                if let Some(role) = role {
                    item["role"] = json!(role);
                }
                if !relationships.source_collection.contains(&item) {
                    relationships.source_collection.push(item);
                }
            }
        }
    }
    Ok(result)
}
pub async fn get_source(pool: &Pool, id: Uuid) -> Result<Option<SourceRecord>, DbError> {
    get_source_with(pool, id).await
}

pub async fn get_source_with<'e, E>(executor: E, id: Uuid) -> Result<Option<SourceRecord>, DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    dialect::query(SOURCE_SELECT)
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
    E: sqlx::Executor<'e, Database = Engine>,
{
    dialect::query(&format!("SELECT id,format,label,tags,record,metadata_updated,created FROM tamoss_sources WHERE id=$1{}", dialect::FOR_UPDATE))
        .bind(id).fetch_optional(executor).await?.map(map_source).transpose()
}
pub async fn save_source<'e, E>(e: E, v: &SourceRecord) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    dialect::query(&format!("INSERT INTO tamoss_sources(id,format,label,tags,record,metadata_updated,created,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,{NOW})ON CONFLICT(id)DO UPDATE SET format=EXCLUDED.format,label=EXCLUDED.label,tags=EXCLUDED.tags,record=EXCLUDED.record,metadata_updated=EXCLUDED.metadata_updated,created=EXCLUDED.created,updated_at={NOW}")).bind(v.id).bind(&v.format).bind(&v.label).bind(sqlx::types::Json(&v.tags)).bind(sqlx::types::Json(&v.record)).bind(v.metadata_updated).bind(v.created).execute(e).await?;
    Ok(())
}

pub async fn delete_source<'e, E>(executor: E, id: Uuid) -> Result<bool, DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    Ok(dialect::query("DELETE FROM tamoss_sources AS source WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM tamoss_flows WHERE source_id=source.id)")
        .bind(id).execute(executor).await?.rows_affected() == 1)
}
pub async fn list_sources_page(
    pool: &Pool,
    f: &SourceFilters,
    sort: SourceSort,
    reverse: bool,
    page: &PageRequest,
) -> Result<Page<SourceRecord>, DbError> {
    let mut q = QueryBuilder::<Engine>::new(
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
        dialect::push_source_collected_by(
            &mut q,
            f.collected_by_ids.as_ref().filter(|_| !f.top_level_only),
        );
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
        .push(" LIMIT ")
        .push_bind(page.limit + 1)
        .push(" OFFSET ")
        .push_bind(page.offset);
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
fn push_segment_filters(q: &mut QueryBuilder<'_, Engine>, flow_id: Uuid, f: &SegmentFilters) {
    q.push_bind(flow_id);
    if let Some(id) = &f.object_id {
        q.push(" AND object_id=").push_bind(id.clone());
    }
    if let Some(start) = f.timerange_start {
        // Only the immediate predecessor can overlap the lower bound.
        q.push(" AND timerange_start>=COALESCE((SELECT MAX(timerange_start) FROM tamoss_segments WHERE flow_id=")
            .push_bind(flow_id)
            .push(" AND timerange_start<=")
            .push_bind(start)
            .push("),")
            .push_bind(start)
            .push(") AND timerange_end>")
            .push_bind(start);
    }
    if let Some(end) = f.timerange_end {
        q.push(if f.timerange_is_point {
            " AND timerange_start<="
        } else {
            " AND timerange_start<"
        })
        .push_bind(end);
    }
}
pub async fn list_segments_page(
    pool: &Pool,
    flow_id: Uuid,
    f: &SegmentFilters,
    reverse: bool,
    page: &PageRequest,
) -> Result<Page<SegmentRecord>, DbError> {
    let mut q = QueryBuilder::<Engine>::new(
        "SELECT flow_id,object_id,init_object_id,timerange,timerange_start,timerange_end,record,created FROM tamoss_segments WHERE flow_id=",
    );
    push_segment_filters(&mut q, flow_id, f);
    if let Some(start) = f.cursor {
        q.push(if reverse {
            " AND timerange_start<"
        } else {
            " AND timerange_start>"
        })
        .push_bind(start);
    }
    q.push(if reverse {
        " ORDER BY timerange_start DESC"
    } else {
        " ORDER BY timerange_start"
    })
    .push(" LIMIT ")
    .push_bind(page.limit + 1);
    if page.offset != 0 {
        q.push(" OFFSET ").push_bind(page.offset);
    }
    let mut items = q
        .build()
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(map_segment)
        .collect::<Result<Vec<_>, _>>()?;
    let next_page = if items.len() > page.limit as usize {
        items.pop();
        items
            .last()
            .map(|item| format!("t.{}", item.timerange_start))
    } else {
        None
    };
    Ok(Page {
        items,
        limit: page.limit,
        next_page,
    })
}
pub async fn append_segment<'e, E>(e: E, v: &SegmentRecord) -> Result<(), DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    dialect::query(&format!("INSERT INTO tamoss_segments(flow_id,object_id,init_object_id,timerange,timerange_start,timerange_end,record,created,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,{NOW})ON CONFLICT(flow_id,object_id,timerange)DO UPDATE SET init_object_id=EXCLUDED.init_object_id,timerange_start=EXCLUDED.timerange_start,timerange_end=EXCLUDED.timerange_end,record=EXCLUDED.record,created=EXCLUDED.created,updated_at={NOW}")).bind(v.flow_id).bind(&v.object_id).bind(&v.init_object_id).bind(&v.timerange).bind(v.timerange_start).bind(v.timerange_end).bind(sqlx::types::Json(&v.record)).bind(v.created).execute(e).await?;
    Ok(())
}
const FLOW_COLUMNS: &str = "SELECT flow.id,flow.source_id,flow.format,flow.container,flow.profile_id,flow.status,flow.init_segments,flow.label,flow.flow_collection_ids,flow.read_only,flow.tags,flow.record,flow.metadata_updated,flow.created,flow.segments_updated FROM tamoss_flows flow";
const FLOW_SELECT: &str = "SELECT id,source_id,format,container,profile_id,status,init_segments,label,flow_collection_ids,read_only,tags,record,metadata_updated,created,segments_updated FROM tamoss_flows WHERE id=$1";
const SOURCE_SELECT: &str =
    "SELECT id,format,label,tags,record,metadata_updated,created FROM tamoss_sources WHERE id=$1";
fn map_flow(r: RecordRow) -> Result<FlowRecord, DbError> {
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
fn map_source(r: RecordRow) -> Result<SourceRecord, DbError> {
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
pub(crate) fn map_segment(r: RecordRow) -> Result<SegmentRecord, DbError> {
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
