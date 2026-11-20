// Cloudflare adaptation of TASM and rust-tams-api (Apache-2.0); see NOTICE.
use std::collections::BTreeSet;

use axum::{
    Extension, Json, Router,
    body::{Body, to_bytes},
    extract::State,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::{
    db::{self, MediaObjectRecord},
    http::routes::service::{MetadataState, internal},
    http::{MAX_JSON_BODY_BYTES, error::ApiError},
    storage::StorageFactory,
};

pub fn router() -> Router<MetadataState> {
    Router::new().route("/flows/{flowId}/storage", post(allocate))
}

fn invalid() -> ApiError {
    ApiError::bad_request("Bad request. Invalid storage request.")
}
fn valid_id(value: &str, max: u64) -> bool {
    !value.is_empty()
        && value.chars().count() as u64 <= max
        && !value.starts_with('/')
        && !value.chars().any(|c| c < ' ')
        && value
            .split('/')
            .all(|part| !matches!(part, "" | "." | ".."))
}
fn valid_mime_type(value: &str) -> bool {
    let Some((kind, subtype)) = value.split_once('/') else {
        return false;
    };
    let token = |value: &str| {
        !value.is_empty()
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&byte))
    };
    let kind = matches!(
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
    ) || kind.strip_prefix("x-").is_some_and(token);
    kind && token(subtype)
}

async fn allocate(
    State(state): State<MetadataState>,
    Extension(factory): Extension<StorageFactory>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let flow_id: Uuid = request
        .uri()
        .path()
        .split('/')
        .nth(2)
        .map_or_else(|| crate::http::path_uuid(""), crate::http::path_uuid)?;
    let content_type_header = request
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .cloned();
    let bytes = to_bytes(request.into_body(), MAX_JSON_BODY_BYTES)
        .await
        .map_err(|_| ApiError::bad_request("Invalid request: Request body is too large"))?;
    let body: Map<String, Value> = if bytes.is_empty() {
        Map::new()
    } else {
        let content_type = content_type_header
            .as_ref()
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let media_type = content_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if media_type != "application/json"
            && !(media_type.starts_with("application/") && media_type.ends_with("+json"))
        {
            return Err(ApiError::bad_request(
                "Invalid request: Content-Type must be application/json",
            ));
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        value.as_object().cloned().ok_or_else(invalid)?
    };
    if body.contains_key("content-type") {
        return Err(ApiError::bad_request(
            "Bad request. Use content_type instead of the unsupported content-type field.",
        ));
    }
    let pool = state.pool().await?;
    let mut transaction = pool.begin().await.map_err(internal)?;
    db::flows::lock_flow_segments(&mut *transaction, flow_id)
        .await
        .map_err(internal)?;
    let flow = db::flows::get_flow_with(&mut *transaction, flow_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| ApiError::not_found("The requested Flow does not exist."))?;
    if flow.read_only {
        return Err(ApiError::forbidden(
            "Forbidden. You do not have permission to modify this Flow. It may be marked read-only.",
        ));
    }
    let container = flow
        .container
        .as_deref()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::bad_request("Bad request. The Flow 'container' is not set."))?;
    let requested_content_type = body
        .get("content_type")
        .map(|v| v.as_str().ok_or_else(invalid))
        .transpose()?;
    if requested_content_type.is_some_and(|value| !valid_mime_type(value)) {
        return Err(invalid());
    }
    if requested_content_type.is_some_and(|v| !flow.init_segments || v == container) {
        return Err(ApiError::bad_request(
            "Bad request. content_type is only valid for init Objects whose type differs from the Flow container.",
        ));
    }
    let content_type = requested_content_type
        .filter(|value| !value.is_empty())
        .unwrap_or(container)
        .to_owned();
    let presigned = body
        .get("presigned")
        .map(|v| v.as_bool().ok_or_else(invalid))
        .transpose()?
        .unwrap_or(crate::storage::SIGNED_URLS);
    if presigned && !crate::storage::SIGNED_URLS {
        return Err(ApiError::bad_request(
            "This storage backend provides unsigned URLs.",
        ));
    }
    let limit = body
        .get("limit")
        .map(|v| v.as_i64().ok_or_else(invalid))
        .transpose()?;
    let supplied = body
        .get("object_ids")
        .map(|v| v.as_array().ok_or_else(invalid))
        .transpose()?;
    if limit.is_some() && supplied.is_some() {
        return Err(ApiError::bad_request(
            "Specify either limit or object_ids, not both.",
        ));
    }
    // Zero keeps the service default of one object, as list paging does.
    let requested = match limit {
        None | Some(0) => 1,
        Some(value) if value < 0 => {
            return Err(ApiError::bad_request(
                "Bad request. Storage allocation limit must not be negative.",
            ));
        }
        Some(value) => value,
    };
    if requested as u64 > state.settings.storage_allocation_max_objects {
        return Err(ApiError::bad_request(
            "Bad request. Storage allocation limit is too high.",
        ));
    }
    let target = requested as usize;
    let mut ids = supplied
        .map(|values| {
            values
                .iter()
                .map(|v| v.as_str().map(str::to_owned).ok_or_else(invalid))
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    if ids.len() as u64 > state.settings.storage_allocation_max_objects {
        return Err(ApiError::bad_request(
            "Bad request. Storage allocation limit is too high.",
        ));
    }
    let unique: BTreeSet<_> = ids.iter().collect();
    if unique.len() != ids.len() {
        return Err(ApiError::bad_request(
            "One or more supplied object_ids are duplicated.",
        ));
    }
    if ids
        .iter()
        .any(|id| !valid_id(id, state.settings.storage_object_id_max_length))
    {
        return Err(ApiError::bad_request("Bad request. Invalid object_id."));
    }
    let backend = match body.get("storage_id") {
        Some(value) => {
            factory
                .backend(
                    value
                        .as_str()
                        .ok_or_else(invalid)?
                        .parse()
                        .map_err(|_| invalid())?,
                )
                .await
        }
        None => factory.default_backend().await,
    }
    .map_err(internal)?
    .ok_or_else(|| ApiError::bad_request("The requested Storage Backend does not exist."))?;
    let now = crate::now();
    if supplied.is_none() {
        while ids.len() < target {
            let candidates = (ids.len()..target)
                .map(|_| Uuid::new_v4().to_string())
                .collect::<Vec<_>>();
            db::objects::lock_sorted(&mut transaction, candidates.clone())
                .await
                .map_err(internal)?;
            for id in candidates {
                let referenced = Vec::<String>::new();
                let record = json!({"id":id,"timerange":null,"init_object_id":null,"first_referenced_by_flow":null,"allocated_by_flow":flow_id,"referenced_by_flows":referenced,"instances":[{"storage_backend_id":backend.id,"url":null,"label":backend.label,"controlled":true,"presigned":false}],"key_frame_count":null,"bytes_written":0,"object_kind":"unassigned","content_type":content_type,"created":crate::domain::model::timestamp(now)});
                if db::objects::create(
                    &mut *transaction,
                    &MediaObjectRecord {
                        id: id.clone(),
                        first_referenced_by_flow: None,
                        referenced_by_flows: Vec::new(),
                        object_kind: "unassigned".into(),
                        content_type: Some(content_type.clone()),
                        record,
                        created_at: now,
                        updated_at: now,
                    },
                )
                .await
                .map_err(internal)?
                {
                    ids.push(id);
                }
            }
        }
    } else {
        db::objects::lock_sorted(&mut transaction, ids.clone())
            .await
            .map_err(internal)?;
        for id in &ids {
            let referenced = Vec::<String>::new();
            let record = json!({"id":id,"timerange":null,"init_object_id":null,"first_referenced_by_flow":null,"allocated_by_flow":flow_id,"referenced_by_flows":referenced,"instances":[{"storage_backend_id":backend.id,"url":null,"label":backend.label,"controlled":true,"presigned":false}],"key_frame_count":null,"bytes_written":0,"object_kind":"unassigned","content_type":content_type,"created":crate::domain::model::timestamp(now)});
            let created = db::objects::create(
                &mut *transaction,
                &MediaObjectRecord {
                    id: id.clone(),
                    first_referenced_by_flow: None,
                    referenced_by_flows: Vec::new(),
                    object_kind: "unassigned".into(),
                    content_type: Some(content_type.clone()),
                    record,
                    created_at: now,
                    updated_at: now,
                },
            )
            .await
            .map_err(internal)?;
            if !created {
                return Err(ApiError::bad_request(
                    "One or more supplied object_ids already exist.",
                ));
            }
        }
    }
    let mut allocations = Vec::with_capacity(ids.len());
    for object_id in ids.drain(..) {
        let url = factory
            .object_url(&backend, &object_id, "PUT", presigned, Some(&content_type))
            .await
            .map_err(internal)?;
        let mut headers = json!({"Content-Type":content_type});
        if crate::storage::SIGNED_URLS {
            headers["If-None-Match"] = json!("*");
        }
        allocations.push(json!({"object_id":object_id,"storage_id":backend.id,"put_url":{"url":url,"content-type":content_type,"headers":headers},"presigned":presigned}));
    }
    transaction.commit().await.map_err(internal)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"media_objects":allocations})),
    )
        .into_response())
}
