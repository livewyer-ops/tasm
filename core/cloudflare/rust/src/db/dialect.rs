//! Durable Object SQLite details used by the shared query modules in core/rust/src/db/.
pub use crate::sqlite as sqlx;
use serde_json::Value;
pub use sqlx::{Connection, Engine, Pool, RecordRow};
use std::borrow::Cow;

pub use sqlx::range_key;

/// The Durable Object runs one transaction at a time, so rows need no lock.
pub const FOR_UPDATE: &str = "";

/// The Durable Object runs one transaction at a time; this only checks that one is open.
pub async fn lock<'e, E>(executor: E, _key: &str) -> Result<(), super::DbError>
where
    E: sqlx::Executor<'e, Database = Engine>,
{
    executor
        .host()
        .call("transaction_check", Value::Null)
        .await?;
    Ok(())
}

/// The current time in the fixed-width text form the store compares as timestamps.
pub const NOW: &str = "(strftime('%Y-%m-%dT%H:%M:%f','now') || '000000Z')";

/// The Durable Object runs one transaction at a time, so writers need no locks.
pub const SERIALISED: bool = true;

/// `column` is one of the values in the JSON array parameter `placeholder`.
pub fn in_array(column: &str, placeholder: &str) -> String {
    format!("{column} IN (SELECT value FROM json_each({placeholder}))")
}

/// The number of elements in a JSON array column.
pub fn array_length(column: &str) -> String {
    format!("json_array_length({column})")
}

/// A webhook's `events` list contains the text parameter `$1`.
pub const WEBHOOK_HAS_EVENT: &str =
    "EXISTS(SELECT 1 FROM json_each(record, '$.data.events') WHERE value=$1)";

/// Appends a TAMS tag filter on the JSON tags `column` to a query.
pub(crate) fn append_tags<'a>(
    q: &mut sqlx::QueryBuilder<'a, Engine>,
    column: &str,
    filters: &'a super::records::TagFilters,
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

/// A query written in shared SQL, with parameters numbered `$n` as in PostgreSQL.
pub fn query(sql: &str) -> sqlx::Query {
    sqlx::query(&numbered(sql))
}

/// A single-value query written in shared SQL.
pub fn query_scalar<T: sqlx::Decode>(sql: &str) -> sqlx::Scalar<T> {
    sqlx::query_scalar(&numbered(sql))
}

/// SQLite reads `$1` as a named parameter indexed by first appearance, so
/// rewrite each `$n` parameter token to `?n`. Quoted strings and identifiers,
/// comments and identifiers that contain `$` are left alone.
fn numbered(sql: &str) -> Cow<'_, str> {
    if !sql.contains('$') {
        return sql.into();
    }
    let bytes = sql.as_bytes();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    while i < bytes.len() {
        let start = i;
        match bytes[i] {
            quote @ (b'\'' | b'"' | b'`') => {
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == quote {
                        // A doubled quote is an escaped quote inside the text.
                        if bytes.get(i + 1) == Some(&quote) {
                            i += 2;
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    i += 1;
                }
            }
            b'[' => i = sql[i..].find(']').map_or(bytes.len(), |end| i + end + 1),
            b'-' if bytes.get(i + 1) == Some(&b'-') => {
                i = sql[i..].find('\n').map_or(bytes.len(), |end| i + end)
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i = sql[i + 2..]
                    .find("*/")
                    .map_or(bytes.len(), |end| i + 2 + end + 2)
            }
            b'$' if bytes.get(i + 1).is_some_and(u8::is_ascii_digit)
                && !(i > 0
                    && (bytes[i - 1].is_ascii_alphanumeric()
                        || matches!(bytes[i - 1], b'_' | b'$')
                        || !bytes[i - 1].is_ascii())) =>
            {
                out.push('?');
                i += 1;
                continue;
            }
            _ => i += sql[i..].chars().next().map_or(1, char::len_utf8),
        }
        out.push_str(&sql[start..i]);
    }
    out.into()
}

/// Appends a test that the JSON text at `path` in `column` equals `value`.
pub fn push_json_text_eq<'a, B: sqlx::Bind + 'a>(
    q: &mut sqlx::QueryBuilder<'a, Engine>,
    column: &str,
    path: &[&str],
    value: B,
) {
    q.push(format!("json_extract({column}, '$.{}')=", path.join(".")))
        .push_bind(value);
}

/// Appends a test that the JSON integer at `path` in `column` equals `value`.
pub fn push_json_int_eq<'a, B: sqlx::Bind + 'a>(
    q: &mut sqlx::QueryBuilder<'a, Engine>,
    column: &str,
    path: &[&str],
    value: B,
) {
    push_json_text_eq(q, column, path, value);
}

/// Appends a test that `column` is one of `values`.
pub fn push_in_array<'a, B: sqlx::Bind + 'a>(
    q: &mut sqlx::QueryBuilder<'a, Engine>,
    column: &str,
    values: B,
) {
    q.push(column)
        .push(" IN (SELECT value FROM json_each(")
        .push_bind(values)
        .push("))");
}

/// Appends a test that the flow is collected by one of `parents`, or by no flow when `None`.
pub fn push_flow_collected_by<'a, B: sqlx::Bind + 'a>(
    q: &mut sqlx::QueryBuilder<'a, Engine>,
    parents: Option<B>,
) {
    match parents {
        None => q.push("NOT EXISTS(SELECT 1 FROM tamoss_flow_collection_members member WHERE member.child_id=flow.id)"),
        Some(ids) => q.push("EXISTS(SELECT 1 FROM tamoss_flow_collection_members member WHERE member.child_id=flow.id AND member.parent_id IN (SELECT value FROM json_each(").push_bind(ids).push(")))"),
    };
}

/// Appends a test that one of the source's flows is collected by a flow of one of the
/// `parents` sources, or by no flow when `None`.
pub fn push_source_collected_by<'a, B: sqlx::Bind + 'a>(
    q: &mut sqlx::QueryBuilder<'a, Engine>,
    parents: Option<B>,
) {
    match parents {
        None => q.push("NOT EXISTS(SELECT 1 FROM tamoss_flows child JOIN tamoss_flow_collection_members member ON member.child_id=child.id WHERE child.source_id=source.id)"),
        Some(ids) => q.push("EXISTS(SELECT 1 FROM tamoss_flows child JOIN tamoss_flow_collection_members member ON member.child_id=child.id JOIN tamoss_flows parent ON parent.id=member.parent_id WHERE child.source_id=source.id AND parent.source_id IN (SELECT value FROM json_each(").push_bind(ids).push(")))"),
    };
}

/// Selects the segments owned by `flow` or by one of its direct collection
/// members; callers append further `AND` conditions on `segment`.
pub const FLOW_SEGMENTS: &str = "SELECT 1 FROM (SELECT flow.id AS member_id UNION ALL SELECT child_id FROM tamoss_flow_collection_members WHERE parent_id=flow.id) member JOIN tamoss_segments segment ON segment.flow_id=member.member_id WHERE true";

/// Flows whose collection contains one of the ids in `$1`.
pub const COLLECTING_FLOWS: &str = "flow.id IN (SELECT member.parent_id FROM tamoss_flow_collection_members member WHERE member.child_id IN (SELECT value FROM json_each($1)))";

/// `members(flow_id, member_id)`: each flow in `$1` paired with itself and with each member of its collection.
pub const TIMERANGE_MEMBERS: &str = "WITH requested(id) AS (SELECT value FROM json_each($1)), members(flow_id,member_id) AS (SELECT flow.id,flow.id FROM tamoss_flows flow WHERE flow.id IN requested UNION SELECT member.parent_id,member.child_id FROM tamoss_flow_collection_members member WHERE member.parent_id IN requested)";

// The collection items are expanded differently on each engine, and their
// order comes from WITH ORDINALITY or json_each's key, so the whole query differs.
/// Collection relationships of the sources in `$1`, ordered for `source_relationships`.
pub const SOURCE_RELATIONSHIPS: &str = "SELECT target_source,kind,related_source,role,flow_order FROM (SELECT parent.source_id target_source,0 kind,child.source_id related_source,item.value->>'role' role,parent.id flow_order,item.key item_order FROM tamoss_flows parent CROSS JOIN json_each(COALESCE(json_extract(parent.record, '$.data.flow_collection'),'[]')) AS item JOIN tamoss_flows child ON child.id=(item.value->>'id') WHERE parent.source_id IN (SELECT value FROM json_each($1)) UNION ALL SELECT child.source_id target_source,1 kind,parent.source_id related_source,NULL role,parent.id flow_order,item.key item_order FROM tamoss_flows parent CROSS JOIN json_each(COALESCE(json_extract(parent.record, '$.data.flow_collection'),'[]')) AS item JOIN tamoss_flows child ON child.id=(item.value->>'id') WHERE child.source_id IN (SELECT value FROM json_each($1))) relationships ORDER BY target_source,kind,flow_order,item_order";

/// A NULL sort key with the type of a timestamp column.
pub const NULL_TIMESTAMP: &str = "NULL";

#[cfg(test)]
mod tests {
    use super::numbered;
    #[test]
    fn shared_parameters_become_numbered_sqlite_parameters() {
        assert_eq!(numbered("SELECT ?1"), "SELECT ?1");
        assert_eq!(numbered("SELECT $2,$1,$10"), "SELECT ?2,?1,?10");
        assert_eq!(
            numbered("SELECT json_extract(r,'$.a'),'$1','it''s $1' FROM t WHERE x=$1"),
            "SELECT json_extract(r,'$.a'),'$1','it''s $1' FROM t WHERE x=?1"
        );
        assert_eq!(
            numbered(r#"SELECT "cost$1",`a$2`,[b$3],cost$1 FROM ledger WHERE id=$2"#),
            r#"SELECT "cost$1",`a$2`,[b$3],cost$1 FROM ledger WHERE id=?2"#
        );
        assert_eq!(
            numbered("SELECT $2 -- isn't $1\n,$1 /* don't $3 */ ,$3"),
            "SELECT ?2 -- isn't $1\n,?1 /* don't $3 */ ,?3"
        );
        assert_eq!(
            numbered("SELECT 'é$1', café$1, $1"),
            "SELECT 'é$1', café$1, ?1"
        );
    }
}
