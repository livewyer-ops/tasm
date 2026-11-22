// Cloudflare adaptation of TASM and rust-tams-api (Apache-2.0); see NOTICE.
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::Request,
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
use time::Duration;
use uuid::Uuid;

use crate::{
    db::{self, DeleteRequest, queues::DeleteRequestSort},
    domain::model,
    http::routes::service::{MetadataState, internal, paged_response, query},
    http::{error::ApiError, query::invalid_query},
};

pub fn router() -> Router<MetadataState> {
    Router::new()
        .route("/flow-delete-requests", get(list).head(list))
        .route(
            "/flow-delete-requests/{request_id}",
            get(detail).head(detail),
        )
}

fn response(record: &DeleteRequest, retention: u64) -> Value {
    let get = |name: &str| record.record.get(name).cloned().unwrap_or(Value::Null);
    let expiry = (record.status == "done" && retention > 0)
        .then(|| {
            i64::try_from(retention)
                .ok()
                .and_then(|seconds| record.updated.checked_add(Duration::seconds(seconds)))
                .map(model::timestamp)
        })
        .flatten();
    let mut value = json!({
        "id":record.id,
        "flow_id":record.flow_id,
        "timerange_to_delete":get("timerange_to_delete"),
        "timerange_remaining":get("timerange_remaining"),
        "delete_flow":get("delete_flow"),
        "created":get("created"),
        "created_by":get("created_by"),
        "updated":model::timestamp(record.updated),
        "expiry":expiry,
        "status":record.status,
        "error":get("error"),
    });
    value
        .as_object_mut()
        .expect("delete request response")
        .retain(|_, value| !value.is_null());
    value
}

async fn list(
    State(state): State<MetadataState>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let params = query(
        &request,
        &["reverse_order", "sort_by", "page", "limit"],
        &[],
    )?;
    let reverse = params.bool("reverse_order")?.unwrap_or(false);
    let sort = match params.last("sort_by").unwrap_or("created") {
        "created" => DeleteRequestSort::Created,
        "expiry" => DeleteRequestSort::Expiry,
        _ => return Err(invalid_query()),
    };
    let page = super::service::page(&params)?;
    let result = db::queues::list_delete_requests(
        &state.pool().await?,
        sort,
        reverse,
        i64::try_from(state.settings.worker_queue_retention_seconds).unwrap_or(i64::MAX),
        &page,
    )
    .await
    .map_err(internal)?;
    paged_response(
        &request,
        Value::Array(
            result
                .items
                .iter()
                .map(|value| response(value, state.settings.worker_queue_retention_seconds))
                .collect(),
        ),
        result.limit,
        result.items.len(),
        result.next_page.as_deref(),
        Some(reverse),
    )
}

async fn detail(
    State(state): State<MetadataState>,
    Path(id): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let id: Uuid = id
        .parse()
        .map_err(|_| ApiError::not_found("The requested flow delete request does not exist."))?;
    let value = db::queues::get_delete_request(&state.pool().await?, id)
        .await
        .map_err(internal)?
        .ok_or_else(|| ApiError::not_found("The requested flow delete request does not exist."))?;
    Ok(Json(response(
        &value,
        state.settings.worker_queue_retention_seconds,
    ))
    .into_response())
}
