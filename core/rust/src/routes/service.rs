// Cloudflare adaptation of TASM and rust-tams-api (Apache-2.0); see NOTICE.
use crate::sql as sqlx;
use std::{collections::BTreeSet, sync::Arc};

use axum::{
    Json,
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use sqlx::{Connection, Pool};
use uuid::Uuid;

use crate::{
    config::Settings,
    db::{self, PageRequest, ServiceMetadata, TagFilters, WebhookDelivery},
    domain::model,
    http::{
        MAX_JSON_BODY_BYTES,
        error::ApiError,
        paging::page_headers,
        query::{QueryParams, invalid_query},
        strict_json,
    },
};

#[derive(Clone)]
pub struct MetadataState {
    pub pool: Pool,
    pub settings: Arc<Settings>,
}

impl MetadataState {
    pub fn new(pool: Pool, settings: Arc<Settings>) -> Self {
        Self { pool, settings }
    }
}

pub(crate) fn internal(error: impl std::fmt::Display) -> ApiError {
    ApiError::internal(&error)
}
pub(crate) fn query(
    request: &Request<Body>,
    allowed: &[&str],
    prefixes: &[&str],
) -> Result<QueryParams, ApiError> {
    let query = QueryParams::parse(request.uri().query());
    query.validate(allowed, prefixes)?;
    Ok(query)
}
pub(crate) fn page(query: &QueryParams) -> Result<PageRequest, ApiError> {
    page_from(query, query.last("page"))
}
pub(crate) fn page_from(query: &QueryParams, key: Option<&str>) -> Result<PageRequest, ApiError> {
    let limit = query.integer("limit")?;
    if limit.is_some_and(|value| value <= 0) {
        return Err(invalid_query());
    }
    PageRequest::parse(key, limit).map_err(|_| invalid_query())
}
pub(crate) fn tag_filters(query: &QueryParams) -> Result<TagFilters, ApiError> {
    model::tag_filters(
        query.dynamic_csv("tag.")?,
        query.dynamic_bool("tag_exists.")?,
    )
    .map_err(|_| invalid_query())
}
pub(crate) fn paged_response(
    request: &Request<Body>,
    value: Value,
    limit: i64,
    count: usize,
    next: Option<&str>,
    reverse: Option<bool>,
) -> Result<Response, ApiError> {
    let mut response = Json(value).into_response();
    page_headers(
        response.headers_mut(),
        request.uri(),
        request.headers(),
        limit as usize,
        count,
        next,
        reverse,
    )?;
    Ok(response)
}

pub(crate) async fn root(request: Request<Body>) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    Ok(Json(json!([
        "service",
        "flows",
        "sources",
        "objects",
        "flow-delete-requests"
    ]))
    .into_response())
}

pub(crate) async fn service(
    State(state): State<MetadataState>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let metadata = db::service::get_metadata(&state.pool)
        .await
        .map_err(internal)?;
    let name = metadata.as_ref().map_or_else(
        || Some(state.settings.service_name.clone()),
        |value| value.name.clone(),
    );
    let description = metadata.as_ref().map_or_else(
        || Some(state.settings.service_description.clone()),
        |value| value.description.clone(),
    );
    let mut value = json!({
        "type": crate::config::SERVICE_TYPE, "api_version": state.settings.api_version,
        "service_version": state.settings.service_version, "name": name, "description": description,
        "event_stream_mechanisms": [{"name":"webhooks"}],
        "min_object_timeout": state.settings.min_object_timeout,
        "min_presigned_url_timeout": crate::storage::SIGNED_URLS.then(|| format!("{}:0", crate::domain::object::MIN_SIGNED_URL_SECONDS)),
    });
    value
        .as_object_mut()
        .unwrap()
        .retain(|_, value| !value.is_null());
    Ok(Json(value).into_response())
}

pub(crate) async fn update_service(
    State(state): State<MetadataState>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let value: Value = strict_json(request, MAX_JSON_BODY_BYTES)
        .await
        .map_err(|_| ApiError::bad_request("Bad request. Invalid service JSON."))?;
    let value = value
        .as_object()
        .ok_or_else(|| ApiError::bad_request("Bad request. Invalid service JSON."))?;
    let field = |name: &str, default: &str| -> Result<Option<String>, ApiError> {
        match value.get(name) {
            None => Ok(Some(default.to_owned())),
            Some(Value::String(value)) => Ok((!value.is_empty()).then(|| value.clone())),
            Some(_) => Err(ApiError::bad_request("Bad request. Invalid service JSON.")),
        }
    };
    db::service::save_metadata(
        &state.pool,
        &ServiceMetadata {
            name: field("name", &state.settings.service_name)?,
            description: field("description", &state.settings.service_description)?,
        },
        value.contains_key("name"),
        value.contains_key("description"),
    )
    .await
    .map_err(internal)?;
    Ok(StatusCode::OK.into_response())
}

pub(crate) async fn storage_backends(
    State(state): State<MetadataState>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let query = query(
        &request,
        &["reverse_order", "page", "limit"],
        &["tag.", "tag_exists."],
    )?;
    let reverse = query.bool("reverse_order")?.unwrap_or(false);
    let page_request = page(&query)?;
    let result = db::service::list_storage_backends(
        &state.pool,
        &tag_filters(&query)?,
        reverse,
        &page_request,
    )
    .await
    .map_err(internal)?;
    let count = result.items.len();
    paged_response(
        &request,
        Value::Array(result.items.iter().map(model::storage_backend).collect()),
        result.limit,
        count,
        result.next_page.as_deref(),
        Some(reverse),
    )
}

fn selector(
    data: &serde_json::Map<String, Value>,
    name: &str,
    ids: &[String],
    collection: bool,
) -> bool {
    match data.get(name) {
        None => true,
        Some(Value::Array(values)) => {
            let selected: BTreeSet<_> = values.iter().filter_map(Value::as_str).collect();
            if collection && selected.is_empty() {
                ids.is_empty()
            } else if selected.is_empty() {
                true
            } else {
                ids.iter().any(|id| selected.contains(id.as_str()))
            }
        }
        _ => false,
    }
}

/// Webhook recipients for a flow event: the flow's source and the flow
/// collections that contain the flow or its source.
pub(crate) struct FlowAudience {
    pub parent_ids: Vec<Uuid>,
    pub source_ids: Vec<Uuid>,
    pub source_parents: Vec<Uuid>,
}

pub(crate) async fn flow_audience(
    connection: &mut Connection,
    flow: &db::FlowRecord,
) -> Result<FlowAudience, ApiError> {
    let parent_ids = db::flows::list_flows_collecting(&mut *connection, &[flow.id])
        .await
        .map_err(internal)?
        .iter()
        .map(|value| value.id)
        .collect();
    let source_ids = flow.source_id.into_iter().collect::<Vec<_>>();
    let source_parents = match flow.source_id {
        Some(id) => db::flows::source_relationships(&mut *connection, &[id])
            .await
            .map_err(internal)?
            .remove(&id)
            .map(|value| value.collected_by)
            .unwrap_or_default(),
        None => Vec::new(),
    };
    Ok(FlowAudience {
        parent_ids,
        source_ids,
        source_parents,
    })
}

pub(crate) async fn enqueue_flow_event(
    connection: &mut Connection,
    event_type: &str,
    event: Value,
    flow: &db::FlowRecord,
    audience: &FlowAudience,
) -> Result<(), ApiError> {
    enqueue_event(
        connection,
        event_type,
        event,
        &[flow.id],
        &audience.source_ids,
        &audience.parent_ids,
        &audience.source_parents,
    )
    .await
}

/// Queues `flows/updated` for a flow whose stored record just changed.
pub(crate) async fn emit_flow_updated(
    connection: &mut Connection,
    flow: &db::FlowRecord,
) -> Result<(), ApiError> {
    let audience = flow_audience(&mut *connection, flow).await?;
    let event = json!({"flow":crate::domain::model::flow(flow,&audience.parent_ids,None)});
    enqueue_flow_event(connection, "flows/updated", event, flow, &audience).await
}

pub(crate) async fn enqueue_event(
    connection: &mut Connection,
    event_type: &str,
    event: Value,
    flow_ids: &[Uuid],
    source_ids: &[Uuid],
    flow_collected_by: &[Uuid],
    source_collected_by: &[Uuid],
) -> Result<(), ApiError> {
    let candidates = db::service::active_webhooks_for_event(&mut *connection, event_type)
        .await
        .map_err(internal)?;
    let flow_ids: Vec<_> = flow_ids.iter().map(ToString::to_string).collect();
    let source_ids: Vec<_> = source_ids.iter().map(ToString::to_string).collect();
    let flow_collected_by: Vec<_> = flow_collected_by.iter().map(ToString::to_string).collect();
    let source_collected_by: Vec<_> = source_collected_by
        .iter()
        .map(ToString::to_string)
        .collect();
    let now = crate::now();
    for mut webhook in candidates {
        let Some(data) = webhook.record.get("data").and_then(Value::as_object) else {
            continue;
        };
        if event_type.starts_with("flows/")
            && (!selector(data, "flow_ids", &flow_ids, false)
                || !selector(data, "flow_collected_by_ids", &flow_collected_by, true))
            || !selector(data, "source_ids", &source_ids, false)
            || !selector(data, "source_collected_by_ids", &source_collected_by, true)
        {
            continue;
        }
        let event = if event_type == "flows/segments_added" {
            super::segments::webhook_event(connection, &event, data).await?
        } else {
            event.clone()
        };
        if webhook.status == "created" {
            webhook.status = "started".into();
            db::service::save_webhook(&mut *connection, &webhook)
                .await
                .map_err(internal)?;
        }
        let snapshot = json!({
            "url": data.get("url"),
            "accept_get_urls": data.get("accept_get_urls"), "accept_storage_ids": data.get("accept_storage_ids"),
            "presigned": data.get("presigned"), "verbose_storage": data.get("verbose_storage"), "status": webhook.status,
            "include_object_timerange": data.get("include_object_timerange"),
        });
        let id = Uuid::new_v4();
        let stamp = model::timestamp(now);
        let record = json!({"id":id,"webhook_id":webhook.id,"webhook_snapshot":snapshot,"event_type":event_type,"event_timestamp":stamp,"payload":{"event_timestamp":stamp,"event_type":event_type,"event":event},"status":"pending","attempt_count":0,"response":null,"error":null,"created":stamp,"updated":stamp,"next_attempt_at":stamp});
        db::queues::save_webhook_delivery(
            &mut *connection,
            &WebhookDelivery {
                id,
                webhook_id: webhook.id,
                status: "pending".into(),
                next_attempt_at: Some(now),
                record,
                created_at: now,
                updated_at: now,
                claimed_at: None,
                claimed_by: None,
                claim_expires_at: None,
            },
        )
        .await
        .map_err(internal)?;
    }
    Ok(())
}
