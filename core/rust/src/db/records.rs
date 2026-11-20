// TASM browser adaptation of rust-tams-api (Apache-2.0); see NOTICE for changes.
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

pub type Tags = BTreeMap<String, Value>;

#[derive(Debug, Clone, PartialEq)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub limit: i64,
    pub next_page: Option<String>,
    pub timerange: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageRequest {
    pub offset: i64,
    pub limit: i64,
}
impl PageRequest {
    pub fn parse(page: Option<&str>, limit: Option<i64>) -> Result<Self, super::InvalidPage> {
        let limit = match limit {
            None | Some(0) => 100,
            Some(limit) if limit < 0 => return Err(super::InvalidPage),
            Some(limit) => limit.min(1000),
        };
        let offset = match page {
            None | Some("") => 0,
            Some(page) => page.parse::<i64>().map_err(|_| super::InvalidPage)?,
        };
        if offset < 0 {
            return Err(super::InvalidPage);
        }
        Ok(Self { offset, limit })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TagFilters {
    pub values: BTreeMap<String, BTreeSet<String>>,
    pub exists: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServiceMetadata {
    pub name: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StorageBackend {
    pub id: Uuid,
    pub label: String,
    pub provider: String,
    pub region: String,
    pub store_product: String,
    pub store_type: String,
    pub default_storage: bool,
    pub bucket_name: Option<String>,
    pub endpoint_url: Option<String>,
    pub public_endpoint_url: Option<String>,
    pub tags: Tags,
    pub record: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProfileRecord {
    pub id: Uuid,
    pub format: String,
    pub codec: Option<String>,
    pub label: Option<String>,
    pub tags: Tags,
    pub record: Value,
    pub created: OffsetDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SourceRecord {
    pub id: Uuid,
    pub format: Option<String>,
    pub label: Option<String>,
    pub tags: Tags,
    pub record: Value,
    pub metadata_updated: OffsetDateTime,
    pub created: OffsetDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FlowRecord {
    pub id: Uuid,
    pub source_id: Option<Uuid>,
    pub format: Option<String>,
    pub container: Option<String>,
    pub profile_id: Option<Uuid>,
    pub status: Option<String>,
    pub init_segments: bool,
    pub label: Option<String>,
    pub flow_collection_ids: Vec<Uuid>,
    pub read_only: bool,
    pub tags: Tags,
    pub record: Value,
    pub metadata_updated: OffsetDateTime,
    pub created: OffsetDateTime,
    pub segments_updated: Option<OffsetDateTime>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SegmentRecord {
    pub flow_id: Uuid,
    pub object_id: String,
    pub init_object_id: Option<String>,
    pub timerange: String,
    pub timerange_start: i128,
    pub timerange_end: i128,
    pub record: Value,
    pub created: OffsetDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MediaObjectRecord {
    pub id: String,
    pub first_referenced_by_flow: Option<Uuid>,
    pub referenced_by_flows: Vec<String>,
    pub object_kind: String,
    pub content_type: Option<String>,
    pub record: Value,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WebhookRecord {
    pub id: Uuid,
    pub status: String,
    pub tags: Tags,
    pub record: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeleteRequest {
    pub id: Uuid,
    pub flow_id: Uuid,
    pub status: String,
    pub record: Value,
    pub updated: OffsetDateTime,
    pub created_at: OffsetDateTime,
    pub claimed_at: Option<OffsetDateTime>,
    pub claimed_by: Option<String>,
    pub claim_expires_at: Option<OffsetDateTime>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ObjectCleanup {
    pub id: Uuid,
    pub delete_request_id: Option<Uuid>,
    pub object_id: String,
    pub storage_backend_id: Uuid,
    pub status: String,
    pub record: Value,
    pub updated: OffsetDateTime,
    pub created_at: OffsetDateTime,
    pub claimed_at: Option<OffsetDateTime>,
    pub claimed_by: Option<String>,
    pub claim_expires_at: Option<OffsetDateTime>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ObjectCopy {
    pub id: Uuid,
    pub object_id: String,
    pub source_storage_backend_id: Uuid,
    pub destination_storage_backend_id: Uuid,
    pub status: String,
    pub record: Value,
    pub updated: OffsetDateTime,
    pub created_at: OffsetDateTime,
    pub claimed_at: Option<OffsetDateTime>,
    pub claimed_by: Option<String>,
    pub claim_expires_at: Option<OffsetDateTime>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WebhookDelivery {
    pub id: Uuid,
    pub webhook_id: Uuid,
    pub status: String,
    pub next_attempt_at: Option<OffsetDateTime>,
    pub record: Value,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
    pub claimed_at: Option<OffsetDateTime>,
    pub claimed_by: Option<String>,
    pub claim_expires_at: Option<OffsetDateTime>,
}

pub fn finish_page<T>(mut items: Vec<T>, request: &PageRequest) -> Page<T> {
    let more = items.len() > request.limit as usize;
    if more {
        items.pop();
    }
    let next_page = more.then(|| (request.offset + request.limit).to_string());
    Page {
        items,
        limit: request.limit,
        next_page,
        timerange: None,
    }
}
