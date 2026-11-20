// Cloudflare adaptation of TASM and rust-tams-api (Apache-2.0); see NOTICE.
use crate::sql as sqlx;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
use web_time::Instant;

use serde_json::{Value, json};
use sqlx::Row;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{
    config::Settings,
    db::{
        self, Database, MediaObjectRecord, ObjectCleanup, SegmentRecord, StorageBackend,
        WebhookDelivery,
    },
    domain::{
        model,
        object::{MediaObject, ObjectInstance},
        timerange,
    },
    storage::{StorageError, StorageFactory},
    webhooks::{self, WebhookError, WebhookPolicy},
};

#[derive(Debug, thiserror::Error)]
pub enum WorkerError {
    #[error(transparent)]
    Db(#[from] db::DbError),
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error("worker queue configuration exceeds supported bounds")]
    Bounds,
}

#[derive(Clone)]
pub struct Worker {
    database: Database,
    storage: StorageFactory,
    settings: Arc<Settings>,
}

impl Worker {
    pub fn new(database: Database, settings: Arc<Settings>) -> Self {
        let storage = StorageFactory::new(database.clone());
        Self {
            database,
            storage,
            settings,
        }
    }

    pub async fn poll_once(&self) -> Result<u64, WorkerError> {
        let limit =
            i64::try_from(self.settings.worker_max_requests).map_err(|_| WorkerError::Bounds)?;
        let lease =
            i64::try_from(self.settings.worker_lease_seconds).map_err(|_| WorkerError::Bounds)?;
        let retention = i64::try_from(self.settings.worker_queue_retention_seconds)
            .map_err(|_| WorkerError::Bounds)?;
        // Run every stage even when an earlier one fails, so one broken queue
        // cannot stop the others. The first error is returned afterwards.
        let mut processed = 0;
        let mut first_error = None;
        let mut stage = |name: &str, result: Result<u64, WorkerError>| match result {
            Ok(count) => processed += count,
            Err(error) => {
                tracing::error!(stage = name, error = %redacted(&error.to_string()), "worker stage failed");
                first_error.get_or_insert(error);
            }
        };
        if self.settings.worker_enable_delete {
            stage(
                "delete_requests",
                self.process_delete_requests(limit, lease).await,
            );
            stage("copies", self.process_copies(limit, lease).await);
            stage(
                "stale_allocations",
                self.queue_stale_allocations(limit).await,
            );
            stage("cleanups", self.process_cleanups(limit, lease).await);
        }
        if self.settings.worker_enable_webhook {
            stage("webhooks", self.process_webhooks(limit, lease).await);
        }
        let purged = async {
            let pool = self.database.pool().await?;
            db::queues::purge(&pool, retention, 1000).await?;
            Ok(0)
        };
        stage("purge", purged.await);
        first_error.map_or(Ok(processed), Err)
    }

    async fn process_delete_requests(&self, limit: i64, lease: i64) -> Result<u64, WorkerError> {
        let pool = self.database.pool().await?;
        let requests =
            db::queues::claim_delete_requests(&pool, &self.settings.worker_id, limit, lease)
                .await?;
        for request in &requests {
            if let Err(error) = self
                .process_delete_request(request.id, request.flow_id, &request.record, lease)
                .await
            {
                tracing::error!(request_id=%request.id, error=%redacted(&error.to_string()), "delete request processing failed");
                db::queues::fail_delete_request(
                    &pool,
                    request.id,
                    &self.settings.worker_id,
                    queue_error(
                        "delete_request_failed",
                        "Delete request processing failed; retry will continue.",
                    ),
                )
                .await?;
            }
        }
        Ok(requests.len() as u64)
    }

    async fn process_delete_request(
        &self,
        id: Uuid,
        flow_id: Uuid,
        record: &Value,
        lease: i64,
    ) -> Result<(), WorkerError> {
        let pool = self.database.pool().await?;
        let delete_flow = record
            .get("delete_flow")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let Some((start, end)) = delete_range(record, delete_flow)? else {
            // The segment phase committed earlier; only object cleanup is left.
            return self.finish_delete_request(id, lease).await;
        };
        let mut transaction = pool.begin().await.map_err(db::DbError::from)?;
        db::flows::lock_flow_segments(&mut *transaction, flow_id).await?;
        let mut flow = db::flows::get_flow_with(&mut *transaction, flow_id).await?;
        let mut parents = db::flows::list_flows_collecting(&mut *transaction, &[flow_id]).await?;
        let parent_ids = parents.iter().map(|value| value.id).collect::<Vec<_>>();
        let source_ids = flow
            .as_ref()
            .and_then(|value| value.source_id)
            .into_iter()
            .collect::<Vec<_>>();
        let source_relationships =
            db::flows::source_relationships(&mut *transaction, &source_ids).await?;
        let source_parents = source_ids
            .first()
            .and_then(|source_id| source_relationships.get(source_id))
            .map(|value| value.collected_by.clone())
            .unwrap_or_default();
        let rows = sqlx::query(crate::db::statements::DELETE_SEGMENTS)
            .bind(flow_id)
            .bind(start)
            .bind(end)
            .fetch_all(&mut *transaction)
            .await
            .map_err(db::DbError::from)?;
        let deleted_segments = rows
            .into_iter()
            .map(segment_record)
            .collect::<Result<Vec<_>, _>>()?;
        let object_ids = deleted_segments
            .iter()
            .flat_map(|segment| {
                [
                    Some(segment.object_id.clone()),
                    segment.init_object_id.clone(),
                ]
            })
            .flatten()
            .collect::<BTreeSet<_>>();
        if !object_ids.is_empty() {
            db::objects::lock_sorted(&mut transaction, object_ids.clone()).await?;
        }
        let now: OffsetDateTime = sqlx::query_scalar(crate::db::statements::DATABASE_TIME)
            .fetch_one(&mut *transaction)
            .await
            .map_err(db::DbError::from)?;
        for object_id in object_ids {
            let Some(row) = sqlx::query(crate::db::statements::GET_OBJECT)
                .bind(&object_id)
                .fetch_optional(&mut *transaction)
                .await
                .map_err(db::DbError::from)?
            else {
                continue;
            };
            let media_record = media_record(row)?;
            let referenced_by =
                sqlx::query_scalar::<Uuid>(crate::db::statements::REFERENCING_FLOWS)
                    .bind(&object_id)
                    .fetch_all(&mut *transaction)
                    .await
                    .map_err(db::DbError::from)?;
            if referenced_by.is_empty() {
                for backend_id in controlled_backend_ids(&media_record.record) {
                    let cleanup_id = Uuid::new_v4();
                    db::queues::save_cleanup(
                        &mut *transaction,
                        &ObjectCleanup {
                            id: cleanup_id,
                            delete_request_id: Some(id),
                            object_id: object_id.clone(),
                            storage_backend_id: backend_id,
                            status: "pending".into(),
                            record: json!({
                                "id":cleanup_id,
                                "delete_request_id":id,
                                "object_id":object_id,
                                "storage_backend_id":backend_id,
                                "status":"pending",
                                "created":model::timestamp(now),
                                "updated":model::timestamp(now),
                                "attempt_count":0
                            }),
                            updated: now,
                            created_at: now,
                            claimed_at: None,
                            claimed_by: None,
                            claim_expires_at: None,
                        },
                    )
                    .await?;
                }
                db::objects::delete(&mut *transaction, &object_id).await?;
                continue;
            }
            let mut media = MediaObject::from_record(&media_record, &[]);
            // The object's timerange is on its own timeline and does not depend
            // on which flows still reference it.
            media.referenced_by_flows = referenced_by.into_iter().collect();
            db::objects::save(&mut *transaction, &media.into_record(now)).await?;
        }
        let remaining_bounds = sqlx::query(crate::db::statements::REMAINING_BOUNDS)
            .bind(flow_id)
            .bind(start)
            .bind(end)
            .fetch_one(&mut *transaction)
            .await
            .map_err(db::DbError::from)?;
        let remaining_start: Option<i128> =
            remaining_bounds.try_get(0).map_err(db::DbError::from)?;
        let remaining_end: Option<i128> = remaining_bounds.try_get(1).map_err(db::DbError::from)?;
        let remaining = remaining_start.is_some() || remaining_end.is_some();
        // Record progress in the same transaction as the deletion, so a retry
        // never repeats a committed segment phase. "()" means nothing remains.
        sqlx::query(crate::db::statements::UPDATE_REMAINING)
            .bind(id)
            .bind(if remaining {
                timerange::from_bounds(remaining_start, remaining_end)
            } else {
                "()".into()
            })
            .bind(&self.settings.worker_id)
            .execute(&mut *transaction)
            .await
            .map_err(db::DbError::from)?;
        if delete_flow && !remaining && flow.is_some() {
            let flow_id_text = flow_id.to_string();
            for parent in &mut parents {
                if parent.id == flow_id {
                    continue;
                }
                parent.flow_collection_ids.retain(|value| *value != flow_id);
                if let Some(data) = parent.record.get_mut("data").and_then(Value::as_object_mut) {
                    let empty = data
                        .get_mut("flow_collection")
                        .and_then(Value::as_array_mut)
                        .is_some_and(|collection| {
                            collection.retain(|item| {
                                item.get("id").and_then(Value::as_str)
                                    != Some(flow_id_text.as_str())
                            });
                            collection.is_empty()
                        });
                    if empty {
                        data.remove("flow_collection");
                    }
                }
                db::flows::save_flow(&mut *transaction, parent).await?;
            }
            db::flows::delete_flow(&mut *transaction, flow_id).await?;
            enqueue_event(
                &mut transaction,
                "flows/deleted",
                json!({"flow_id":flow_id}),
                &[flow_id],
                &source_ids,
                &parent_ids,
                &source_parents,
            )
            .await?;
            if let Some(source_id) = source_ids.first().copied()
                && db::flows::delete_source(&mut *transaction, source_id).await?
            {
                enqueue_event(
                    &mut transaction,
                    "sources/deleted",
                    json!({"source_id":source_id}),
                    &[],
                    &[source_id],
                    &[],
                    &source_parents,
                )
                .await?;
            }
        } else if !deleted_segments.is_empty()
            && let Some(flow) = flow.as_mut()
        {
            flow.segments_updated = Some(now);
            db::flows::save_flow(&mut *transaction, flow).await?;
            let deleted_start = deleted_segments
                .iter()
                .map(|segment| segment.timerange_start)
                .min();
            let deleted_end = deleted_segments
                .iter()
                .map(|segment| segment.timerange_end)
                .max();
            enqueue_event(
                &mut transaction,
                "flows/segments_deleted",
                json!({
                    "flow_id":flow_id,
                    "timerange":timerange::from_bounds(deleted_start, deleted_end)
                }),
                &[flow_id],
                &source_ids,
                &parent_ids,
                &source_parents,
            )
            .await?;
            enqueue_event(
                &mut transaction,
                "flows/updated",
                json!({"flow":model::flow(flow,&parent_ids,None)}),
                &[flow_id],
                &source_ids,
                &parent_ids,
                &source_parents,
            )
            .await?;
        }
        transaction.commit().await.map_err(db::DbError::from)?;
        if remaining {
            db::queues::release_delete_request(&pool, id, &self.settings.worker_id).await?;
            Ok(())
        } else {
            self.finish_delete_request(id, lease).await
        }
    }

    async fn finish_delete_request(&self, id: Uuid, lease: i64) -> Result<(), WorkerError> {
        let pool = self.database.pool().await?;
        {
            sqlx::query(crate::db::statements::CLAIM_CLEANUPS)
                .bind(id)
                .bind(&self.settings.worker_id)
                .bind(lease)
                .execute(&pool)
                .await
                .map_err(db::DbError::from)?;
            let cleanups = db::queues::list_parent_cleanups(&pool, id).await?;
            self.run_cleanup_batch(cleanups).await?;
            if db::queues::list_parent_cleanups(&pool, id)
                .await?
                .iter()
                .all(|item| item.status == "done")
            {
                db::queues::complete_delete_request(&pool, id, &self.settings.worker_id).await?;
            } else {
                db::queues::fail_delete_request(
                    &pool,
                    id,
                    &self.settings.worker_id,
                    queue_error(
                        "object_cleanup_failed",
                        "Object storage cleanup failed; retry will continue.",
                    ),
                )
                .await?;
            }
        }
        Ok(())
    }

    async fn process_copies(&self, limit: i64, lease: i64) -> Result<u64, WorkerError> {
        let pool = self.database.pool().await?;
        let copies =
            db::queues::claim_copies(&pool, &self.settings.worker_id, limit, lease).await?;
        for copy in &copies {
            if !db::queues::begin_copy_attempt(&pool, copy.id, &self.settings.worker_id).await? {
                continue;
            }
            let result = self
                .copy_one(
                    copy.object_id.clone(),
                    copy.source_storage_backend_id,
                    copy.destination_storage_backend_id,
                    &copy.record,
                )
                .await;
            match result {
                Ok(()) => {
                    db::queues::complete_copy(&pool, copy.id, &self.settings.worker_id).await?;
                }
                Err(error) => {
                    tracing::error!(copy_id=%copy.id, error=%redacted(&error.to_string()), "object copy failed");
                    db::queues::fail_copy(
                        &pool,
                        copy.id,
                        &self.settings.worker_id,
                        queue_error(
                            "object_copy_failed",
                            "Object copy failed; retry will continue.",
                        ),
                    )
                    .await?;
                }
            }
        }
        Ok(copies.len() as u64)
    }

    async fn copy_one(
        &self,
        object_id: String,
        source_id: Uuid,
        destination_id: Uuid,
        copy_record: &Value,
    ) -> Result<(), WorkerError> {
        let pool = self.database.pool().await?;
        let backends = self.storage.backends().await?;
        let source = backend(&backends, source_id)?;
        let destination = backend(&backends, destination_id)?;
        let Some(record) = db::objects::get(&pool, &object_id).await? else {
            return Ok(());
        };
        if record.record.get("allocation_id") != copy_record.get("allocation_id") {
            return Ok(());
        }
        let allocation_id = if crate::storage::SIGNED_URLS {
            copy_record["allocation_id"]
                .as_str()
                .ok_or_else(|| db::DbError::Record("Missing copy incarnation".into()))?
        } else {
            &object_id
        };
        let media = MediaObject::from_record(&record, &backends);
        if media.referenced_by_flows.is_empty() || controlled(&media, destination_id) {
            return Ok(());
        }
        if !controlled(&media, source_id) {
            return Err(
                db::DbError::Record("object copy source instance no longer exists".into()).into(),
            );
        }
        self.storage
            .copy(source, destination, &object_id, allocation_id)
            .await?;
        let mut transaction = pool.begin().await.map_err(db::DbError::from)?;
        db::objects::lock_sorted(&mut transaction, [object_id.clone()]).await?;
        let row = sqlx::query(crate::db::statements::GET_OBJECT)
            .bind(&object_id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(db::DbError::from)?;
        let mut delete_copy = true;
        if let Some(row) = row {
            let record = media_record(row)?;
            let mut current = MediaObject::from_record(&record, &backends);
            if !current.referenced_by_flows.is_empty() {
                delete_copy = false;
                if !controlled(&current, destination_id) {
                    current.instances.push(ObjectInstance {
                        storage_backend: Some(destination.clone()),
                        storage_backend_id: Some(destination_id),
                        url: None,
                        label: Some(destination.label.clone()),
                        controlled: true,
                        presigned: false,
                    });
                    db::objects::save(&mut *transaction, &current.into_record(crate::now()))
                        .await?;
                }
            }
        }
        transaction.commit().await.map_err(db::DbError::from)?;
        if delete_copy {
            self.storage.delete(destination, [json!({"object_id":object_id,"allocation_id":allocation_id,"not_before":crate::now().unix_timestamp()+86400})]).await?;
        }
        Ok(())
    }

    async fn queue_stale_allocations(&self, limit: i64) -> Result<u64, WorkerError> {
        let pool = self.database.pool().await?;
        let seconds = i64::try_from(self.settings.min_object_timeout_seconds())
            .map_err(|_| WorkerError::Bounds)?;
        let mut transaction = pool.begin().await.map_err(db::DbError::from)?;
        let rows = sqlx::query(crate::db::statements::EXPIRED_ALLOCATIONS)
            .bind(seconds)
            .bind(limit)
            .fetch_all(&mut *transaction)
            .await
            .map_err(db::DbError::from)?;
        let now: OffsetDateTime = sqlx::query_scalar(crate::db::statements::DATABASE_TIME)
            .fetch_one(&mut *transaction)
            .await
            .map_err(db::DbError::from)?;
        let mut queued = 0;
        for row in rows {
            let object_id: String = row.try_get(0).map_err(db::DbError::from)?;
            let record: sqlx::types::Json<Value> = row.try_get(1).map_err(db::DbError::from)?;
            // An object with no controlled instance has no bytes to remove, but
            // its row still has to go or it would block the sweep forever.
            for storage_backend_id in controlled_backend_ids(&record.0) {
                let id = Uuid::new_v4();
                db::queues::save_cleanup(&mut *transaction, &ObjectCleanup { id, delete_request_id: None, object_id: object_id.clone(), storage_backend_id, status:"pending".into(), record:json!({"id":id,"object_id":object_id,"storage_backend_id":storage_backend_id,"status":"pending","created":crate::domain::model::timestamp(now),"updated":crate::domain::model::timestamp(now),"attempt_count":0}), updated:now, created_at:now, claimed_at:None, claimed_by:None, claim_expires_at:None }).await?;
            }
            db::objects::delete(&mut *transaction, &object_id).await?;
            queued += 1;
        }
        transaction.commit().await.map_err(db::DbError::from)?;
        Ok(queued)
    }

    async fn process_cleanups(&self, limit: i64, lease: i64) -> Result<u64, WorkerError> {
        let pool = self.database.pool().await?;
        let cleanups =
            db::queues::claim_cleanups(&pool, &self.settings.worker_id, limit, lease).await?;
        let count = cleanups.len() as u64;
        self.run_cleanup_batch(cleanups).await?;
        Ok(count)
    }

    async fn run_cleanup_batch(&self, cleanups: Vec<ObjectCleanup>) -> Result<(), WorkerError> {
        let pool = self.database.pool().await?;
        let backends = self.storage.backends().await?;
        let mut batches: BTreeMap<Uuid, (StorageBackend, Vec<ObjectCleanup>)> = BTreeMap::new();
        for cleanup in cleanups {
            if !db::queues::begin_cleanup_attempt(&pool, cleanup.id, &self.settings.worker_id)
                .await?
            {
                continue;
            }
            let advertised = db::objects::get(&pool, &cleanup.object_id)
                .await?
                .is_some_and(|record| {
                    record.record.get("allocation_id") == cleanup.record.get("allocation_id")
                        && controlled_backend_ids(&record.record)
                            .contains(&cleanup.storage_backend_id)
                });
            if advertised {
                db::queues::complete_cleanup(&pool, cleanup.id, &self.settings.worker_id).await?;
            } else if let Some(value) = backends
                .iter()
                .find(|value| value.id == cleanup.storage_backend_id)
                .cloned()
            {
                batches
                    .entry(value.id)
                    .or_insert_with(|| (value, Vec::new()))
                    .1
                    .push(cleanup);
            } else {
                db::queues::fail_cleanup(
                    &pool,
                    cleanup.id,
                    &self.settings.worker_id,
                    queue_error(
                        "object_cleanup_failed",
                        "Object storage cleanup failed; retry will continue.",
                    ),
                )
                .await?;
            }
        }
        for (_, (backend, batch)) in batches {
            let result = self
                .storage
                .delete(&backend, batch.iter().map(|item| item.record.clone()))
                .await;
            for cleanup in batch {
                if result.is_ok() {
                    db::queues::complete_cleanup(&pool, cleanup.id, &self.settings.worker_id)
                        .await?;
                } else {
                    db::queues::fail_cleanup(
                        &pool,
                        cleanup.id,
                        &self.settings.worker_id,
                        queue_error(
                            "object_cleanup_failed",
                            "Object storage cleanup failed; retry will continue.",
                        ),
                    )
                    .await?;
                }
            }
        }
        Ok(())
    }

    async fn process_webhooks(&self, limit: i64, lease: i64) -> Result<u64, WorkerError> {
        let pool = self.database.pool().await?;
        let deliveries =
            db::queues::claim_webhooks(&pool, &self.settings.worker_id, limit, lease).await?;
        let count = deliveries.len() as u64;
        // One delivery at a time: the hosts release the store lock while a
        // receiver answers, which is only safe with a single request in flight.
        let mut first_error = None;
        for delivery in deliveries {
            if let Err(error) = self.process_webhook(delivery).await {
                first_error.get_or_insert(error);
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        Ok(count)
    }

    async fn process_webhook(&self, delivery: WebhookDelivery) -> Result<(), WorkerError> {
        let pool = self.database.pool().await?;
        if !db::queues::begin_webhook_attempt(&pool, delivery.id, &self.settings.worker_id).await? {
            return Ok(());
        }
        let attempt = delivery
            .record
            .get("attempt_count")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            + 1;
        let Some(live) = db::service::get_webhook(&pool, delivery.webhook_id).await? else {
            db::queues::terminal_webhook(
                &pool,
                delivery.id,
                &self.settings.worker_id,
                "dead",
                None,
                Some(queue_error("WebhookNotFound", "Webhook no longer exists")),
            )
            .await?;
            return Ok(());
        };
        if !matches!(live.status.as_str(), "created" | "started") {
            db::queues::terminal_webhook(
                &pool,
                delivery.id,
                &self.settings.worker_id,
                "dead",
                None,
                Some(queue_error(
                    "WebhookDisabled",
                    "Webhook is no longer active for delivery",
                )),
            )
            .await?;
            return Ok(());
        }
        let mut webhook = delivery
            .record
            .get("webhook_snapshot")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if webhook.get("api_key_value_ref").and_then(Value::as_str) == Some("webhook.api_key_value")
            && let Some(value) = live.record.pointer("/data/api_key_value").cloned()
        {
            webhook["api_key_value"] = value;
        }
        let payload = delivery
            .record
            .get("payload")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let policy = WebhookPolicy::from_settings(&self.settings);
        let started = Instant::now();
        let result = webhooks::deliver(
            &self.database.0,
            delivery.id,
            &webhook,
            &payload,
            self.settings.webhook_timeout_seconds,
            &policy,
        )
        .await;
        let elapsed = started.elapsed().as_secs_f64();
        let (outcome, terminal, response, error) = match result {
            Ok(value) if (200..300).contains(&value.status) => {
                ("success", Some("done"), Some(value.status as i32), None)
            }
            Ok(value)
                if webhooks::retriable_status(value.status)
                    && attempt < self.settings.webhook_max_attempts =>
            {
                (
                    "retry",
                    None,
                    Some(value.status as i32),
                    Some(queue_error(
                        "HTTPError",
                        &format!("HTTP {}: {}", value.status, value.reason),
                    )),
                )
            }
            Ok(value) => (
                "failure",
                Some("dead"),
                Some(value.status as i32),
                Some(queue_error(
                    "HTTPError",
                    &format!("HTTP {}: {}", value.status, value.reason),
                )),
            ),
            Err(
                WebhookError::Restricted
                | WebhookError::RestrictedResolution
                | WebhookError::Redirect
                | WebhookError::Scheme
                | WebhookError::Host
                | WebhookError::Credentials
                | WebhookError::Port,
            ) => (
                "failure",
                Some("dead"),
                None,
                Some(queue_error(
                    "WebhookTargetBlocked",
                    "Webhook target is not permitted",
                )),
            ),
            Err(_) if attempt < self.settings.webhook_max_attempts => (
                "failure",
                None,
                None,
                Some(queue_error("RequestError", "Webhook request failed")),
            ),
            Err(_) => (
                "failure",
                Some("dead"),
                None,
                Some(queue_error("RequestError", "Webhook request failed")),
            ),
        };
        let _ = (outcome, elapsed);
        if let Some(status) = terminal {
            if status == "dead" {
                let failure = error
                    .clone()
                    .unwrap_or_else(|| queue_error("RequestError", "Webhook request failed"));
                let mut transaction = pool.begin().await.map_err(db::DbError::from)?;
                let finished = sqlx::query(crate::db::statements::FAIL_WEBHOOK)
                    .bind(delivery.id)
                    .bind(&self.settings.worker_id)
                    .bind(response)
                    .bind(error.map(sqlx::types::Json))
                    .execute(&mut *transaction)
                    .await
                    .map_err(db::DbError::from)?
                    .rows_affected()
                    == 1;
                // Re-read the webhook: it may have been deleted or replaced while
                // the delivery was in flight, and the earlier copy must not win.
                if finished
                    && let Some(mut current) =
                        db::service::get_webhook_with(&mut *transaction, delivery.webhook_id)
                            .await?
                    && matches!(current.status.as_str(), "created" | "started")
                {
                    current.status = "error".into();
                    current.record["status"] = json!("error");
                    current.record["data"]["error"] = failure;
                    db::service::save_webhook(&mut *transaction, &current).await?;
                }
                transaction.commit().await.map_err(db::DbError::from)?;
            } else {
                db::queues::terminal_webhook(
                    &pool,
                    delivery.id,
                    &self.settings.worker_id,
                    status,
                    response,
                    error,
                )
                .await?;
            }
        } else {
            db::queues::retry_webhook(
                &pool,
                delivery.id,
                &self.settings.worker_id,
                webhooks::retry_delay(attempt),
                response,
                error,
            )
            .await?;
        }
        Ok(())
    }
}
async fn enqueue_event(
    transaction: &mut sqlx::Transaction<'_, sqlx::Engine>,
    event_type: &str,
    event: Value,
    flow_ids: &[Uuid],
    source_ids: &[Uuid],
    flow_collected_by: &[Uuid],
    source_collected_by: &[Uuid],
) -> Result<(), WorkerError> {
    crate::http::routes::service::enqueue_event(
        transaction,
        event_type,
        event,
        flow_ids,
        source_ids,
        flow_collected_by,
        source_collected_by,
    )
    .await
    .map_err(|_| db::DbError::Record("worker webhook event publication failed".into()).into())
}

fn segment_record(row: sqlx::RecordRow) -> Result<SegmentRecord, WorkerError> {
    Ok(SegmentRecord {
        flow_id: row.try_get(0).map_err(db::DbError::from)?,
        object_id: row.try_get(1).map_err(db::DbError::from)?,
        init_object_id: row.try_get(2).map_err(db::DbError::from)?,
        timerange: row.try_get(3).map_err(db::DbError::from)?,
        timerange_start: row.try_get(4).map_err(db::DbError::from)?,
        timerange_end: row.try_get(5).map_err(db::DbError::from)?,
        record: row
            .try_get::<sqlx::types::Json<Value>, _>(6)
            .map_err(db::DbError::from)?
            .0,
        created: row.try_get(7).map_err(db::DbError::from)?,
    })
}

fn backend(backends: &[StorageBackend], id: Uuid) -> Result<&StorageBackend, WorkerError> {
    backends.iter().find(|value| value.id == id).ok_or_else(|| {
        db::DbError::Record("queue references an unknown storage backend".into()).into()
    })
}
fn controlled(media: &MediaObject, id: Uuid) -> bool {
    media.instances.iter().any(|value| {
        value.controlled
            && value
                .storage_backend_id
                .or_else(|| value.storage_backend.as_ref().map(|backend| backend.id))
                == Some(id)
    })
}
fn controlled_backend_ids(record: &Value) -> Vec<Uuid> {
    record
        .get("instances")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|value| {
            value
                .get("controlled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|value| {
            value
                .get("storage_backend_id")
                .and_then(Value::as_str)?
                .parse()
                .ok()
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
fn media_record(row: sqlx::RecordRow) -> Result<MediaObjectRecord, WorkerError> {
    Ok(MediaObjectRecord {
        id: row.try_get(0).map_err(db::DbError::from)?,
        first_referenced_by_flow: row.try_get(1).map_err(db::DbError::from)?,
        referenced_by_flows: row.try_get(2).map_err(db::DbError::from)?,
        object_kind: row.try_get(3).map_err(db::DbError::from)?,
        content_type: row.try_get(4).map_err(db::DbError::from)?,
        record: row
            .try_get::<sqlx::types::Json<Value>, _>(5)
            .map_err(db::DbError::from)?
            .0,
        created_at: row.try_get(6).map_err(db::DbError::from)?,
        updated_at: row.try_get(7).map_err(db::DbError::from)?,
    })
}
fn queue_error(kind: &str, summary: &str) -> Value {
    json!({"type":kind,"summary":summary,"time":crate::domain::model::timestamp(crate::now())})
}
/// The segment range a delete request still has to process, or `None` when its
/// segment phase has already committed. Flow deletion always covers the whole
/// flow, so segments written after the request was made are removed too.
fn delete_range(record: &Value, delete_flow: bool) -> Result<Option<(i128, i128)>, WorkerError> {
    let invalid = || WorkerError::Db(db::DbError::Record("invalid delete request range".into()));
    let value = match record.get("timerange_remaining") {
        // Older releases cleared the field once the segment phase committed.
        Some(Value::Null) => return Ok(None),
        Some(Value::String(value)) => value.as_str(),
        Some(_) => return Err(invalid()),
        None => record
            .get("timerange_to_delete")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?,
    };
    let bounds = timerange::parse(value).map_err(|_| invalid())?;
    if bounds.empty {
        return Ok(None);
    }
    if delete_flow {
        return Ok(Some((i128::MIN, i128::MAX)));
    }
    Ok(Some((
        bounds.start.unwrap_or(i128::MIN),
        if bounds.point {
            bounds.start.map(|start| start.saturating_add(1))
        } else {
            bounds.end
        }
        .unwrap_or(i128::MAX),
    )))
}

fn redacted(value: &str) -> String {
    value.to_owned()
}

#[cfg(test)]
mod tests {
    use super::delete_range;
    use serde_json::json;

    #[test]
    fn delete_ranges_resume_without_repeating_work() {
        let request = |remaining: serde_json::Value, delete_flow: bool| json!({"timerange_to_delete":"[0:0_10:0)","timerange_remaining":remaining,"delete_flow":delete_flow});
        let segment = delete_range(&request(json!("[2:0_10:0)"), false), false).unwrap();
        assert_eq!(segment, Some((2_000_000_000, 10_000_000_000)));
        // A committed segment phase is never repeated, in either record format.
        assert_eq!(
            delete_range(&request(json!("()"), false), false).unwrap(),
            None
        );
        assert_eq!(
            delete_range(&request(json!(null), true), true).unwrap(),
            None
        );
        // Flow deletion covers segments written after the request was made.
        assert_eq!(
            delete_range(&request(json!("[0:0_10:0)"), true), true).unwrap(),
            Some((i128::MIN, i128::MAX))
        );
        let point = json!({"timerange_to_delete":"[5:0]"});
        assert_eq!(
            delete_range(&point, false).unwrap(),
            Some((5_000_000_000, 5_000_000_001))
        );
        assert!(delete_range(&request(json!("nonsense"), false), false).is_err());
        assert!(delete_range(&json!({}), false).is_err());
    }
}
