// Cloudflare adaptation of TASM and rust-tams-api (Apache-2.0); see NOTICE.
use crate::sql as sqlx;
use std::collections::{BTreeMap, BTreeSet};

use axum::{
    Extension, Json, Router,
    body::Body,
    extract::State,
    http::{HeaderName, HeaderValue, Method, Request, StatusCode, header::LOCATION},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
use sqlx::{Engine, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use super::{
    objects::object_urls,
    service::{MetadataState, enqueue_event, internal, page, paged_response, query},
};
use crate::{
    Actor,
    db::{self, DeleteRequest, MediaObjectRecord, ObjectCleanup, SegmentRecord},
    domain::{
        model,
        object::{MediaObject, ObjectInstance},
        segment,
    },
    http::{MAX_JSON_BODY_BYTES, error::ApiError, query::invalid_query, strict_json},
    storage::StorageFactory,
};

pub fn router() -> Router<MetadataState> {
    Router::new().route(
        "/flows/{flowId}/segments",
        get(list).head(list).post(post).delete(delete),
    )
}
fn flow_id(request: &Request<Body>, message: &str) -> Result<Uuid, ApiError> {
    request
        .uri()
        .path()
        .split('/')
        .nth(2)
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| ApiError::not_found(message))
}
fn invalid_json() -> ApiError {
    ApiError::bad_request("Bad request. Invalid Flow Segment JSON.")
}
fn valid_post_shape(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.get("object_id").and_then(Value::as_str).is_none()
        || object.get("timerange").and_then(Value::as_str).is_none()
        || [
            "init_object_id",
            "ts_offset",
            "last_duration",
            "object_timerange",
        ]
        .iter()
        .any(|field| {
            object
                .get(*field)
                .is_some_and(|value| value.as_str().is_none())
        })
        || ["sample_offset", "sample_count", "key_frame_count"]
            .iter()
            .any(|field| {
                object
                    .get(*field)
                    .is_some_and(|value| value.as_i64().is_none())
            })
    {
        return false;
    }
    if object
        .get("timerange")
        .and_then(Value::as_str)
        .is_none_or(|value| crate::domain::timerange::parse(value).is_err())
        || object
            .get("object_timerange")
            .and_then(Value::as_str)
            .is_some_and(|value| crate::domain::timerange::parse(value).is_err())
        || ["ts_offset", "last_duration"].iter().any(|field| {
            object
                .get(*field)
                .and_then(Value::as_str)
                .is_some_and(|value| {
                    crate::domain::timerange::parse(&format!("[{value}]")).is_err()
                })
        })
    {
        return false;
    }
    object.get("get_urls").is_none_or(|value| {
        value.as_array().is_some_and(|entries| {
            entries.iter().all(|entry| {
                entry.as_object().is_some_and(|entry| {
                    entry.get("url").and_then(Value::as_str).is_some()
                        && entry.get("label").and_then(Value::as_str).is_some()
                        && entry.get("presigned").is_none_or(Value::is_boolean)
                })
            })
        })
    })
}

async fn list(
    State(state): State<MetadataState>,
    Extension(storage): Extension<StorageFactory>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let flow_id = flow_id(&request, "The Flow ID in the path is invalid.")?;
    let params = query(
        &request,
        &[
            "object_id",
            "timerange",
            "reverse_order",
            "verbose_storage",
            "accept_get_urls",
            "accept_storage_ids",
            "presigned",
            "include_object_timerange",
            "page",
            "limit",
        ],
        &["storage_backend_tag.", "storage_backend_tag_exists."],
    )?;
    let labels = params.csv_set("accept_get_urls")?;
    let storage_ids = params
        .uuid_set("accept_storage_ids")?
        .filter(|values| !values.is_empty());
    let presigned = params.bool("presigned")?;
    let verbose = params.bool("verbose_storage")?.unwrap_or(false);
    let tag_values = params.dynamic_csv("storage_backend_tag.")?;
    let tag_exists = params.dynamic_bool("storage_backend_tag_exists.")?;
    let reverse = params.bool("reverse_order")?.unwrap_or(false);
    let include = params.bool("include_object_timerange")?.unwrap_or(false);
    let requested = params
        .last("timerange")
        .filter(|value| !matches!(*value, "" | "_"))
        .map(crate::domain::timerange::parse)
        .transpose()
        .map_err(|_| invalid_query())?
        .unwrap_or_default();
    let page_request = page(&params)?;
    let pool = state.pool().await?;
    let mut filtered = db::flows::list_segments(&pool, flow_id)
        .await
        .map_err(internal)?
        .into_iter()
        .filter(|item| {
            params
                .last("object_id")
                .is_none_or(|id| item.object_id == id)
                && !requested.empty
                && segment::bounds(&item.timerange).is_ok_and(|value| {
                    let query_end = if requested.point {
                        requested.start.map(|start| start.saturating_add(1))
                    } else {
                        requested.end
                    };
                    requested.start.is_none_or(|start| value.end > start)
                        && query_end.is_none_or(|end| value.start < end)
                })
        })
        .collect::<Vec<_>>();
    filtered.sort_by(|left, right| {
        left.timerange_end
            .cmp(&right.timerange_end)
            .then_with(|| left.timerange_start.cmp(&right.timerange_start))
            .then_with(|| left.object_id.cmp(&right.object_id))
            .then_with(|| left.timerange.cmp(&right.timerange))
    });
    if reverse {
        filtered.reverse();
    }
    let all_timerange = timerange_union(&filtered);
    let start = usize::try_from(page_request.offset)
        .unwrap_or(usize::MAX)
        .min(filtered.len());
    let limit = usize::try_from(page_request.limit).unwrap_or(usize::MAX);
    let end = start.saturating_add(limit).min(filtered.len());
    let items = &filtered[start..end];
    let next_page =
        (end < filtered.len()).then(|| (page_request.offset + page_request.limit).to_string());
    let mut responses = Vec::new();
    if request.method() != Method::HEAD {
        let ids = items
            .iter()
            .flat_map(|item| [Some(item.object_id.clone()), item.init_object_id.clone()])
            .flatten()
            .collect::<BTreeSet<_>>();
        let backends = storage.backends().await.map_err(internal)?;
        let objects = db::objects::get_many(&pool, &ids.into_iter().collect::<Vec<_>>())
            .await
            .map_err(internal)?
            .into_iter()
            .map(|record| {
                let media = MediaObject::from_record(&record, &backends);
                (record.id, media)
            })
            .collect::<BTreeMap<_, _>>();
        let mut urls = BTreeMap::new();
        for (id, media) in &objects {
            urls.insert(
                id.clone(),
                object_urls(
                    &storage,
                    media,
                    id,
                    verbose,
                    presigned,
                    labels.as_ref(),
                    storage_ids.as_ref(),
                    &tag_values,
                    &tag_exists,
                )
                .await?,
            );
        }
        for item in items {
            let init = item.init_object_id.as_deref().and_then(|id| {
                objects.get(id).map(|object| {
                    (
                        object.id.as_str(),
                        urls.get(id).cloned().unwrap_or_default(),
                    )
                })
            });
            responses.push(segment::response(
                item,
                urls.get(&item.object_id).cloned().unwrap_or_default(),
                init,
                include,
            ));
        }
    }
    let mut response = paged_response(
        &request,
        Value::Array(responses),
        page_request.limit,
        items.len(),
        next_page.as_deref(),
        None,
    )?;
    response.headers_mut().insert(
        HeaderName::from_static("x-paging-reverse-order"),
        HeaderValue::from_static(if reverse { "true" } else { "false" }),
    );
    response.headers_mut().insert(
        HeaderName::from_static("x-paging-timerange"),
        HeaderValue::from_str(&all_timerange).map_err(internal)?,
    );
    let gaps = segment::coverage_gaps(items)
        .map_err(|_| ApiError::bad_request("Bad request. Invalid stored Segment timerange."))?;
    if !gaps.is_empty() {
        response.headers_mut().insert(
            HeaderName::from_static("x-tamoss-coverage-gaps"),
            HeaderValue::from_str(&gaps.join(",")).map_err(internal)?,
        );
    }
    Ok(response)
}

fn timerange_union(values: &[SegmentRecord]) -> String {
    if values.is_empty() {
        return "()".into();
    }
    if values.len() == 1 {
        return values[0].timerange.clone();
    }
    let ranges = values
        .iter()
        .filter_map(|value| segment::bounds(&value.timerange).ok())
        .collect::<Vec<_>>();
    crate::domain::timerange::from_bounds(
        ranges.iter().map(|value| value.start).min(),
        ranges.iter().map(|value| value.end).max(),
    )
}

enum RegisterError {
    Validation(String),
    Infrastructure(ApiError),
}

impl From<String> for RegisterError {
    fn from(summary: String) -> Self {
        Self::Validation(summary)
    }
}

impl From<&str> for RegisterError {
    fn from(summary: &str) -> Self {
        Self::Validation(summary.to_owned())
    }
}

impl From<ApiError> for RegisterError {
    fn from(error: ApiError) -> Self {
        Self::Infrastructure(error)
    }
}

async fn post(
    State(state): State<MetadataState>,
    Extension(storage): Extension<StorageFactory>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let flow_id = flow_id(&request, "The requested Flow does not exist.");
    let value: Value = strict_json(request, MAX_JSON_BODY_BYTES)
        .await
        .map_err(|_| invalid_json())?;
    let flow_id = flow_id?;
    let bulk = value.is_array();
    let values = value.as_array().cloned().unwrap_or_else(|| vec![value]);
    if values.iter().any(|value| !valid_post_shape(value)) {
        return Err(invalid_json());
    }
    let pool = state.pool().await?;
    let backends = storage.backends().await.map_err(internal)?;
    let mut ids = values
        .iter()
        .flat_map(|value| {
            [
                value.get("object_id").and_then(Value::as_str),
                value.get("init_object_id").and_then(Value::as_str),
            ]
        })
        .flatten()
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    let pre = db::objects::get_many(&pool, &ids.iter().cloned().collect::<Vec<_>>())
        .await
        .map_err(internal)?;
    for record in &pre {
        if let Some(id) = record.record.get("init_object_id").and_then(Value::as_str) {
            ids.insert(id.into());
        }
    }
    let pre = db::objects::get_many(&pool, &ids.iter().cloned().collect::<Vec<_>>())
        .await
        .map_err(internal)?;
    let mut uploads = BTreeMap::new();
    for record in &pre {
        if !record.referenced_by_flows.is_empty() {
            continue;
        }
        let media = MediaObject::from_record(record, &backends);
        if let Some(backend) = media
            .instances
            .iter()
            .find(|instance| instance.controlled)
            .and_then(|instance| instance.storage_backend.as_ref())
        {
            uploads.insert(
                media.id,
                storage
                    .head_optional(backend, &record.id)
                    .await
                    .map_err(internal)?
                    .map(|metadata| metadata.content_length.unwrap_or(0)),
            );
        }
    }
    let mut transaction = pool.begin().await.map_err(internal)?;
    db::flows::lock_flow_segments(&mut *transaction, flow_id)
        .await
        .map_err(internal)?;
    let mut flow = db::flows::get_flow_with(&mut *transaction, flow_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| ApiError::not_found("The requested Flow does not exist."))?;
    if flow.read_only {
        return Err(ApiError::forbidden(
            "Forbidden. The requested Flow is read-only.",
        ));
    }
    let container = flow
        .container
        .clone()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad_request("Bad request. The Flow 'container' is not set."))?;
    let known = segments_in(&mut transaction, flow_id).await?;
    let mut ranges = known
        .iter()
        .map(|value| segment::bounds(&value.timerange))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| invalid_json())?;
    db::objects::lock_sorted(&mut transaction, ids.clone())
        .await
        .map_err(internal)?;
    let mut objects = media_records_in(&mut transaction, &ids)
        .await?
        .into_iter()
        .map(|record| (record.id.clone(), record))
        .collect::<BTreeMap<_, _>>();
    let mut failed = Vec::new();
    let mut accepted = Vec::new();
    for value in values {
        match register_one(
            &storage,
            &backends,
            &flow,
            &container,
            &mut transaction,
            &mut objects,
            &mut ranges,
            &uploads,
            &value,
        )
        .await
        {
            Ok(segment) => accepted.push(segment),
            Err(RegisterError::Validation(summary)) if bulk => failed.push(json!({"object_id":value.get("object_id"),"timerange":value.get("timerange"),"error":{"type":"TAMSError","summary":summary,"time":model::timestamp(crate::now())}})),
            Err(RegisterError::Validation(summary)) => {
                return Err(ApiError::bad_request(summary));
            }
            Err(RegisterError::Infrastructure(error)) => return Err(error),
        }
    }
    if !accepted.is_empty() {
        flow.segments_updated = Some(crate::now());
        db::flows::save_flow(&mut *transaction, &flow)
            .await
            .map_err(internal)?;
        segment_events(&mut transaction, &flow, "flows/segments_added", &accepted).await?;
    }
    transaction.commit().await.map_err(internal)?;
    if failed.is_empty() {
        Ok(StatusCode::CREATED.into_response())
    } else {
        Ok(Json(json!({"failed_segments":failed})).into_response())
    }
}

#[allow(clippy::too_many_arguments)]
async fn register_one(
    storage: &StorageFactory,
    backends: &[crate::db::StorageBackend],
    flow: &crate::db::FlowRecord,
    container: &str,
    transaction: &mut Transaction<'_, Engine>,
    objects: &mut BTreeMap<String, MediaObjectRecord>,
    ranges: &mut Vec<segment::SegmentBounds>,
    uploads: &BTreeMap<String, Option<i64>>,
    value: &Value,
) -> Result<SegmentRecord, RegisterError> {
    let bad = || "Bad request. Invalid Flow Segment JSON.".to_owned();
    let (object_id, timerange, bounds) = segment::validate_post(value).map_err(|_| bad())?;
    if ranges.iter().any(|known| segment::overlaps(*known, bounds)) {
        return Err("Segment timerange overlaps with an existing segment".into());
    }
    let data = value.as_object().expect("validated segment");
    let requested_init = data.get("init_object_id").and_then(Value::as_str);
    if requested_init == Some(object_id) {
        return Err(bad().into());
    }
    let now = crate::now();
    let existing = objects.get(object_id);
    let had_references = existing.is_some_and(|record| !record.referenced_by_flows.is_empty());
    let mut media = existing
        .map(|record| MediaObject::from_record(record, backends))
        .unwrap_or_else(|| MediaObject {
            id: object_id.into(),
            timerange: None,
            init_object_id: None,
            first_referenced_by_flow: None,
            allocated_by_flow: None,
            referenced_by_flows: BTreeSet::new(),
            instances: Vec::new(),
            key_frame_count: None,
            bytes_written: 0,
            object_kind: "unassigned".into(),
            content_type: None,
            created: now,
        });
    if existing.is_none()
        && data
            .get("get_urls")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
    {
        return Err("Object must be allocated by this service or registered with get_urls.".into());
    }
    if media.object_kind == "init" {
        return Err("Bad request. Init Objects cannot be used as media.".into());
    }
    if had_references
        && (data.get("object_timerange").is_some()
            || data
                .get("key_frame_count")
                .is_some_and(|value| value.as_i64() != media.key_frame_count))
    {
        return Err(bad().into());
    }
    if !had_references {
        uploaded(storage, &mut media, flow.id, uploads).await?;
    }
    if media
        .content_type
        .as_deref()
        .is_some_and(|value| value != container)
    {
        return Err("Bad request. Media Object content type must match the Flow container.".into());
    }
    media.content_type = Some(container.into());
    let resolved_init = if flow.init_segments {
        let resolved = requested_init
            .or(media.init_object_id.as_deref())
            .ok_or_else(|| "Bad request. init_object_id is required for this Flow.".to_owned())?;
        if (had_references || media.init_object_id.is_some())
            && media.init_object_id.as_deref() != Some(resolved)
        {
            return Err(
                "Bad request. Media Object already references a different init Object.".into(),
            );
        }
        Some(resolved.to_owned())
    } else {
        if requested_init.is_some() || media.init_object_id.is_some() {
            return Err("Bad request. init_object_id is not valid for this Flow.".into());
        }
        None
    };
    let mut init = if let Some(id) = resolved_init.as_deref() {
        let record = objects.get(id).ok_or_else(|| {
            "Init Object must be allocated by this service before registration.".to_owned()
        })?;
        let mut init = MediaObject::from_record(record, backends);
        if init.object_kind == "media" || init.timerange.is_some() {
            return Err("Bad request. Media Objects cannot be used as init Objects.".into());
        }
        if init.referenced_by_flows.is_empty() {
            uploaded(storage, &mut init, flow.id, uploads).await?;
        }
        Some(init)
    } else {
        None
    };
    for entry in data
        .get("get_urls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let entry = entry.as_object().ok_or_else(bad)?;
        let url = entry.get("url").and_then(Value::as_str).ok_or_else(bad)?;
        let label = entry.get("label").and_then(Value::as_str).ok_or_else(bad)?;
        let presigned = entry
            .get("presigned")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if backends.iter().any(|backend| backend.label == label) {
            return Err(bad().into());
        }
        if let Some(current) = media
            .instances
            .iter()
            .find(|instance| !instance.controlled && instance.label.as_deref() == Some(label))
        {
            if current.url.as_deref() != Some(url) || current.presigned != presigned {
                return Err(bad().into());
            }
        } else {
            media.instances.push(ObjectInstance {
                storage_backend: None,
                storage_backend_id: None,
                url: Some(url.into()),
                label: Some(label.into()),
                controlled: false,
                presigned,
            });
        }
    }
    let effective = segment::effective_object_timerange(
        timerange,
        data.get("ts_offset").and_then(Value::as_str),
        if had_references {
            media.timerange.as_deref()
        } else {
            data.get("object_timerange").and_then(Value::as_str)
        },
    )
    .map_err(|_| bad())?;
    media.first_referenced_by_flow.get_or_insert(flow.id);
    media.allocated_by_flow = None;
    media.referenced_by_flows.insert(flow.id);
    media.object_kind = "media".into();
    media.init_object_id = resolved_init.clone();
    if !had_references {
        media.timerange = union_values(media.timerange.as_deref(), Some(&effective));
        if let Some(count) = data.get("key_frame_count").and_then(Value::as_i64) {
            media.key_frame_count = Some(count);
        }
    }
    if let Some(init) = init.as_mut() {
        init.first_referenced_by_flow.get_or_insert(flow.id);
        init.allocated_by_flow = None;
        init.referenced_by_flows.insert(flow.id);
        init.object_kind = "init".into();
        init.timerange = None;
    }
    let media_record = media.into_record(now);
    db::objects::save(&mut **transaction, &media_record)
        .await
        .map_err(internal)?;
    objects.insert(object_id.into(), media_record);
    if let Some(init) = init {
        let id = init.id.clone();
        let record = init.into_record(now);
        db::objects::save(&mut **transaction, &record)
            .await
            .map_err(internal)?;
        objects.insert(id, record);
    }
    let object_timerange = (effective != timerange).then_some(effective);
    let record = SegmentRecord {
        flow_id: flow.id,
        object_id: object_id.into(),
        init_object_id: resolved_init.clone(),
        timerange: timerange.into(),
        timerange_start: bounds.start,
        timerange_end: bounds.end,
        record: json!({"flow_id":flow.id,"object_id":object_id,"init_object_id":resolved_init,"timerange":timerange,"ts_offset":data.get("ts_offset"),"last_duration":data.get("last_duration"),"object_timerange":object_timerange,"sample_offset":data.get("sample_offset"),"sample_count":data.get("sample_count"),"key_frame_count":data.get("key_frame_count"),"created":model::timestamp(now)}),
        created: now,
    };
    db::flows::append_segment(&mut **transaction, &record)
        .await
        .map_err(internal)?;
    ranges.push(bounds);
    Ok(record)
}

async fn uploaded(
    storage: &StorageFactory,
    media: &mut MediaObject,
    flow_id: Uuid,
    uploads: &BTreeMap<String, Option<i64>>,
) -> Result<(), RegisterError> {
    let Some(instance) = media.instances.iter().find(|instance| instance.controlled) else {
        return Ok(());
    };
    if media
        .allocated_by_flow
        .is_some_and(|allocated| allocated != flow_id)
    {
        return Err("Bad request. Allocated Object must be registered against the Flow that requested its storage.".into());
    }
    let backend = instance
        .storage_backend
        .as_ref()
        .ok_or_else(|| "Bad request. Invalid Flow Segment JSON.".to_owned())?;
    media.bytes_written = match uploads.get(&media.id).copied() {
        Some(Some(content_length)) => content_length,
        Some(None) => {
            return Err("Bad request. Controlled object content is missing.".into());
        }
        None => storage
            .head_optional(backend, &media.id)
            .await
            .map_err(internal)?
            .ok_or_else(|| "Bad request. Controlled object content is missing.".to_owned())?
            .content_length
            .unwrap_or(0),
    };
    Ok(())
}
fn union_values(left: Option<&str>, right: Option<&str>) -> Option<String> {
    let values = [left, right].into_iter().flatten().collect::<Vec<_>>();
    match values.as_slice() {
        [] => None,
        [value] => Some((*value).to_owned()),
        values => {
            let ranges = values
                .iter()
                .filter_map(|value| segment::bounds(value).ok())
                .collect::<Vec<_>>();
            (!ranges.is_empty()).then(|| {
                crate::domain::timerange::from_bounds(
                    ranges.iter().map(|value| value.start).min(),
                    ranges.iter().map(|value| value.end).max(),
                )
            })
        }
    }
}
fn union_many(values: &[String]) -> Option<String> {
    match values {
        [] => None,
        [value] => Some(value.clone()),
        values => {
            let ranges = values
                .iter()
                .filter_map(|value| segment::bounds(value).ok())
                .collect::<Vec<_>>();
            (!ranges.is_empty()).then(|| {
                crate::domain::timerange::from_bounds(
                    ranges.iter().map(|value| value.start).min(),
                    ranges.iter().map(|value| value.end).max(),
                )
            })
        }
    }
}

async fn delete(
    State(state): State<MetadataState>,
    Extension(storage): Extension<StorageFactory>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let flow_id = flow_id(&request, "The requested Flow ID in the path is invalid.")?;
    let identity = request
        .extensions()
        .get::<Actor>()
        .cloned()
        .ok_or_else(|| ApiError::unauthorized("Authentication required."))?;
    let params = query(&request, &["timerange", "object_id"], &[])?;
    let timerange_text = params.last("timerange");
    let requested = timerange_text
        .filter(|value| !matches!(*value, "" | "_"))
        .map(crate::domain::timerange::parse)
        .transpose()
        .map_err(|_| invalid_query())?;
    let object_id = params.last("object_id").map(str::to_owned);
    let backends = storage.backends().await.map_err(internal)?;
    let pool = state.pool().await?;
    let mut transaction = pool.begin().await.map_err(internal)?;
    db::flows::lock_flow_segments(&mut *transaction, flow_id)
        .await
        .map_err(internal)?;
    let mut flow = db::flows::get_flow_with(&mut *transaction, flow_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| ApiError::not_found("The requested Flow ID in the path is invalid."))?;
    if flow.read_only {
        return Err(ApiError::forbidden(
            "Forbidden. The requested Flow is read-only.",
        ));
    }
    let selected = segments_in(&mut transaction, flow_id)
        .await?
        .into_iter()
        .filter(|item| {
            object_id.as_deref().is_none_or(|id| item.object_id == id)
                && requested.is_none_or(|query| {
                    !query.empty
                        && segment::bounds(&item.timerange).is_ok_and(|value| {
                            value.start >= query.start.unwrap_or(i128::MIN)
                                && value.end
                                    <= if query.point {
                                        query.start.map(|start| start.saturating_add(1))
                                    } else {
                                        query.end
                                    }
                                    .unwrap_or(i128::MAX)
                        })
                })
        })
        .collect::<Vec<_>>();
    if selected.is_empty() {
        transaction.commit().await.map_err(internal)?;
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    if object_id.is_none() {
        let now = crate::now();
        let now = now
            .replace_nanosecond(now.nanosecond() / 1_000 * 1_000)
            .expect("whole microseconds are valid nanoseconds");
        let id = Uuid::new_v4();
        let matching = timerange_union(&selected);
        let to_delete = timerange_text
            .filter(|value| !matches!(*value, "" | "_"))
            .unwrap_or(&matching)
            .to_owned();
        let mut record = json!({"id":id,"flow_id":flow_id,"timerange_to_delete":to_delete,"timerange_remaining":to_delete,"delete_flow":false,"created":model::timestamp(now),"created_by":identity.subject,"updated":model::timestamp(now),"status":"created","error":null});
        record
            .as_object_mut()
            .expect("delete request")
            .retain(|_, value| !value.is_null());
        db::queues::save_delete_request(
            &mut *transaction,
            &DeleteRequest {
                id,
                flow_id,
                status: "created".into(),
                record: record.clone(),
                updated: now,
                created_at: now,
                claimed_at: None,
                claimed_by: None,
                claim_expires_at: None,
            },
        )
        .await
        .map_err(internal)?;
        transaction.commit().await.map_err(internal)?;
        let origin = crate::http::paging::origin(request.uri(), request.headers())?;
        let mut response = Json(record).into_response();
        *response.status_mut() = StatusCode::ACCEPTED;
        response.headers_mut().insert(
            LOCATION,
            HeaderValue::from_str(&format!("{origin}/flow-delete-requests/{id}"))
                .map_err(internal)?,
        );
        return Ok(response);
    }
    let ids = selected
        .iter()
        .flat_map(|item| [Some(item.object_id.clone()), item.init_object_id.clone()])
        .flatten()
        .collect::<BTreeSet<_>>();
    db::objects::lock_sorted(&mut transaction, ids.clone())
        .await
        .map_err(internal)?;
    for item in &selected {
        sqlx::query(crate::db::statements::DELETE_SEGMENT)
            .bind(flow_id)
            .bind(&item.object_id)
            .bind(&item.timerange)
            .execute(&mut *transaction)
            .await
            .map_err(internal)?;
    }
    let now = crate::now();
    for record in media_records_in(&mut transaction, &ids).await? {
        let mut media = MediaObject::from_record(&record, &backends);
        let remains: bool = sqlx::query_scalar(crate::db::statements::HAS_REFERENCES)
            .bind(flow_id)
            .bind(&record.id)
            .fetch_one(&mut *transaction)
            .await
            .map_err(internal)?;
        if !remains {
            media.referenced_by_flows.remove(&flow_id);
        }
        if media.referenced_by_flows.is_empty() {
            queue_cleanup(&mut transaction, &media, now).await?;
            db::objects::delete(&mut *transaction, &media.id)
                .await
                .map_err(internal)?;
        } else {
            if media.object_kind != "init" {
                media.timerange = union_many(&object_ranges(&mut transaction, &media.id).await?);
            }
            db::objects::save(&mut *transaction, &media.into_record(now))
                .await
                .map_err(internal)?;
        }
    }
    flow.segments_updated = Some(now);
    db::flows::save_flow(&mut *transaction, &flow)
        .await
        .map_err(internal)?;
    segment_events(&mut transaction, &flow, "flows/segments_deleted", &selected).await?;
    transaction.commit().await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn segment_events(
    transaction: &mut Transaction<'_, Engine>,
    flow: &crate::db::FlowRecord,
    kind: &str,
    segments: &[SegmentRecord],
) -> Result<(), ApiError> {
    let parents = db::flows::list_flows_collecting(&mut **transaction, &[flow.id])
        .await
        .map_err(internal)?;
    let parent_ids = parents.iter().map(|value| value.id).collect::<Vec<_>>();
    let source_ids = flow.source_id.into_iter().collect::<Vec<_>>();
    let relationships = db::flows::source_relationships(&mut **transaction, &source_ids)
        .await
        .map_err(internal)?;
    let source_parents = flow
        .source_id
        .and_then(|id| relationships.get(&id))
        .map(|value| value.collected_by.clone())
        .unwrap_or_default();
    let event = if kind == "flows/segments_deleted" {
        json!({"flow_id":flow.id,"timerange":timerange_union(segments)})
    } else {
        json!({"flow_id":flow.id,"segments":segments.iter().map(|value| segment::response(value,Vec::new(),value.init_object_id.as_deref().map(|id| (id,Vec::new())),true)).collect::<Vec<_>>()})
    };
    let updated = json!({"flow":model::flow(flow,&parent_ids,None)});
    if kind == "flows/segments_deleted" {
        enqueue_event(
            transaction,
            kind,
            event,
            &[flow.id],
            &source_ids,
            &parent_ids,
            &source_parents,
        )
        .await?;
        enqueue_event(
            transaction,
            "flows/updated",
            updated,
            &[flow.id],
            &source_ids,
            &parent_ids,
            &source_parents,
        )
        .await
    } else {
        enqueue_event(
            transaction,
            "flows/updated",
            updated,
            &[flow.id],
            &source_ids,
            &parent_ids,
            &source_parents,
        )
        .await?;
        enqueue_event(
            transaction,
            kind,
            event,
            &[flow.id],
            &source_ids,
            &parent_ids,
            &source_parents,
        )
        .await
    }
}
pub(crate) async fn webhook_event(
    connection: &mut sqlx::Connection,
    event: &Value,
    options: &serde_json::Map<String, Value>,
) -> Result<Value, ApiError> {
    let pool = sqlx::Pool(connection.0.clone());
    let storage = StorageFactory::new(db::Database(connection.0.clone()));
    let mut event = event.clone();
    let segments = event["segments"]
        .as_array_mut()
        .ok_or_else(|| internal("Missing event Segments"))?;
    let ids = segments
        .iter()
        .flat_map(|value| {
            [
                value["object_id"].as_str(),
                value
                    .pointer("/init_object/object_id")
                    .and_then(Value::as_str),
            ]
        })
        .flatten()
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    let labels = options
        .get("accept_get_urls")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        });
    let storage_ids = options
        .get("accept_storage_ids")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|id| id.parse().ok())
                .collect()
        });
    let backends = storage.backends().await.map_err(internal)?;
    let mut urls = BTreeMap::new();
    for record in db::objects::get_many(&pool, &ids.into_iter().collect::<Vec<_>>())
        .await
        .map_err(internal)?
    {
        let media = MediaObject::from_record(&record, &backends);
        urls.insert(
            record.id.clone(),
            object_urls(
                &storage,
                &media,
                &record.id,
                options
                    .get("verbose_storage")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                options.get("presigned").and_then(Value::as_bool),
                labels.as_ref(),
                storage_ids.as_ref(),
                &BTreeMap::new(),
                &BTreeMap::new(),
            )
            .await?,
        );
    }
    for value in segments {
        value["get_urls"] = json!(
            value["object_id"]
                .as_str()
                .and_then(|id| urls.get(id))
                .cloned()
                .unwrap_or_default()
        );
        if let Some(init) = value.get_mut("init_object") {
            init["get_urls"] = json!(
                init["object_id"]
                    .as_str()
                    .and_then(|id| urls.get(id))
                    .cloned()
                    .unwrap_or_default()
            );
        }
        if options
            .get("include_object_timerange")
            .and_then(Value::as_bool)
            != Some(true)
        {
            value
                .as_object_mut()
                .expect("event Segment")
                .remove("object_timerange");
        }
    }
    Ok(event)
}

async fn queue_cleanup(
    transaction: &mut Transaction<'_, Engine>,
    media: &MediaObject,
    now: OffsetDateTime,
) -> Result<(), ApiError> {
    for backend in media
        .instances
        .iter()
        .filter_map(|instance| {
            instance
                .controlled
                .then_some(instance.storage_backend_id)
                .flatten()
        })
        .collect::<BTreeSet<_>>()
    {
        db::queues::save_cleanup(&mut **transaction, &ObjectCleanup { id: Uuid::new_v4(), delete_request_id: None, object_id: media.id.clone(), storage_backend_id: backend, status: "pending".into(), record: json!({"object_id":media.id,"storage_backend_id":backend,"status":"pending","attempt_count":0,"error":null,"created":model::timestamp(now),"updated":model::timestamp(now)}), updated: now, created_at: now, claimed_at: None, claimed_by: None, claim_expires_at: None }).await.map_err(internal)?;
    }
    Ok(())
}

async fn segments_in(
    transaction: &mut Transaction<'_, Engine>,
    flow_id: Uuid,
) -> Result<Vec<SegmentRecord>, ApiError> {
    sqlx::query(crate::db::statements::FLOW_SEGMENTS)
        .bind(flow_id)
        .fetch_all(&mut **transaction)
        .await
        .map_err(internal)?
        .into_iter()
        .map(|row| {
            Ok(SegmentRecord {
                flow_id: row.try_get(0).map_err(internal)?,
                object_id: row.try_get(1).map_err(internal)?,
                init_object_id: row.try_get(2).map_err(internal)?,
                timerange: row.try_get(3).map_err(internal)?,
                timerange_start: row.try_get(4).map_err(internal)?,
                timerange_end: row.try_get(5).map_err(internal)?,
                record: row
                    .try_get::<sqlx::types::Json<Value>, _>(6)
                    .map_err(internal)?
                    .0,
                created: row.try_get(7).map_err(internal)?,
            })
        })
        .collect()
}
async fn media_records_in(
    transaction: &mut Transaction<'_, Engine>,
    ids: &BTreeSet<String>,
) -> Result<Vec<MediaObjectRecord>, ApiError> {
    sqlx::query(crate::db::statements::GET_OBJECTS)
        .bind(ids.iter().cloned().collect::<Vec<_>>())
        .fetch_all(&mut **transaction)
        .await
        .map_err(internal)?
        .into_iter()
        .map(|row| {
            Ok(MediaObjectRecord {
                id: row.try_get(0).map_err(internal)?,
                first_referenced_by_flow: row.try_get(1).map_err(internal)?,
                referenced_by_flows: row.try_get(2).map_err(internal)?,
                object_kind: row.try_get(3).map_err(internal)?,
                content_type: row.try_get(4).map_err(internal)?,
                record: row
                    .try_get::<sqlx::types::Json<Value>, _>(5)
                    .map_err(internal)?
                    .0,
                created_at: row.try_get(6).map_err(internal)?,
                updated_at: row.try_get(7).map_err(internal)?,
            })
        })
        .collect()
}
async fn object_ranges(
    transaction: &mut Transaction<'_, Engine>,
    object_id: &str,
) -> Result<Vec<String>, ApiError> {
    let rows = sqlx::query(crate::db::statements::OBJECT_RANGES)
        .bind(object_id)
        .fetch_all(&mut **transaction)
        .await
        .map_err(internal)?;
    rows.into_iter()
        .map(|row| {
            let timerange: String = row.try_get(0).map_err(internal)?;
            let record = row
                .try_get::<sqlx::types::Json<Value>, _>(1)
                .map_err(internal)?
                .0;
            segment::effective_object_timerange(
                &timerange,
                record.get("ts_offset").and_then(Value::as_str),
                record.get("object_timerange").and_then(Value::as_str),
            )
            .map_err(|_| ApiError::bad_request("Bad request. Invalid stored Segment timerange."))
        })
        .collect()
}
