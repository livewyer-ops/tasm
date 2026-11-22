// Cloudflare adaptation of TASM and rust-tams-api (Apache-2.0); see NOTICE.
use std::collections::{BTreeMap, BTreeSet};

use axum::{
    Extension, Router,
    body::Body,
    extract::State,
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header::ALLOW},
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    db::{self, ObjectCleanup, ObjectCopy, StorageBackend, TagFilters, Tags},
    domain::{
        model,
        object::{MediaObject, ObjectInstance},
    },
    http::{
        MAX_JSON_BODY_BYTES, RawRequestTarget, error::ApiError, lenient_decode_path,
        query::invalid_query, strict_json,
    },
    storage::StorageFactory,
};

use super::service::{MetadataState, internal, paged_response, query};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogicalOperation {
    GetObject,
    HeadObject,
    PostObjectInstances,
    DeleteObjectInstances,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectDispatch {
    pub operation: LogicalOperation,
    pub object_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DispatchError {
    NotFound,
    MethodNotAllowed(&'static str),
}

pub fn classify(method: &Method, raw_path: &str) -> Result<ObjectDispatch, DispatchError> {
    let decoded = lenient_decode_path(raw_path);
    let tail = decoded
        .strip_prefix("/objects/")
        .ok_or(DispatchError::NotFound)?;
    match *method {
        Method::GET => Ok(ObjectDispatch {
            operation: LogicalOperation::GetObject,
            object_id: tail.to_owned(),
        }),
        Method::HEAD => Ok(ObjectDispatch {
            operation: LogicalOperation::HeadObject,
            object_id: tail.to_owned(),
        }),
        Method::POST | Method::DELETE => {
            let object_id = tail
                .strip_suffix("/instances")
                .filter(|object_id| !object_id.is_empty())
                .ok_or(DispatchError::MethodNotAllowed("HEAD"))?;
            Ok(ObjectDispatch {
                operation: if method == Method::POST {
                    LogicalOperation::PostObjectInstances
                } else {
                    LogicalOperation::DeleteObjectInstances
                },
                object_id: object_id.to_owned(),
            })
        }
        _ if tail
            .strip_suffix("/instances")
            .is_some_and(|object_id| !object_id.is_empty()) =>
        {
            Err(DispatchError::MethodNotAllowed("POST"))
        }
        _ => Err(DispatchError::MethodNotAllowed("HEAD")),
    }
}

pub fn router() -> Router<MetadataState> {
    Router::new()
        .route("/objects/", any(dispatch))
        .route("/objects/{*tail}", any(dispatch))
}

fn dispatch_error(error: DispatchError) -> ApiError {
    match error {
        DispatchError::NotFound => {
            ApiError::not_found("The requested Media Object does not exist.")
        }
        DispatchError::MethodNotAllowed(allow) => {
            let mut headers = HeaderMap::new();
            headers.insert(ALLOW, HeaderValue::from_static(allow));
            ApiError::new(
                StatusCode::METHOD_NOT_ALLOWED,
                "method_not_allowed",
                "Method Not Allowed",
            )
            .with_headers(headers)
        }
    }
}

async fn dispatch(
    State(state): State<MetadataState>,
    Extension(storage): Extension<StorageFactory>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let raw_path = request
        .extensions()
        .get::<RawRequestTarget>()
        .map(|target| target.0.path())
        .unwrap_or_else(|| request.uri().path());
    let classified = classify(request.method(), raw_path).map_err(dispatch_error)?;
    match classified.operation {
        LogicalOperation::GetObject | LogicalOperation::HeadObject => {
            get_object(state, storage, classified.object_id, request).await
        }
        LogicalOperation::PostObjectInstances => {
            post_instance(state, storage, classified.object_id, request).await
        }
        LogicalOperation::DeleteObjectInstances => {
            delete_instance(state, storage, classified.object_id, request).await
        }
    }
}

async fn get_object(
    state: MetadataState,
    storage: StorageFactory,
    object_id: String,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let params = query(
        &request,
        &[
            "verbose_storage",
            "accept_get_urls",
            "accept_storage_ids",
            "presigned",
            "page",
            "limit",
        ],
        &[
            "flow_tag.",
            "flow_tag_exists.",
            "storage_backend_tag.",
            "storage_backend_tag_exists.",
        ],
    )?;
    let verbose = params.bool("verbose_storage")?.unwrap_or(false);
    let presigned = params.bool("presigned")?;
    let accepted_labels = params.csv_set("accept_get_urls")?;
    let accepted_storage = params.uuid_list("accept_storage_ids")?;
    let storage_tag_values = params.dynamic_csv("storage_backend_tag.")?;
    let storage_tag_exists = params.dynamic_bool("storage_backend_tag_exists.")?;
    let page = super::service::page(&params)?;

    let pool = state.pool;
    let record = db::objects::get(&pool, &object_id)
        .await
        .map_err(internal)?
        .filter(|record| !record.referenced_by_flows.is_empty())
        .ok_or_else(|| ApiError::not_found("The requested Media Object does not exist."))?;
    let head = request.method() == Method::HEAD;
    let backends = if head {
        Vec::new()
    } else {
        storage.backends().await.map_err(internal)?
    };
    let media = MediaObject::from_record(&record, &backends);
    let urls = if head {
        Vec::new()
    } else {
        object_urls(
            &storage,
            &media,
            &object_id,
            verbose,
            presigned,
            accepted_labels.as_ref(),
            accepted_storage.as_ref(),
            &storage_tag_values,
            &storage_tag_exists,
        )
        .await?
    };

    let flow_tag_values = params.dynamic_csv("flow_tag.")?;
    let flow_tag_exists = params.dynamic_bool("flow_tag_exists.")?;
    // Referencing flows come from stored segments, so a flow lookup is only
    // needed to apply flow tag filters.
    let (selected, next) = if flow_tag_values.is_empty() && flow_tag_exists.is_empty() {
        let flows = media
            .referenced_by_flows
            .iter()
            .copied()
            .collect::<Vec<_>>();
        let start = usize::try_from(page.offset)
            .unwrap_or(usize::MAX)
            .min(flows.len());
        let end = start
            .saturating_add(usize::try_from(page.limit).unwrap_or(usize::MAX))
            .min(flows.len());
        let next = (end < flows.len()).then(|| (page.offset + page.limit).to_string());
        (flows[start..end].to_vec(), next)
    } else {
        let ids = media
            .referenced_by_flows
            .iter()
            .copied()
            .collect::<Vec<_>>();
        let tags = TagFilters {
            values: flow_tag_values,
            exists: flow_tag_exists,
        };
        let flows = db::flows::page_flow_ids_with_tags(&pool, &ids, &tags, &page)
            .await
            .map_err(internal)?;
        (flows.items, flows.next_page)
    };

    let init_object = if !head
        && let Some(init_id) = media.init_object_id.as_deref()
        && let Some(init_record) = db::objects::get(&pool, init_id).await.map_err(internal)?
    {
        let init = MediaObject::from_record(&init_record, &backends);
        Some(json!({
            "id": init.id,
            "get_urls": object_urls(
                &storage,
                &init,
                init_id,
                verbose,
                presigned,
                accepted_labels.as_ref(),
                accepted_storage.as_ref(),
                &storage_tag_values,
                &storage_tag_exists,
            ).await?,
        }))
    } else {
        None
    };
    let mut body = json!({
        "id": media.id,
        "referenced_by_flows": &selected,
        "first_referenced_by_flow": media.first_referenced_by_flow,
        "timerange": media.timerange,
        "get_urls": urls,
        "key_frame_count": media.key_frame_count,
        "init_object": init_object,
    });
    body.as_object_mut()
        .expect("object response")
        .retain(|_, value| !value.is_null());
    paged_response(
        &request,
        body,
        page.limit,
        selected.len(),
        next.as_deref(),
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn object_urls(
    storage: &StorageFactory,
    media: &MediaObject,
    object_id: &str,
    verbose: bool,
    presigned: Option<bool>,
    accepted_labels: Option<&BTreeSet<String>>,
    accepted_storage: Option<&BTreeSet<Uuid>>,
    storage_tag_values: &BTreeMap<String, BTreeSet<String>>,
    storage_tag_exists: &BTreeMap<String, bool>,
) -> Result<Vec<Value>, ApiError> {
    if accepted_labels.is_some_and(BTreeSet::is_empty) {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    let mut seen = BTreeSet::new();
    for instance in &media.instances {
        let backend = instance.storage_backend.as_ref();
        let label = if instance.controlled {
            backend.map(|backend| backend.label.as_str())
        } else {
            instance.label.as_deref()
        };
        if (!storage_tag_values.is_empty() || !storage_tag_exists.is_empty())
            && backend.is_none_or(|backend| {
                !tags_match(&backend.tags, storage_tag_values, storage_tag_exists)
            })
        {
            continue;
        }
        if accepted_storage.is_some_and(|ids| {
            !ids.is_empty() && backend.is_none_or(|backend| !ids.contains(&backend.id))
        }) {
            continue;
        }
        if accepted_labels.is_some_and(|labels| label.is_none_or(|label| !labels.contains(label))) {
            continue;
        }
        if let Some(backend) = backend.filter(|_| instance.controlled) {
            if presigned != Some(true) {
                push_url(
                    &mut result,
                    &mut seen,
                    storage
                        .object_url(backend, object_id, "GET", false, None)
                        .await
                        .map_err(internal)?,
                    label,
                    false,
                    Some(backend),
                    verbose,
                );
            }
            if crate::storage::SIGNED_URLS && presigned != Some(false) {
                push_url(
                    &mut result,
                    &mut seen,
                    storage
                        .object_url(backend, object_id, "GET", true, None)
                        .await
                        .map_err(internal)?,
                    label,
                    true,
                    Some(backend),
                    verbose,
                );
            }
        } else if let Some(url) = instance.url.as_ref()
            && presigned.is_none_or(|wanted| wanted == instance.presigned)
        {
            push_url(
                &mut result,
                &mut seen,
                url.clone(),
                label,
                instance.presigned,
                None,
                verbose,
            );
        }
    }
    Ok(result)
}

type ObjectUrlKey = (Option<String>, Option<Uuid>, String, bool, bool);

fn push_url(
    result: &mut Vec<Value>,
    seen: &mut BTreeSet<ObjectUrlKey>,
    url: String,
    label: Option<&str>,
    presigned: bool,
    backend: Option<&StorageBackend>,
    verbose: bool,
) {
    let controlled = backend.is_some();
    let key = (
        label.map(str::to_owned),
        backend.map(|backend| backend.id),
        url.clone(),
        presigned,
        controlled,
    );
    if !seen.insert(key) {
        return;
    }
    let mut value = json!({"url":url,"label":label,"presigned":presigned});
    if verbose {
        let map = value.as_object_mut().expect("URL response");
        map.insert("controlled".into(), json!(controlled));
        if let Some(backend) = backend {
            map.insert("storage_id".into(), json!(backend.id));
            map.insert("store_type".into(), json!(backend.store_type));
            map.insert("provider".into(), json!(backend.provider));
            map.insert("region".into(), json!(backend.region));
            map.insert("store_product".into(), json!(backend.store_product));
            map.insert("tags".into(), json!(backend.tags));
        }
    }
    value
        .as_object_mut()
        .expect("URL response")
        .retain(|_, value| !value.is_null());
    result.push(value);
}

fn tags_match(
    tags: &Tags,
    values: &BTreeMap<String, BTreeSet<String>>,
    exists: &BTreeMap<String, bool>,
) -> bool {
    values.iter().all(|(name, wanted)| {
        tags.get(name).is_some_and(|value| {
            wanted.iter().any(|wanted| {
                value.as_str() == Some(wanted)
                    || value.as_array().is_some_and(|values| {
                        values.iter().any(|value| value.as_str() == Some(wanted))
                    })
            })
        })
    }) && exists
        .iter()
        .all(|(name, expected)| tags.contains_key(name) == *expected)
}

async fn post_instance(
    state: MetadataState,
    storage: StorageFactory,
    object_id: String,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let body: Value = strict_json(request, MAX_JSON_BODY_BYTES)
        .await
        .map_err(|_| ApiError::bad_request("Bad request. Invalid request JSON."))?;
    let fields = body
        .as_object()
        .ok_or_else(|| ApiError::bad_request("Bad request. Invalid request JSON."))?;
    let storage_id = fields
        .get("storage_id")
        .map(|value| {
            crate::domain::model::parse_uuid(value.as_str().ok_or_else(invalid_instance_json)?)
                .map_err(|_| invalid_instance_json())
        })
        .transpose()?;
    let url = fields
        .get("url")
        .map(|value| value.as_str().ok_or_else(invalid_instance_json))
        .transpose()?;
    let label = fields
        .get("label")
        .map(|value| value.as_str().ok_or_else(invalid_instance_json))
        .transpose()?;
    if storage_id.is_some() == (url.is_some() || label.is_some()) {
        return Err(invalid_instance_json());
    }

    let backends = storage.backends().await.map_err(internal)?;
    let pool = state.pool;
    let mut transaction = pool.begin().await.map_err(internal)?;
    db::objects::lock_sorted(&mut transaction, [object_id.clone()])
        .await
        .map_err(internal)?;
    let record = db::objects::get(&mut *transaction, &object_id)
        .await
        .map_err(internal)?
        .filter(|record| !record.referenced_by_flows.is_empty())
        .ok_or_else(|| ApiError::not_found("The requested Media Object does not exist."))?;
    let mut media = MediaObject::from_record(&record, &backends);
    if let Some(destination) = storage_id {
        let destination = backends
            .iter()
            .find(|backend| backend.id == destination)
            .ok_or_else(|| {
                ApiError::bad_request("The requested Storage Backend does not exist.")
            })?;
        let source = media
            .instances
            .iter()
            .find_map(|instance| {
                instance
                    .controlled
                    .then_some(instance.storage_backend_id)
                    .flatten()
            })
            .ok_or_else(invalid_instance_json)?;
        if media.instances.iter().any(|instance| {
            instance.controlled && instance.storage_backend_id == Some(destination.id)
        }) {
            return Err(invalid_instance_json());
        }
        let now = crate::now();
        let copy = ObjectCopy {
            id: Uuid::new_v4(),
            object_id: object_id.clone(),
            source_storage_backend_id: source,
            destination_storage_backend_id: destination.id,
            status: "pending".into(),
            record: json!({
                "object_id":object_id,"source_storage_backend_id":source,
                "destination_storage_backend_id":destination.id,"status":"pending",
                "attempt_count":0,"error":null,"created":model::timestamp(now),
                "updated":model::timestamp(now)
            }),
            updated: now,
            created_at: now,
            claimed_at: None,
            claimed_by: None,
            claim_expires_at: None,
        };
        db::queues::save_copy(&mut *transaction, &copy)
            .await
            .map_err(internal)?;
    } else {
        let url = url
            .filter(|url| {
                url::Url::parse(url).ok().is_some_and(|parsed| {
                    matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some()
                })
            })
            .ok_or_else(invalid_instance_json)?;
        let label = label
            .filter(|label| !label.is_empty())
            .ok_or_else(invalid_instance_json)?;
        if backends.iter().any(|backend| backend.label == label) {
            return Err(invalid_instance_json());
        }
        if let Some(existing) = media
            .instances
            .iter()
            .find(|instance| !instance.controlled && instance.label.as_deref() == Some(label))
        {
            if existing.url.as_deref() == Some(url) && !existing.presigned {
                transaction.commit().await.map_err(internal)?;
                return Ok(StatusCode::CREATED.into_response());
            }
            return Err(invalid_instance_json());
        }
        media.instances.push(ObjectInstance {
            storage_backend: None,
            storage_backend_id: None,
            url: Some(url.into()),
            label: Some(label.into()),
            controlled: false,
            presigned: false,
        });
        db::objects::save(&mut *transaction, &media.into_record(crate::now()))
            .await
            .map_err(internal)?;
    }
    transaction.commit().await.map_err(internal)?;
    Ok(StatusCode::CREATED.into_response())
}

async fn delete_instance(
    state: MetadataState,
    storage: StorageFactory,
    object_id: String,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let params = query(&request, &["storage_id", "label"], &[])?;
    // DELETE declares this selector as a string; the registration body uses the UUID schema.
    let storage_id = params
        .last("storage_id")
        .map(|value| value.parse::<Uuid>().map_err(|_| invalid_query()))
        .transpose()?;
    let label = params.last("label");
    if storage_id.is_some() == label.is_some() {
        return Err(invalid_query());
    }
    let backends = storage.backends().await.map_err(internal)?;
    let pool = state.pool;
    let mut transaction = pool.begin().await.map_err(internal)?;
    db::objects::lock_sorted(&mut transaction, [object_id.clone()])
        .await
        .map_err(internal)?;
    let record = db::objects::get(&mut *transaction, &object_id)
        .await
        .map_err(internal)?
        .filter(|record| !record.referenced_by_flows.is_empty())
        .ok_or_else(|| ApiError::not_found("The requested Media Object does not exist."))?;
    let media = MediaObject::from_record(&record, &backends);
    let matches = |instance: &ObjectInstance| {
        storage_id.is_some_and(|id| {
            instance
                .storage_backend
                .as_ref()
                .is_some_and(|backend| backend.id == id)
        }) || label.is_some_and(|label| instance.label.as_deref() == Some(label))
    };
    let matched_backend_ids: BTreeSet<_> = media
        .instances
        .iter()
        .filter(|instance| matches(instance))
        .filter(|instance| instance.controlled)
        .filter_map(|instance| instance.storage_backend.as_ref().map(|backend| backend.id))
        .collect();
    let (removed, kept): (Vec<_>, Vec<_>) = media.instances.into_iter().partition(|instance| {
        matches(instance)
            || instance.controlled
                && instance
                    .storage_backend
                    .as_ref()
                    .is_some_and(|backend| matched_backend_ids.contains(&backend.id))
    });
    let media = MediaObject {
        instances: kept,
        ..media
    };
    if removed.is_empty() {
        return Err(ApiError::not_found(
            "The requested Object instance does not exist.",
        ));
    }
    if media.instances.is_empty() {
        return Err(ApiError::bad_request(
            "Bad request. All instances would be deleted. Use Flow Segment deletion instead.",
        ));
    }
    let now = crate::now();
    let backend_ids: BTreeSet<_> = removed
        .iter()
        .filter_map(|instance| {
            instance
                .controlled
                .then_some(instance.storage_backend_id)
                .flatten()
        })
        .collect();
    for backend_id in backend_ids {
        let cleanup = ObjectCleanup {
            id: Uuid::new_v4(),
            delete_request_id: None,
            object_id: object_id.clone(),
            storage_backend_id: backend_id,
            status: "pending".into(),
            record: json!({
                "object_id":object_id,"storage_backend_id":backend_id,"status":"pending",
                "attempt_count":0,"error":null,"created":model::timestamp(now),
                "updated":model::timestamp(now)
            }),
            updated: now,
            created_at: now,
            claimed_at: None,
            claimed_by: None,
            claim_expires_at: None,
        };
        db::queues::save_cleanup(&mut *transaction, &cleanup)
            .await
            .map_err(internal)?;
    }
    db::objects::save(&mut *transaction, &media.into_record(now))
        .await
        .map_err(internal)?;
    transaction.commit().await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

fn invalid_instance_json() -> ApiError {
    ApiError::bad_request("Bad request. Invalid request JSON.")
}
