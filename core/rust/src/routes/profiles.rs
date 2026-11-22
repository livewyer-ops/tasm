// Cloudflare adaptation of TASM and rust-tams-api (Apache-2.0); see NOTICE.
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    Actor,
    db::{self, ProfileRecord},
    domain::{flow, model},
    http::{MAX_JSON_BODY_BYTES, error::ApiError, query::invalid_query, strict_json},
};

use super::service::{MetadataState, internal, page, paged_response, query};

pub fn router() -> Router<MetadataState> {
    Router::new()
        .route("/service/profiles", get(list).head(list))
        .route(
            "/service/profiles/{profileId}",
            get(get_profile).head(get_profile).post(create),
        )
}

fn profile_id(value: &str) -> Result<Uuid, ApiError> {
    model::parse_uuid(value).map_err(|_| missing())
}
fn missing() -> ApiError {
    ApiError::not_found("The requested Profile does not exist.")
}
fn mime_type(value: &str) -> bool {
    let Some((kind, subtype)) = value.split_once('/') else {
        return false;
    };
    let token = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&byte))
    };
    matches!(
        kind,
        "application"
            | "audio"
            | "font"
            | "example"
            | "image"
            | "message"
            | "model"
            | "multipart"
            | "text"
            | "video"
    ) && token(subtype)
        || kind.starts_with("x-") && token(&kind[2..]) && token(subtype)
}

async fn list(
    State(state): State<MetadataState>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let query = query(
        &request,
        &["format", "codec", "label", "page", "limit"],
        &[],
    )?;
    let format = query.last("format");
    let codec = query.last("codec");
    if format.is_some_and(|value| !model::FORMATS[..4].contains(&value))
        || codec.is_some_and(|value| !mime_type(value))
    {
        return Err(invalid_query());
    }
    let page_request = page(&query)?;
    let result = db::profiles::list(
        &state.pool,
        format,
        codec,
        query.last("label"),
        &page_request,
    )
    .await
    .map_err(internal)?;
    let count = result.items.len();
    paged_response(
        &request,
        Value::Array(result.items.iter().map(model::profile).collect()),
        result.limit,
        count,
        result.next_page.as_deref(),
        None,
    )
}

async fn get_profile(
    State(state): State<MetadataState>,
    Path(id): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let record = db::profiles::get(&state.pool, profile_id(&id)?)
        .await
        .map_err(internal)?
        .ok_or_else(missing)?;
    Ok(Json(model::profile(&record)).into_response())
}

async fn create(
    State(state): State<MetadataState>,
    Path(path): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let path = profile_id(&path)?;
    let identity = request
        .extensions()
        .get::<Actor>()
        .cloned()
        .expect("auth identity");
    let value: Value = strict_json(request, MAX_JSON_BODY_BYTES)
        .await
        .map_err(|_| ApiError::bad_request("Bad request. Invalid Profile JSON."))?;
    let map = value
        .as_object()
        .ok_or_else(|| ApiError::bad_request("Bad request. Invalid Profile JSON."))?;
    let body_id = model::uuid_field(map, "id")
        .map_err(|_| ApiError::bad_request("Bad request. Invalid Profile JSON."))?;
    if body_id != path {
        return Err(ApiError::not_found(
            "The requested Profile ID in the path is invalid.",
        ));
    }
    let metadata = map
        .get("flow_metadata")
        .ok_or_else(|| ApiError::bad_request("Bad request. Invalid Profile JSON."))?;
    flow::validate_profile_metadata(metadata)
        .map_err(|_| ApiError::bad_request("Bad request. Invalid Profile JSON."))?;
    let metadata_map = metadata.as_object().unwrap();
    let format = metadata_map
        .get("format")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("Bad request. Invalid Profile JSON."))?;
    if !model::FORMATS[..4].contains(&format) {
        return Err(ApiError::bad_request("Bad request. Invalid Profile JSON."));
    }
    let optional_string = |name: &str| -> Result<Option<String>, ApiError> {
        match map.get(name) {
            None => Ok(None),
            Some(Value::String(value)) => Ok(Some(value.clone())),
            Some(_) => Err(ApiError::bad_request("Bad request. Invalid Profile JSON.")),
        }
    };
    if let Some(created) = map.get("created") {
        let created = created
            .as_str()
            .ok_or_else(|| ApiError::bad_request("Bad request. Invalid Profile JSON."))?;
        OffsetDateTime::parse(created, &Rfc3339)
            .map_err(|_| ApiError::bad_request("Bad request. Invalid Profile JSON."))?;
    }
    let label = optional_string("label")?;
    let description = optional_string("description")?;
    let created_by = optional_string("created_by")?
        .filter(|value| !value.is_empty())
        .unwrap_or(identity.subject);
    let tags = model::tags(map.get("tags"))
        .map_err(|_| ApiError::bad_request("Bad request. Invalid Profile JSON."))?;
    let created = crate::now();
    let record_value = json!({"id":path,"flow_metadata":metadata,"label":label,"description":description,"created_by":created_by,"created":model::timestamp(created),"tags":tags});
    let record = ProfileRecord {
        id: path,
        format: format.into(),
        codec: metadata_map
            .get("codec")
            .and_then(Value::as_str)
            .map(str::to_owned),
        label,
        tags,
        record: record_value,
        created,
    };
    let pool = state.pool;
    let mut tx = pool.begin().await.map_err(internal)?;
    db::profiles::lock(&mut *tx, path).await.map_err(internal)?;
    if db::profiles::get_with(&mut *tx, path)
        .await
        .map_err(internal)?
        .is_some()
        || !db::profiles::create(&mut *tx, &record)
            .await
            .map_err(internal)?
    {
        return Err(ApiError::bad_request(
            "Bad request. Profile already exists.",
        ));
    }
    tx.commit().await.map_err(internal)?;
    Ok((StatusCode::CREATED, Json(model::profile(&record))).into_response())
}
