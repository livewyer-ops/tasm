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
use uuid::Uuid;

use crate::{
    db::{
        self,
        flows::{SourceFilters, SourceSort},
    },
    domain::model,
    http::{MAX_JSON_BODY_BYTES, error::ApiError, path_uuid, query::invalid_query, strict_json},
};

use super::service::{
    MetadataState, enqueue_event, internal, page, paged_response, query, tag_filters,
};

pub fn router() -> Router<MetadataState> {
    Router::new()
        .route("/sources", get(list).head(list))
        .route("/sources/{sourceId}", get(get_source).head(get_source))
        .route(
            "/sources/{sourceId}/label",
            get(get_label)
                .head(get_label)
                .put(put_label)
                .delete(delete_label),
        )
        .route(
            "/sources/{sourceId}/description",
            get(get_description)
                .head(get_description)
                .put(put_description)
                .delete(delete_description),
        )
        .route("/sources/{sourceId}/tags", get(get_tags).head(get_tags))
        .route(
            "/sources/{sourceId}/tags/{*name}",
            get(get_tag).head(get_tag).put(put_tag).delete(delete_tag),
        )
}

fn missing() -> ApiError {
    ApiError::not_found("The requested Source does not exist.")
}
fn id(value: &str) -> Result<Uuid, ApiError> {
    path_uuid(value)
}

async fn list(
    State(state): State<MetadataState>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let query = query(
        &request,
        &[
            "label",
            "format",
            "reverse_order",
            "sort_by",
            "collected_by_ids",
            "page",
            "limit",
        ],
        &["tag.", "tag_exists."],
    )?;
    for (key, value) in query.last_values() {
        match key {
            "reverse_order" => {
                crate::http::query::parse_bool(value)?;
            }
            "limit" => {
                if value.parse::<i64>().map_err(|_| invalid_query())? <= 0 {
                    return Err(invalid_query());
                }
            }
            "page" => {
                if !value.is_empty() && value.parse::<i64>().map_err(|_| invalid_query())? < 0 {
                    return Err(invalid_query());
                }
            }
            "format" if !model::FORMATS.contains(&value) => return Err(invalid_query()),
            "sort_by" if !matches!(value, "created" | "updated" | "label") => {
                return Err(invalid_query());
            }
            _ => {}
        }
    }
    let format = query.last("format").map(str::to_owned);
    if format
        .as_deref()
        .is_some_and(|format| !model::FORMATS.contains(&format))
    {
        return Err(invalid_query());
    }
    let reverse = query.bool("reverse_order")?.unwrap_or(false);
    let sort = match query.last("sort_by").unwrap_or("created") {
        "created" => SourceSort::Created,
        "updated" => SourceSort::Updated,
        "label" => SourceSort::Label,
        _ => return Err(invalid_query()),
    };
    let collected = query.last("collected_by_ids");
    let filters = SourceFilters {
        format,
        label: query.last("label").map(str::to_owned),
        collected_by_ids: query.uuid_list("collected_by_ids")?,
        top_level_only: collected == Some(""),
        tags: tag_filters(&query)?,
    };
    let page_request = page(&query)?;
    let pool = state.pool().await?;
    let result = db::flows::list_sources_page(&pool, &filters, sort, reverse, &page_request)
        .await
        .map_err(internal)?;
    let relationships = db::flows::source_relationships(
        &pool,
        &result.items.iter().map(|item| item.id).collect::<Vec<_>>(),
    )
    .await
    .map_err(internal)?;
    let count = result.items.len();
    paged_response(
        &request,
        Value::Array(
            result
                .items
                .iter()
                .map(|item| model::source(item, relationships.get(&item.id)))
                .collect(),
        ),
        result.limit,
        count,
        result.next_page.as_deref(),
        Some(reverse),
    )
}

async fn get_source(
    State(state): State<MetadataState>,
    Path(raw): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let id = id(&raw)?;
    let pool = state.pool().await?;
    let source = db::flows::get_source(&pool, id)
        .await
        .map_err(internal)?
        .ok_or_else(missing)?;
    let relationships = db::flows::source_relationships(&pool, &[id])
        .await
        .map_err(internal)?;
    Ok(Json(model::source(&source, relationships.get(&id))).into_response())
}

async fn scalar(
    State(state): State<MetadataState>,
    raw: String,
    request: Request<Body>,
    name: &str,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let source = db::flows::get_source(&state.pool().await?, id(&raw)?)
        .await
        .map_err(internal)?
        .ok_or_else(missing)?;
    let value = if name == "label" {
        source.label.as_deref()
    } else {
        source.record.get("description").and_then(Value::as_str)
    }
    .unwrap_or("");
    Ok(Json(json!(value)).into_response())
}
async fn get_label(
    State(state): State<MetadataState>,
    Path(raw): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    scalar(State(state), raw, request, "label").await
}
async fn get_description(
    State(state): State<MetadataState>,
    Path(raw): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    scalar(State(state), raw, request, "description").await
}

async fn mutate_scalar(
    State(state): State<MetadataState>,
    raw: String,
    request: Request<Body>,
    name: &str,
    clear: bool,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let value = if clear {
        None
    } else {
        let value: Value = strict_json(request, MAX_JSON_BODY_BYTES)
            .await
            .map_err(|_| ApiError::bad_request("Bad request."))?;
        Some(
            value
                .as_str()
                .ok_or_else(|| ApiError::bad_request("Bad request."))?
                .to_owned(),
        )
    };
    let source_id = id(&raw)?;
    let pool = state.pool().await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let mut source = db::flows::get_source_for_update(&mut *tx, source_id)
        .await
        .map_err(internal)?
        .ok_or_else(missing)?;
    source.metadata_updated = crate::now();
    if name == "label" {
        source.label = value.clone();
    } else {
        if !source.record.is_object() {
            source.record = json!({});
        }
        match value {
            Some(value) => {
                source
                    .record
                    .as_object_mut()
                    .unwrap()
                    .insert("description".into(), json!(value));
            }
            None => {
                source.record.as_object_mut().unwrap().remove("description");
            }
        }
    }
    if !source.record.is_object() {
        source.record = json!({});
    }
    let record = source.record.as_object_mut().unwrap();
    record.insert("label".into(), json!(source.label));
    record.insert("tags".into(), json!(source.tags));
    record.insert(
        "metadata_updated".into(),
        json!(model::timestamp(source.metadata_updated)),
    );
    db::flows::save_source(&mut *tx, &source)
        .await
        .map_err(internal)?;
    let relationships = db::flows::source_relationships(&mut *tx, &[source_id])
        .await
        .map_err(internal)?;
    let relationship = relationships.get(&source_id);
    enqueue_event(
        &mut tx,
        "sources/updated",
        json!({"source":model::source(&source, relationship)}),
        &[],
        &[source_id],
        &[],
        &relationship
            .map(|r| r.collected_by.clone())
            .unwrap_or_default(),
    )
    .await?;
    tx.commit().await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
async fn put_label(
    State(state): State<MetadataState>,
    Path(raw): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    mutate_scalar(State(state), raw, request, "label", false).await
}
async fn delete_label(
    State(state): State<MetadataState>,
    Path(raw): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    mutate_scalar(State(state), raw, request, "label", true).await
}
async fn put_description(
    State(state): State<MetadataState>,
    Path(raw): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    mutate_scalar(State(state), raw, request, "description", false).await
}
async fn delete_description(
    State(state): State<MetadataState>,
    Path(raw): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    mutate_scalar(State(state), raw, request, "description", true).await
}

async fn get_tags(
    State(state): State<MetadataState>,
    Path(raw): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let source = db::flows::get_source(&state.pool().await?, id(&raw)?)
        .await
        .map_err(internal)?
        .ok_or_else(missing)?;
    Ok(Json(json!(source.tags)).into_response())
}
async fn get_tag(
    State(state): State<MetadataState>,
    Path((raw, name)): Path<(String, String)>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let source = db::flows::get_source(&state.pool().await?, id(&raw)?)
        .await
        .map_err(internal)?
        .ok_or_else(missing)?;
    let value = source
        .tags
        .get(&name)
        .cloned()
        .ok_or_else(|| ApiError::not_found("The requested Source tag does not exist."))?;
    Ok(Json(value).into_response())
}
async fn mutate_tag(
    State(state): State<MetadataState>,
    raw: String,
    name: String,
    request: Request<Body>,
    clear: bool,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let value = if clear {
        None
    } else {
        let value: Value = strict_json(request, MAX_JSON_BODY_BYTES)
            .await
            .map_err(|_| ApiError::bad_request("Bad request."))?;
        if !model::tag_value(&value) {
            return Err(ApiError::bad_request("Bad request."));
        }
        Some(value)
    };
    let source_id = id(&raw)?;
    let pool = state.pool().await?;
    let mut tx = pool.begin().await.map_err(internal)?;
    let mut source = db::flows::get_source_for_update(&mut *tx, source_id)
        .await
        .map_err(internal)?
        .ok_or_else(missing)?;
    match value {
        Some(value) => {
            source.tags.insert(name, value);
        }
        None => {
            source.tags.remove(&name);
        }
    }
    source.metadata_updated = crate::now();
    if !source.record.is_object() {
        source.record = json!({});
    }
    source
        .record
        .as_object_mut()
        .unwrap()
        .insert("tags".into(), json!(source.tags));
    source.record.as_object_mut().unwrap().insert(
        "metadata_updated".into(),
        json!(model::timestamp(source.metadata_updated)),
    );
    db::flows::save_source(&mut *tx, &source)
        .await
        .map_err(internal)?;
    let relationships = db::flows::source_relationships(&mut *tx, &[source_id])
        .await
        .map_err(internal)?;
    let relationship = relationships.get(&source_id);
    enqueue_event(
        &mut tx,
        "sources/updated",
        json!({"source":model::source(&source, relationship)}),
        &[],
        &[source_id],
        &[],
        &relationship
            .map(|r| r.collected_by.clone())
            .unwrap_or_default(),
    )
    .await?;
    tx.commit().await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
async fn put_tag(
    State(state): State<MetadataState>,
    Path((raw, name)): Path<(String, String)>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    mutate_tag(State(state), raw, name, request, false).await
}
async fn delete_tag(
    State(state): State<MetadataState>,
    Path((raw, name)): Path<(String, String)>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    mutate_tag(State(state), raw, name, request, true).await
}
