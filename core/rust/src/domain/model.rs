// TASM browser adaptation of rust-tams-api (Apache-2.0); see NOTICE for changes.
use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use super::ValidationError;
use crate::db::{
    FlowRecord, ProfileRecord, SourceRecord, StorageBackend, TagFilters, Tags, WebhookRecord,
};

pub const FORMATS: &[&str] = &[
    "urn:x-nmos:format:video",
    "urn:x-nmos:format:audio",
    "urn:x-tam:format:image",
    "urn:x-nmos:format:data",
    "urn:x-nmos:format:multi",
];
pub const FLOW_STATUSES: &[&str] = &[
    "awaiting_content",
    "ingesting",
    "replication_in_progress",
    "closed_complete",
];
pub const WEBHOOK_EVENTS: &[&str] = &[
    "flows/created",
    "flows/updated",
    "flows/deleted",
    "flows/segments_added",
    "flows/segments_deleted",
    "sources/created",
    "sources/updated",
    "sources/deleted",
];

pub fn object(value: Value) -> Result<Map<String, Value>, ValidationError> {
    value.as_object().cloned().ok_or(ValidationError)
}

/// UUID spelling accepted by the TAMS wire schemas.
pub fn parse_uuid(value: &str) -> Result<Uuid, ValidationError> {
    let id = Uuid::try_parse(value).map_err(|_| ValidationError)?;
    if !(1..=5).contains(&id.get_version_num())
        || id.get_variant() != uuid::Variant::RFC4122
        || id.hyphenated().encode_lower(&mut Uuid::encode_buffer()) != value
    {
        return Err(ValidationError);
    }
    Ok(id)
}

pub fn uuid_field(map: &Map<String, Value>, name: &str) -> Result<Uuid, ValidationError> {
    parse_uuid(
        map.get(name)
            .and_then(Value::as_str)
            .ok_or(ValidationError)?,
    )
}

pub fn optional_uuid_field(
    map: &Map<String, Value>,
    name: &str,
) -> Result<Option<Uuid>, ValidationError> {
    match map.get(name) {
        None => Ok(None),
        Some(Value::String(value)) if value.is_empty() => Ok(None),
        Some(Value::String(value)) => parse_uuid(value).map(Some),
        Some(_) => Err(ValidationError),
    }
}

pub fn tags(value: Option<&Value>) -> Result<Tags, ValidationError> {
    let Some(value) = value else {
        return Ok(Tags::new());
    };
    let object = value.as_object().ok_or(ValidationError)?;
    object
        .iter()
        .map(|(name, value)| {
            if name.is_empty() || !tag_value(value) {
                return Err(ValidationError);
            }
            Ok((name.clone(), value.clone()))
        })
        .collect()
}

pub fn tag_value(value: &Value) -> bool {
    value.as_str().is_some()
        || value
            .as_array()
            .is_some_and(|values| values.iter().all(|value| value.as_str().is_some()))
}

pub fn tag_filters(
    values: BTreeMap<String, BTreeSet<String>>,
    exists: BTreeMap<String, bool>,
) -> Result<TagFilters, ValidationError> {
    if values.keys().chain(exists.keys()).any(String::is_empty) {
        return Err(ValidationError);
    }
    Ok(TagFilters { values, exists })
}

/// Decode integer literals directly so large values never pass through a float.
pub fn integer(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        let number = value.as_number()?;
        if !number.is_f64() {
            return None;
        }
        let float = number.as_f64()?;
        (float.fract() == 0.0 && float.abs() < 9_007_199_254_740_992.0).then_some(float as i64)
    })
}

pub fn timestamp(value: OffsetDateTime) -> String {
    value
        .format(&Rfc3339)
        .expect("OffsetDateTime is RFC3339 representable")
}

fn without_nulls(mut value: Value) -> Value {
    if let Some(map) = value.as_object_mut() {
        map.retain(|_, value| !value.is_null());
    }
    value
}

pub fn profile(record: &ProfileRecord) -> Value {
    let mut value = record.record.clone();
    if !value.is_object() {
        value = json!({});
    }
    let map = value.as_object_mut().unwrap();
    map.insert("id".into(), json!(record.id));
    let flow_metadata = map.remove("flow_metadata").unwrap_or_else(|| json!({}));
    map.insert("flow_metadata".into(), flow_metadata);
    map.insert("tags".into(), json!(record.tags));
    map.insert("created".into(), json!(timestamp(record.created)));
    without_nulls(value)
}

pub fn storage_backend(record: &StorageBackend) -> Value {
    json!({
        "id": record.id, "label": record.label, "default_storage": record.default_storage,
        "store_type": record.store_type, "provider": record.provider, "region": record.region,
        "store_product": record.store_product, "tags": record.tags,
    })
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SourceRelationships {
    pub source_collection: Vec<Value>,
    pub collected_by: Vec<Uuid>,
}

/// Combine the ordering and optional roles supplied by each representation.
pub fn source_collection(members: &[(Uuid, Uuid, Option<String>)]) -> Option<Vec<Value>> {
    let mut indices = BTreeMap::new();
    let mut items: Vec<(Uuid, Option<&str>)> = Vec::new();
    let mut successors: Vec<BTreeSet<usize>> = Vec::new();
    let mut incoming = Vec::new();
    let mut previous: Option<(Uuid, usize)> = None;
    for (flow, source, role) in members {
        let index = *indices.entry(*source).or_insert_with(|| {
            items.push((*source, None));
            successors.push(BTreeSet::new());
            incoming.push(0usize);
            items.len() - 1
        });
        if let Some(role) = role.as_deref() {
            if items[index].1.is_some_and(|known| known != role) {
                return None;
            }
            items[index].1 = Some(role);
        }
        if let Some((parent, before)) = previous
            && parent == *flow
            && before != index
            && successors[before].insert(index)
        {
            incoming[index] += 1;
        }
        previous = Some((*flow, index));
    }
    // Preserve first appearance when multiple members can occupy the next position.
    let mut ready: BTreeSet<_> = (0..items.len()).filter(|&i| incoming[i] == 0).collect();
    let mut result = Vec::with_capacity(items.len());
    while let Some(index) = ready.pop_first() {
        let (id, role) = items[index];
        result.push(without_nulls(json!({"id":id,"role":role})));
        for &next in &successors[index] {
            incoming[next] -= 1;
            if incoming[next] == 0 {
                ready.insert(next);
            }
        }
    }
    (result.len() == items.len()).then_some(result)
}

pub fn source(record: &SourceRecord, relationships: Option<&SourceRelationships>) -> Value {
    let mut value = record.record.clone();
    if !value.is_object() {
        value = json!({});
    }
    let map = value.as_object_mut().unwrap();
    map.insert("id".into(), json!(record.id));
    map.insert("format".into(), json!(record.format));
    map.insert("label".into(), json!(record.label));
    map.insert("tags".into(), json!(record.tags));
    map.insert("created".into(), json!(timestamp(record.created)));
    map.insert("updated".into(), json!(timestamp(record.metadata_updated)));
    map.remove("metadata_updated");
    if let Some(relationships) = relationships {
        map.insert(
            "source_collection".into(),
            json!(relationships.source_collection),
        );
        map.insert("collected_by".into(), json!(relationships.collected_by));
    }
    without_nulls(value)
}

pub fn flow(record: &FlowRecord, collected_by: &[Uuid], timerange: Option<&str>) -> Value {
    let mut value = record
        .record
        .get("data")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !value.is_object() {
        value = json!({});
    }
    let map = value.as_object_mut().unwrap();
    map.insert("id".into(), json!(record.id));
    map.insert("source_id".into(), json!(record.source_id));
    map.insert("format".into(), json!(record.format));
    map.insert("profile_id".into(), json!(record.profile_id));
    map.insert("status".into(), json!(record.status));
    map.insert("read_only".into(), json!(record.read_only));
    map.insert("tags".into(), json!(record.tags));
    map.insert("created".into(), json!(timestamp(record.created)));
    map.insert(
        "metadata_updated".into(),
        json!(timestamp(record.metadata_updated)),
    );
    map.insert(
        "segments_updated".into(),
        json!(record.segments_updated.map(timestamp)),
    );
    if !collected_by.is_empty() {
        map.insert("collected_by".into(), json!(collected_by));
    }
    if let Some(timerange) = timerange {
        map.insert("timerange".into(), json!(timerange));
    }
    without_nulls(value)
}

pub fn webhook(record: &WebhookRecord) -> Value {
    let mut data = record
        .record
        .get("data")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    data.remove("api_key_value");
    data.remove("id");
    data.remove("status");
    data.remove("tags");
    if let Some(error) = record.record.get("error").filter(|value| !value.is_null()) {
        data.insert("error".into(), error.clone());
    }
    data.insert("id".into(), json!(record.id));
    data.insert("status".into(), json!(record.status));
    data.insert("tags".into(), json!(record.tags));
    without_nulls(Value::Object(data))
}
#[cfg(test)]
mod uuid_tests {
    use super::parse_uuid;

    #[test]
    fn matches_the_wire_schema() {
        let id = "abcdef12-3456-4abc-89ab-0123456789ab";
        for version in 1..=5 {
            for variant in ['8', '9', 'a', 'b'] {
                let valid = format!("abcdef12-3456-{version}abc-{variant}9ab-0123456789ab");
                assert_eq!(parse_uuid(&valid).unwrap().to_string(), valid);
            }
        }
        for invalid in [
            id.to_uppercase(),
            id.replace('-', ""),
            format!("urn:uuid:{id}"),
            format!("{{{id}}}"),
            id.replace("-4abc", "-0abc"),
            id.replace("-4abc", "-6abc"),
            id.replace("-89ab", "-79ab"),
            id.replace("-89ab", "-c9ab"),
        ] {
            assert!(parse_uuid(&invalid).is_err(), "{invalid}");
        }
    }
}

#[cfg(test)]
mod collection_tests {
    use super::*;

    #[test]
    fn combines_partial_order_and_roles_and_rejects_a_cycle() {
        let [one, two, three, a, b, c] = [1, 2, 3, 4, 5, 6].map(Uuid::from_u128);
        let mut members = vec![
            (one, b, None),
            (one, c, None),
            (two, a, None),
            (two, b, Some("main".into())),
        ];
        assert_eq!(
            source_collection(&members),
            Some(vec![
                json!({"id":a}),
                json!({"id":b,"role":"main"}),
                json!({"id":c})
            ])
        );
        members.extend([(three, c, None), (three, a, None)]);
        assert_eq!(source_collection(&members), None);
    }
}
