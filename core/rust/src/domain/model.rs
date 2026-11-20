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

pub fn uuid_field(map: &Map<String, Value>, name: &str) -> Result<Uuid, ValidationError> {
    map.get(name)
        .and_then(Value::as_str)
        .ok_or(ValidationError)?
        .parse()
        .map_err(|_| ValidationError)
}

pub fn optional_uuid_field(
    map: &Map<String, Value>,
    name: &str,
) -> Result<Option<Uuid>, ValidationError> {
    match map.get(name) {
        None => Ok(None),
        Some(Value::String(value)) if value.is_empty() => Ok(None),
        Some(Value::String(value)) => value.parse().map(Some).map_err(|_| ValidationError),
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
    map.remove("created_by");
    map.remove("updated_by");
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
pub fn flow_data(record: &mut Value) -> &mut Map<String, Value> {
    if !record.is_object() {
        *record = json!({});
    }
    let outer = record.as_object_mut().unwrap();
    if !outer.get("data").is_some_and(Value::is_object) {
        outer.insert("data".into(), json!({}));
    }
    outer.get_mut("data").unwrap().as_object_mut().unwrap()
}
