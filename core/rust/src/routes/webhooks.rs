// Cloudflare adaptation of TASM and rust-tams-api (Apache-2.0); see NOTICE.
use crate::webhook_target::validate_configuration;

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::{
    db::{self, WebhookRecord},
    domain::model,
    http::{MAX_JSON_BODY_BYTES, error::ApiError, strict_json},
};

use super::service::{MetadataState, internal, page, paged_response, query, tag_filters};

pub fn router() -> Router<MetadataState> {
    Router::new()
        .route("/service/webhooks", get(list).head(list).post(create))
        .route(
            "/service/webhooks/{webhookId}",
            get(get_webhook)
                .head(get_webhook)
                .put(update)
                .delete(remove),
        )
}

fn invalid() -> ApiError {
    ApiError::bad_request("Bad request. Invalid Webhook JSON.")
}
fn not_found() -> ApiError {
    ApiError::not_found("The requested Webhook ID in the path is invalid.")
}
fn id(value: &str) -> Result<Uuid, ApiError> {
    model::parse_uuid(value).map_err(|_| not_found())
}

async fn list(
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
    let result = db::service::list_webhooks(
        &state.pool().await?,
        &tag_filters(&query)?,
        reverse,
        &page_request,
    )
    .await
    .map_err(internal)?;
    let count = result.items.len();
    paged_response(
        &request,
        Value::Array(result.items.iter().map(model::webhook).collect()),
        result.limit,
        count,
        result.next_page.as_deref(),
        Some(reverse),
    )
}

async fn get_webhook(
    State(state): State<MetadataState>,
    Path(raw): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let record = db::service::get_webhook(&state.pool().await?, id(&raw)?)
        .await
        .map_err(internal)?
        .ok_or_else(not_found)?;
    Ok(Json(model::webhook(&record)).into_response())
}

fn strings(map: &Map<String, Value>, name: &str, uuids: bool) -> Result<(), ApiError> {
    let Some(value) = map.get(name) else {
        return Ok(());
    };
    let values = value.as_array().ok_or_else(invalid)?;
    for value in values {
        let value = value.as_str().ok_or_else(invalid)?;
        if uuids {
            model::parse_uuid(value).map_err(|_| invalid())?;
        }
    }
    Ok(())
}
fn validate_shape(
    map: &Map<String, Value>,
    update: bool,
) -> Result<(String, crate::db::Tags, Map<String, Value>), ApiError> {
    map.get("url").and_then(Value::as_str).ok_or_else(invalid)?;
    for name in ["api_key_name", "api_key_value"] {
        if map.get(name).is_some_and(|value| !value.is_string()) {
            return Err(invalid());
        }
    }
    let events = map
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if events.iter().any(|value| {
        value
            .as_str()
            .is_none_or(|event| !model::WEBHOOK_EVENTS.contains(&event))
    }) {
        return Err(invalid());
    }
    for name in [
        "flow_ids",
        "source_ids",
        "flow_collected_by_ids",
        "source_collected_by_ids",
        "accept_storage_ids",
    ] {
        strings(map, name, true)?;
    }
    strings(map, "accept_get_urls", false)?;
    for name in ["presigned", "verbose_storage", "include_object_timerange"] {
        if map.get(name).is_some_and(|value| !value.is_boolean()) {
            return Err(invalid());
        }
    }
    let status = match map.get("status") {
        None if !update => "created",
        Some(Value::String(value)) if matches!(value.as_str(), "created" | "disabled") => value,
        _ => return Err(invalid()),
    }
    .to_owned();
    let tags = model::tags(map.get("tags")).map_err(|_| invalid())?;
    let mut data = map.clone();
    data.remove("id");
    data.remove("status");
    data.remove("tags");
    data.remove("error");
    Ok((status, tags, data))
}

pub(crate) fn invalid_payload() -> ApiError {
    ApiError::bad_request("Bad request. Invalid webhook payload.")
}

async fn create(
    State(state): State<MetadataState>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let value: Value = strict_json(request, MAX_JSON_BODY_BYTES)
        .await
        .map_err(|_| invalid())?;
    let map = value.as_object().ok_or_else(invalid)?;
    let (status, tags, data) = validate_shape(map, false)?;
    validate_configuration(&state, map).await?;
    let id = Uuid::new_v4();
    let envelope = json!({"id":id,"data":data,"status":status,"tags":tags});
    let record = WebhookRecord {
        id,
        status,
        tags,
        record: envelope,
    };
    db::service::save_webhook(&state.pool().await?, &record)
        .await
        .map_err(internal)?;
    Ok((StatusCode::CREATED, Json(model::webhook(&record))).into_response())
}

async fn update(
    State(state): State<MetadataState>,
    Path(raw): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let path = id(&raw)?;
    let value: Value = strict_json(request, MAX_JSON_BODY_BYTES)
        .await
        .map_err(|_| invalid())?;
    let map = value.as_object().ok_or_else(invalid)?;
    let validated = validate_shape(map, true)?;
    if model::uuid_field(map, "id").map_err(|_| invalid())? != path {
        return Err(not_found());
    }
    let pool = state.pool().await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let existing = db::service::get_webhook_with(&mut *tx, path)
        .await
        .map_err(internal)?
        .ok_or_else(not_found)?;
    if existing.status == "error" && map.get("status").and_then(Value::as_str) == Some("disabled") {
        return Err(ApiError::bad_request(
            "Bad request. The Webhook is currently in an error status and therefore cannot be updated to disabled.",
        ));
    }
    validate_configuration(&state, map).await?;
    let (status, tags, mut data) = validated;
    // GET never returns api_key_value, so a read-modify-write PUT omits it.
    // Keep the stored secret while the header name is unchanged.
    let previous = existing.record.get("data");
    let same_header =
        previous.and_then(|value| value.get("api_key_name")) == data.get("api_key_name");
    if same_header
        && !data.contains_key("api_key_value")
        && let Some(secret) = previous.and_then(|value| value.get("api_key_value"))
    {
        data.insert("api_key_value".into(), secret.clone());
    }
    let envelope = json!({"id":path,"data":data,"status":status,"tags":tags});
    let record = WebhookRecord {
        id: path,
        status,
        tags,
        record: envelope,
    };
    db::service::save_webhook(&mut *tx, &record)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok((StatusCode::CREATED, Json(model::webhook(&record))).into_response())
}

async fn remove(
    State(state): State<MetadataState>,
    Path(raw): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let id = id(&raw)?;
    let pool = state.pool().await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    if db::service::get_webhook_with(&mut *tx, id)
        .await
        .map_err(internal)?
        .is_none()
        || !db::service::delete_webhook(&mut *tx, id)
            .await
            .map_err(internal)?
    {
        return Err(not_found());
    }
    tx.commit().await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
