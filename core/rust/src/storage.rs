use crate::db::{self, PageRequest, StorageBackend, TagFilters};
use crate::sql::Pool;
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("storage backend is not configured: {0}")]
    Configuration(String),
    #[error(transparent)]
    Db(#[from] db::DbError),
    #[error(transparent)]
    Host(#[from] crate::host::Error),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectMetadata {
    pub content_length: Option<i64>,
    pub content_type: Option<String>,
    pub etag: Option<String>,
    pub checksum: Option<String>,
    pub observed_at: OffsetDateTime,
}
#[derive(Clone)]
pub struct StorageFactory {
    pool: Pool,
}
impl StorageFactory {
    pub fn new(pool: Pool) -> Self {
        Self { pool }
    }
    pub async fn backends(&self) -> Result<Vec<StorageBackend>, StorageError> {
        Ok(db::service::list_storage_backends(
            &self.pool,
            &TagFilters::default(),
            false,
            &PageRequest {
                offset: 0,
                limit: 1000,
            },
        )
        .await?
        .items)
    }
    pub async fn backend(&self, id: Uuid) -> Result<Option<StorageBackend>, StorageError> {
        Ok(db::service::get_storage_backend(&self.pool, id).await?)
    }
    pub async fn default_backend(&self) -> Result<Option<StorageBackend>, StorageError> {
        Ok(db::service::default_storage_backend(&self.pool).await?)
    }
    pub async fn object_url(
        &self,
        backend: &StorageBackend,
        object_id: &str,
        method: &str,
        presigned: bool,
        content_type: Option<&str>,
    ) -> Result<String, StorageError> {
        let value = self
            .pool
            .0
            .call(
                "url",
                json!({
                    "backend":backend.id,"id":object_id,"method":method,
                    "presigned":presigned,"contentType":content_type
                }),
            )
            .await?;
        value
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| StorageError::Configuration("Invalid object URL".into()))
    }
    pub async fn upload_sizes(
        &self,
        pending: Vec<(String, StorageBackend)>,
    ) -> Result<BTreeMap<String, Option<i64>>, StorageError> {
        if pending.is_empty() {
            return Ok(BTreeMap::new());
        }
        if !SIGNED_URLS {
            let objects: Vec<_> = pending
                .iter()
                .map(|(id, b)| json!({"id": id, "backend": b.id}))
                .collect();
            let result = self
                .pool
                .0
                .call("upload_sizes", json!({ "objects": objects }))
                .await?;
            return serde_json::from_value(result)
                .map_err(|_| StorageError::Configuration("Invalid upload sizes".into()));
        }
        futures_util::stream::iter(pending.into_iter().map(|(id, backend)| async move {
            let size = self
                .head_optional(&backend, &id)
                .await?
                .map(|v| v.content_length.unwrap_or(0));
            Ok((id, size))
        }))
        .buffer_unordered(8)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .collect()
    }

    pub async fn head_optional(
        &self,
        backend: &StorageBackend,
        id: &str,
    ) -> Result<Option<ObjectMetadata>, StorageError> {
        let v = self
            .pool
            .0
            .call("head", json!({"backend":backend.id, "id":id}))
            .await?;
        if v.is_null() {
            return Ok(None);
        }
        let text = |key| v.get(key).and_then(Value::as_str).map(str::to_owned);
        Ok(Some(ObjectMetadata {
            content_length: v["size"].as_i64(),
            content_type: text("contentType"),
            etag: text("etag"),
            checksum: text("checksum"),
            observed_at: crate::now(),
        }))
    }
    pub async fn head(
        &self,
        backend: &StorageBackend,
        id: &str,
    ) -> Result<ObjectMetadata, StorageError> {
        self.head_optional(backend, id)
            .await?
            .ok_or_else(|| StorageError::Configuration("object bytes missing".into()))
    }
    pub async fn copy(
        &self,
        source: &StorageBackend,
        destination: &StorageBackend,
        id: &str,
        allocation_id: &str,
    ) -> Result<(), StorageError> {
        self.pool
            .0
            .call(
                "copy",
                json!({"source": source.id, "destination": destination.id, "id": id, "allocationId": allocation_id}),
            )
            .await?;
        Ok(())
    }
    pub async fn delete(
        &self,
        backend: &StorageBackend,
        allocations: impl IntoIterator<Item = Value>,
    ) -> Result<(), StorageError> {
        self.pool
            .0
            .call(
                "delete",
                json!({"backend": backend.id, "allocations": allocations.into_iter().collect::<Vec<_>>()}),
            )
            .await?;
        Ok(())
    }
}

pub use crate::config::SIGNED_URLS;
