//! PostgreSQL (PGlite) details used by the shared query modules in core/rust/src/db/.
pub use crate::pglite as sqlx;
use serde_json::json;
pub use sqlx::{Connection, Engine, Pool, RecordRow, query, query_scalar};

/// Row lock suffix for a `SELECT` that must hold the row until commit.
pub const FOR_UPDATE: &str = " FOR UPDATE";

/// Serialises transactions that use the same key until the current one ends.
pub async fn lock<'e, E>(executor: E, key: &str) -> Result<(), super::DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(key)
        .execute(executor)
        .await?;
    Ok(())
}

/// The current time as the engine stores timestamps.
pub const NOW: &str = "NOW()";

/// Each transaction can run alongside others, so writers take locks.
pub const SERIALISED: bool = false;

/// `column` is one of the values in the array parameter `placeholder`.
pub fn in_array(column: &str, placeholder: &str) -> String {
    format!("{column}=ANY({placeholder})")
}

/// The number of elements in an array column.
pub fn array_length(column: &str) -> String {
    format!("cardinality({column})")
}

/// A webhook's `events` list contains the text parameter `$1`.
pub const WEBHOOK_HAS_EVENT: &str = "COALESCE(record->'data'->'events','[]'::jsonb) ? $1";

/// Appends a TAMS tag filter on the JSON tags `column` to a query.
pub(crate) fn append_tags<'a>(
    q: &mut sqlx::QueryBuilder<'a, Engine>,
    column: &str,
    filters: &'a super::records::TagFilters,
    has_where: bool,
) {
    let mut first = !has_where;
    for (name, values) in &filters.values {
        if first {
            q.push(" WHERE ");
            first = false
        } else {
            q.push(" AND ");
        };
        if values.is_empty() {
            q.push("FALSE");
            continue;
        }
        q.push("(");
        let mut vfirst = true;
        for value in values {
            if !vfirst {
                q.push(" OR ");
            }
            vfirst = false;
            q.push(column)
                .push(" @> ")
                .push_bind(sqlx::types::Json(json!({(name):value})))
                .push(" OR ")
                .push(column)
                .push(" @> ")
                .push_bind(sqlx::types::Json(json!({(name):[value]})));
        }
        q.push(")");
    }
    for (name, exists) in &filters.exists {
        if first {
            q.push(" WHERE ");
            first = false
        } else {
            q.push(" AND ");
        };
        if !exists {
            q.push("NOT (");
        };
        q.push(column).push(" ? ").push_bind(name);
        if !exists {
            q.push(")");
        }
    }
}

/// Appends a test that the JSON text at `path` in `column` equals `value`.
pub fn push_json_text_eq<'a, B: sqlx::Bind + 'a>(
    q: &mut sqlx::QueryBuilder<'a, Engine>,
    column: &str,
    path: &[&str],
    value: B,
) {
    q.push(format!("{column} #>> '{{{}}}'=", path.join(",")))
        .push_bind(value);
}

/// Appends a test that the JSON integer at `path` in `column` equals `value`.
pub fn push_json_int_eq<'a, B: sqlx::Bind + 'a>(
    q: &mut sqlx::QueryBuilder<'a, Engine>,
    column: &str,
    path: &[&str],
    value: B,
) {
    q.push(format!("{column} #> '{{{}}}'=to_jsonb(", path.join(",")))
        .push_bind(value)
        .push("::int)");
}

/// Appends a test that the flow is collected by one of `parents`, or by no flow when `None`.
pub fn push_flow_collected_by<'a, B: sqlx::Bind + 'a>(
    q: &mut sqlx::QueryBuilder<'a, Engine>,
    parents: Option<B>,
) {
    match parents {
        None => q.push("NOT EXISTS(SELECT 1 FROM tamoss_flows parent WHERE parent.flow_collection_ids @> ARRAY[flow.id])"),
        Some(ids) => q.push("EXISTS(SELECT 1 FROM tamoss_flows parent WHERE parent.flow_collection_ids @> ARRAY[flow.id] AND parent.id = ANY(").push_bind(ids).push("))"),
    };
}

/// Appends a test that one of the source's flows is collected by a flow of one of the
/// `parents` sources, or by no flow when `None`.
pub fn push_source_collected_by<'a, B: sqlx::Bind + 'a>(
    q: &mut sqlx::QueryBuilder<'a, Engine>,
    parents: Option<B>,
) {
    match parents {
        None => q.push("NOT EXISTS(SELECT 1 FROM tamoss_flows child JOIN tamoss_flows parent ON parent.flow_collection_ids @> ARRAY[child.id] WHERE child.source_id=source.id)"),
        Some(ids) => q.push("EXISTS(SELECT 1 FROM tamoss_flows child JOIN tamoss_flows parent ON parent.flow_collection_ids @> ARRAY[child.id] WHERE child.source_id=source.id AND parent.source_id=ANY(").push_bind(ids).push("))"),
    };
}

/// Selects the segments owned by `flow` or by one of its direct collection
/// members; callers append further `AND` conditions on `segment`.
pub const FLOW_SEGMENTS: &str = "SELECT 1 FROM (SELECT flow.id AS member_id UNION ALL SELECT unnest(flow.flow_collection_ids)) member JOIN tamoss_segments segment ON segment.flow_id=member.member_id WHERE true";

/// Flows whose collection contains one of the ids in `$1`.
pub const COLLECTING_FLOWS: &str = "flow.flow_collection_ids && $1";

/// `members(flow_id, member_id)`: each flow in `$1` paired with itself and with each member of its collection.
pub const TIMERANGE_MEMBERS: &str = "WITH members(flow_id,member_id) AS (SELECT flow.id,flow.id FROM tamoss_flows flow WHERE flow.id=ANY($1) UNION SELECT flow.id,member FROM tamoss_flows flow CROSS JOIN unnest(flow.flow_collection_ids) member WHERE flow.id=ANY($1))";

// The collection items are expanded differently on each engine, and their
// order comes from WITH ORDINALITY or json_each's key, so the whole query differs.
/// Collection relationships of the sources in `$1`, ordered for `source_relationships`.
pub const SOURCE_RELATIONSHIPS: &str = "SELECT target_source,kind,related_source,role FROM (SELECT parent.source_id target_source,0 kind,child.source_id related_source,item.value->>'role' role,parent.id flow_order,item.ordinality item_order FROM tamoss_flows parent CROSS JOIN LATERAL jsonb_array_elements(COALESCE(parent.record#>'{data,flow_collection}','[]'::jsonb)) WITH ORDINALITY item(value,ordinality) JOIN tamoss_flows child ON child.id=(item.value->>'id')::uuid WHERE parent.source_id=ANY($1) UNION ALL SELECT child.source_id target_source,1 kind,parent.source_id related_source,NULL role,parent.id flow_order,item.ordinality item_order FROM tamoss_flows parent CROSS JOIN LATERAL jsonb_array_elements(COALESCE(parent.record#>'{data,flow_collection}','[]'::jsonb)) WITH ORDINALITY item(value,ordinality) JOIN tamoss_flows child ON child.id=(item.value->>'id')::uuid WHERE child.source_id=ANY($1)) relationships ORDER BY target_source,kind,flow_order,item_order";

/// A NULL sort key with the type of a timestamp column.
pub const NULL_TIMESTAMP: &str = "NULL::timestamptz";
