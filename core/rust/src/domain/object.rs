// TASM browser adaptation of rust-tams-api (Apache-2.0); see NOTICE for changes.
use std::collections::BTreeSet;

use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::db::{MediaObjectRecord, StorageBackend};

#[derive(Clone, Debug, PartialEq)]
pub struct ObjectInstance {
    pub storage_backend: Option<StorageBackend>,
    pub storage_backend_id: Option<Uuid>,
    pub url: Option<String>,
    pub label: Option<String>,
    pub controlled: bool,
    pub presigned: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MediaObject {
    pub id: String,
    pub timerange: Option<String>,
    pub init_object_id: Option<String>,
    pub first_referenced_by_flow: Option<Uuid>,
    pub allocated_by_flow: Option<Uuid>,
    pub referenced_by_flows: BTreeSet<Uuid>,
    pub instances: Vec<ObjectInstance>,
    pub key_frame_count: Option<i64>,
    pub bytes_written: i64,
    pub object_kind: String,
    pub content_type: Option<String>,
    pub created: OffsetDateTime,
}

impl MediaObject {
    pub fn from_record(record: &MediaObjectRecord, backends: &[StorageBackend]) -> Self {
        let data = record.record.as_object();
        let uuid = |name: &str| {
            data.and_then(|v| v.get(name))
                .and_then(Value::as_str)
                .and_then(|v| v.parse().ok())
        };
        let instances = data
            .and_then(|v| v.get("instances"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|value| {
                let value = value.as_object()?;
                let storage_backend_id = value
                    .get("storage_backend_id")
                    .and_then(Value::as_str)
                    .and_then(|v| v.parse().ok());
                Some(ObjectInstance {
                    storage_backend: storage_backend_id
                        .and_then(|id| backends.iter().find(|backend| backend.id == id).cloned()),
                    storage_backend_id,
                    url: value.get("url").and_then(Value::as_str).map(str::to_owned),
                    label: value
                        .get("label")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    controlled: value
                        .get("controlled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    presigned: value
                        .get("presigned")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                })
            })
            .collect();
        let referenced_by_flows = record
            .referenced_by_flows
            .iter()
            .filter_map(|value| value.parse().ok())
            .collect();
        Self {
            id: record.id.clone(),
            timerange: data
                .and_then(|v| v.get("timerange"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            init_object_id: data
                .and_then(|v| v.get("init_object_id"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            first_referenced_by_flow: record
                .first_referenced_by_flow
                .or_else(|| uuid("first_referenced_by_flow")),
            allocated_by_flow: uuid("allocated_by_flow"),
            referenced_by_flows,
            instances,
            key_frame_count: data
                .and_then(|v| v.get("key_frame_count"))
                .and_then(Value::as_i64),
            bytes_written: data
                .and_then(|v| v.get("bytes_written"))
                .and_then(Value::as_i64)
                .unwrap_or(0),
            object_kind: record.object_kind.clone(),
            content_type: record.content_type.clone(),
            created: record.created_at,
        }
    }

    pub fn into_record(self, now: OffsetDateTime) -> MediaObjectRecord {
        let Self {
            id,
            timerange,
            init_object_id,
            first_referenced_by_flow,
            allocated_by_flow,
            referenced_by_flows,
            instances,
            key_frame_count,
            bytes_written,
            object_kind,
            content_type,
            created,
        } = self;
        let referenced_by_flows: Vec<_> = referenced_by_flows
            .into_iter()
            .map(|value| value.to_string())
            .collect();
        let instances: Vec<_> = instances
            .into_iter()
            .map(|instance| {
                json!({
                    "storage_backend_id": instance.storage_backend_id.or_else(|| instance.storage_backend.map(|value| value.id)),
                    "url": instance.url,
                    "label": instance.label,
                    "controlled": instance.controlled,
                    "presigned": instance.presigned,
                })
            })
            .collect();
        let record = json!({
            "id": id,
            "timerange": timerange,
            "init_object_id": init_object_id,
            "first_referenced_by_flow": first_referenced_by_flow,
            "allocated_by_flow": allocated_by_flow,
            "referenced_by_flows": referenced_by_flows,
            "instances": instances,
            "key_frame_count": key_frame_count,
            "bytes_written": bytes_written,
            "object_kind": object_kind,
            "content_type": content_type,
            "created": crate::domain::model::timestamp(created),
        });
        MediaObjectRecord {
            id,
            first_referenced_by_flow,
            referenced_by_flows,
            object_kind,
            content_type,
            record,
            created_at: created,
            updated_at: now,
        }
    }
}
