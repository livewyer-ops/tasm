// Cloudflare adaptation of TASM and rust-tams-api (Apache-2.0); see NOTICE.
use std::collections::BTreeMap;

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::{Request, StatusCode, header::LOCATION},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::{
    Actor,
    db::{
        self, DeleteRequest, FlowRecord, SourceRecord,
        flows::{FlowFilters, FlowSort},
    },
    domain::{flow as rules, model, timerange},
    http::{MAX_JSON_BODY_BYTES, error::ApiError, path_uuid, query::invalid_query, strict_json},
};

use super::service::{
    MetadataState, emit_flow_updated, enqueue_event, internal, page, paged_response, query,
    tag_filters,
};

pub fn router() -> Router<MetadataState> {
    Router::new()
        .route("/flows", get(list).head(list))
        .route(
            "/flows/{flowId}",
            get(get_flow)
                .head(get_flow)
                .put(put_flow)
                .delete(delete_flow),
        )
        .route(
            "/flows/{flowId}/flow_collection",
            get(get_collection)
                .head(get_collection)
                .put(put_collection)
                .delete(delete_collection),
        )
        .route(
            "/flows/{flowId}/label",
            get(get_label)
                .head(get_label)
                .put(put_label)
                .delete(delete_label),
        )
        .route(
            "/flows/{flowId}/description",
            get(get_description)
                .head(get_description)
                .put(put_description)
                .delete(delete_description),
        )
        .route(
            "/flows/{flowId}/avg_bit_rate",
            get(get_avg_bit_rate)
                .head(get_avg_bit_rate)
                .put(put_avg_bit_rate)
                .delete(delete_avg_bit_rate),
        )
        .route(
            "/flows/{flowId}/max_bit_rate",
            get(get_max_bit_rate)
                .head(get_max_bit_rate)
                .put(put_max_bit_rate)
                .delete(delete_max_bit_rate),
        )
        .route(
            "/flows/{flowId}/read_only",
            get(get_read_only).head(get_read_only).put(put_read_only),
        )
        .route("/flows/{flowId}/tags", get(get_tags).head(get_tags))
        .route(
            "/flows/{flowId}/tags/{*name}",
            get(get_tag).head(get_tag).put(put_tag).delete(delete_tag),
        )
}

fn missing() -> ApiError {
    ApiError::not_found("The requested Flow does not exist.")
}
fn readonly() -> ApiError {
    ApiError::forbidden(
        "Forbidden. You do not have permission to modify this Flow. It may be marked read-only.",
    )
}
fn invalid_flow() -> ApiError {
    ApiError::bad_request("Bad request. Invalid Flow JSON.")
}
fn id(value: &str) -> Result<Uuid, ApiError> {
    path_uuid(value)
}

fn collected_by(records: &[FlowRecord], parents: &[FlowRecord]) -> BTreeMap<Uuid, Vec<Uuid>> {
    let ids: Vec<_> = records.iter().map(|record| record.id).collect();
    let mut result = ids
        .iter()
        .copied()
        .map(|id| (id, Vec::new()))
        .collect::<BTreeMap<_, _>>();
    for parent in parents {
        for child in &parent.flow_collection_ids {
            if let Some(values) = result.get_mut(child) {
                values.push(parent.id);
            }
        }
    }
    result
}

fn frame_dimension(value: &str) -> Result<i32, ApiError> {
    value
        .parse::<i32>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(invalid_query)
}

async fn list(
    State(state): State<MetadataState>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let q = query(
        &request,
        &[
            "source_id",
            "timerange",
            "include_timerange",
            "format",
            "codec",
            "profile_id",
            "label",
            "reverse_order",
            "sort_by",
            "status",
            "frame_width",
            "frame_height",
            "init_segments",
            "collected_by_ids",
            "page",
            "limit",
        ],
        &["tag.", "tag_exists."],
    )?;
    let format = q.last("format").map(str::to_owned);
    if format
        .as_deref()
        .is_some_and(|value| !model::FORMATS.contains(&value))
    {
        return Err(invalid_query());
    }
    let status = q.last("status").map(str::to_owned);
    if status
        .as_deref()
        .is_some_and(|value| !model::FLOW_STATUSES.contains(&value))
    {
        return Err(invalid_query());
    }
    let range = q
        .last("timerange")
        .map(timerange::parse)
        .transpose()
        .map_err(|_| invalid_query())?
        .unwrap_or_default();
    let codec = q.last("codec");
    if let Some(value) = codec {
        let (kind, subtype) = value.split_once('/').ok_or_else(invalid_query)?;
        if kind.is_empty()
            || subtype.is_empty()
            || subtype.contains('/')
            || value.chars().any(char::is_whitespace)
        {
            return Err(invalid_query());
        }
    }
    let collected = q.last("collected_by_ids");
    let filters = FlowFilters {
        source_id: q.uuid("source_id")?,
        format,
        profile_id: q.uuid("profile_id")?,
        status,
        init_segments: q.bool("init_segments")?,
        codec: codec.map(str::to_owned),
        frame_width: q.last("frame_width").map(frame_dimension).transpose()?,
        frame_height: q.last("frame_height").map(frame_dimension).transpose()?,
        label: q.last("label").map(str::to_owned),
        collected_by_ids: q.uuid_list("collected_by_ids")?,
        top_level_only: collected == Some(""),
        timerange_start: range.start,
        timerange_end: range.end,
        timerange_is_empty: range.empty,
        timerange_is_point: range.point,
        tags: tag_filters(&q)?,
    };
    let reverse = q.bool("reverse_order")?.unwrap_or(false);
    let sort = match q.last("sort_by").unwrap_or("created") {
        "created" => FlowSort::Created,
        "metadata_updated" => FlowSort::Updated,
        "label" => FlowSort::Label,
        _ => return Err(invalid_query()),
    };
    let include = q.bool("include_timerange")?.unwrap_or(false);
    let page_request = page(&q)?;
    let pool = state.pool;
    let result = db::flows::list_flows_page(&pool, &filters, sort, reverse, &page_request)
        .await
        .map_err(internal)?;
    let ids: Vec<_> = result.items.iter().map(|value| value.id).collect();
    let parents = db::flows::list_flows_collecting(&pool, &ids)
        .await
        .map_err(internal)?;
    let collected = collected_by(&result.items, &parents);
    let ranges = if include {
        db::flows::flow_timeranges(&pool, &ids, range)
            .await
            .map_err(internal)?
    } else {
        BTreeMap::new()
    };
    let body = Value::Array(
        result
            .items
            .iter()
            .map(|value| {
                let range = include.then(|| {
                    ranges.get(&value.id).copied().flatten().map_or_else(
                        || "()".into(),
                        |(start, end)| timerange::from_bounds(Some(start), Some(end)),
                    )
                });
                model::flow(
                    value,
                    collected.get(&value.id).map(Vec::as_slice).unwrap_or(&[]),
                    range.as_deref(),
                )
            })
            .collect(),
    );
    let count = result.items.len();
    paged_response(
        &request,
        body,
        result.limit,
        count,
        result.next_page.as_deref(),
        Some(reverse),
    )
}

async fn get_flow(
    State(state): State<MetadataState>,
    Path(raw): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let q = query(&request, &["include_timerange", "timerange"], &[])?;
    let include = q.bool("include_timerange")?.unwrap_or(false);
    let range_filter = q
        .last("timerange")
        .map(timerange::parse)
        .transpose()
        .map_err(|_| invalid_query())?
        .unwrap_or_default();
    let id = id(&raw)?;
    let pool = state.pool;
    let flow = db::flows::get_flow(&pool, id)
        .await
        .map_err(internal)?
        .ok_or_else(missing)?;
    let parents = db::flows::list_flows_collecting(&pool, &[id])
        .await
        .map_err(internal)?;
    let collected = collected_by(std::slice::from_ref(&flow), &parents);
    let range = if include {
        Some(
            db::flows::flow_timeranges(&pool, &[id], range_filter)
                .await
                .map_err(internal)?
                .get(&id)
                .copied()
                .flatten()
                .map_or_else(
                    || "()".into(),
                    |(start, end)| timerange::from_bounds(Some(start), Some(end)),
                ),
        )
    } else {
        None
    };
    Ok(Json(model::flow(
        &flow,
        collected.get(&id).map(Vec::as_slice).unwrap_or(&[]),
        range.as_deref(),
    ))
    .into_response())
}

fn data(record: &FlowRecord) -> Map<String, Value> {
    record
        .record
        .get("data")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}
fn sync_record(record: &mut FlowRecord, mut payload: Map<String, Value>, identity: &Actor) {
    let previous_version = data(record)
        .get("metadata_version")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let requested_version = payload.get("metadata_version").and_then(Value::as_str);
    if requested_version.is_none() || requested_version == previous_version.as_deref() {
        payload.insert("metadata_version".into(), json!(Uuid::new_v4()));
    }
    payload.insert("id".into(), json!(record.id));
    payload.insert("source_id".into(), json!(record.source_id));
    payload.insert("format".into(), json!(record.format));
    payload.insert("profile_id".into(), json!(record.profile_id));
    payload.insert("status".into(), json!(record.status));
    payload.insert("read_only".into(), json!(record.read_only));
    payload.insert("tags".into(), json!(record.tags));
    payload.insert("updated_by".into(), json!(identity.subject));
    record.label = payload
        .get("label")
        .and_then(Value::as_str)
        .map(str::to_owned);
    record.container = payload
        .get("container")
        .and_then(Value::as_str)
        .map(str::to_owned);
    record.status = payload
        .get("status")
        .and_then(Value::as_str)
        .map(str::to_owned);
    record.record = json!({"id":record.id,"data":payload,"source_id":record.source_id,"format":record.format,"container":record.container,"profile_id":record.profile_id,"status":record.status,"init_segments":record.init_segments,"read_only":record.read_only,"tags":record.tags,"created":model::timestamp(record.created),"metadata_updated":model::timestamp(record.metadata_updated),"segments_updated":record.segments_updated.map(model::timestamp)});
}

async fn put_flow(
    State(state): State<MetadataState>,
    Path(raw): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let flow_id = id(&raw)?;
    let identity = request
        .extensions()
        .get::<Actor>()
        .cloned()
        .expect("auth identity");
    let pool = state.pool;
    let mut tx = pool.begin().await.map_err(internal)?;
    db::flows::lock_flow_segments(&mut *tx, flow_id)
        .await
        .map_err(internal)?;
    let existing = db::flows::get_flow_with(&mut *tx, flow_id)
        .await
        .map_err(internal)?;
    if existing.as_ref().is_some_and(|value| value.read_only) {
        return Err(readonly());
    }
    let value: Value = strict_json(request, MAX_JSON_BODY_BYTES)
        .await
        .map_err(|_| invalid_flow())?;
    let map = value.as_object().cloned().ok_or_else(invalid_flow)?;
    if !identity.has("tams-api/admin")
        && map
            .get("read_only")
            .and_then(Value::as_bool)
            .is_some_and(|value| value != existing.as_ref().is_some_and(|flow| flow.read_only))
    {
        return Err(ApiError::forbidden(
            "Changing read_only requires administrator scope.",
        ));
    }
    let body_id = model::uuid_field(&map, "id").map_err(|_| invalid_flow())?;
    if body_id != flow_id {
        return Err(ApiError::not_found(
            "The requested Flow ID in the path is invalid.",
        ));
    }
    rules::validate_put(&map, flow_id).map_err(|_| invalid_flow())?;
    let created = existing.is_none();
    let now = crate::now();
    let mut payload = map.clone();
    rules::clean_client_fields(&mut payload);
    let mut profile_id = existing.as_ref().and_then(|value| value.profile_id);
    let requested_profile = map.get("profile_id");
    if let Some(Value::String(value)) = requested_profile {
        if value.is_empty() {
            if created || profile_id.is_none() {
                return Err(invalid_flow());
            }
            profile_id = None;
            rules::validate_direct(&payload).map_err(|_| invalid_flow())?;
        } else {
            let requested = model::parse_uuid(value).map_err(|_| invalid_flow())?;
            if existing
                .as_ref()
                .is_some_and(|old| old.profile_id.is_none() || old.profile_id != Some(requested))
            {
                return Err(invalid_flow());
            }
            db::profiles::lock(&mut *tx, requested)
                .await
                .map_err(internal)?;
            let profile = db::profiles::get_with(&mut *tx, requested)
                .await
                .map_err(internal)?
                .ok_or_else(invalid_flow)?;
            let metadata = profile
                .record
                .get("flow_metadata")
                .and_then(Value::as_object)
                .ok_or_else(invalid_flow)?;
            rules::validate_direct(metadata).map_err(|_| invalid_flow())?;
            for (key, value) in metadata {
                payload.insert(key.clone(), value.clone());
            }
            profile_id = Some(requested);
        }
    } else if profile_id.is_none() {
        rules::validate_direct(&payload).map_err(|_| invalid_flow())?;
    }
    if profile_id.is_some() {
        if rules::profile_has_technical_fields(&map) {
            return Err(ApiError::bad_request(
                "The Profile supplies the Flow's technical metadata. To change it, set profile_id to an empty string and supply the technical metadata.",
            ));
        }
        if requested_profile.is_none() {
            return Err(invalid_flow());
        }
    }
    let source_id = model::uuid_field(&map, "source_id").map_err(|_| invalid_flow())?;
    let format = payload
        .get("format")
        .and_then(Value::as_str)
        .ok_or_else(invalid_flow)?
        .to_owned();
    let mut source_created = false;
    let source_metadata_updated = now
        .replace_nanosecond(now.nanosecond() / 1_000 * 1_000)
        .expect("whole microseconds are valid nanoseconds");
    let mut source = match db::flows::get_source_for_update(&mut *tx, source_id)
        .await
        .map_err(internal)?
    {
        Some(source) if source.format.as_deref() != Some(format.as_str()) => {
            return Err(invalid_flow());
        }
        Some(source) => source,
        None => {
            source_created = true;
            let tags = model::tags(map.get("tags")).map_err(|_| invalid_flow())?;
            SourceRecord {
                id: source_id,
                format: Some(format.clone()),
                label: map.get("label").and_then(Value::as_str).map(str::to_owned),
                tags: tags.clone(),
                record: json!({"id":source_id,"format":format,"label":map.get("label"),"description":map.get("description"),"tags":tags,"created_by":identity.subject,"created":model::timestamp(now)}),
                metadata_updated: source_metadata_updated,
                created: now,
            }
        }
    };
    source.metadata_updated = source_metadata_updated;
    if !source.record.is_object() {
        source.record = json!({});
    }
    source.record["updated_by"] = json!(identity.subject);
    source.record.as_object_mut().unwrap().insert(
        "metadata_updated".into(),
        json!(model::timestamp(source.metadata_updated)),
    );
    db::flows::save_source(&mut *tx, &source)
        .await
        .map_err(internal)?;
    let collection_ids = if let Some(collection) = map.get("flow_collection") {
        let ids = rules::validate_collection(collection, flow_id).map_err(|_| invalid_flow())?;
        for id in &ids {
            if db::flows::get_flow_with(&mut *tx, *id)
                .await
                .map_err(internal)?
                .is_none()
            {
                return Err(invalid_flow());
            }
        }
        ids
    } else {
        Vec::new()
    };
    let init = payload
        .get("essence_parameters")
        .and_then(Value::as_object)
        .and_then(|value| value.get("init_segments"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if existing
        .as_ref()
        .is_some_and(|value| value.init_segments != init)
        && db::flows::has_segments(&mut *tx, flow_id)
            .await
            .map_err(internal)?
    {
        return Err(invalid_flow());
    }
    let tags = model::tags(map.get("tags")).map_err(|_| invalid_flow())?;
    // created_by is server-owned: set it on creation and keep it on replacement.
    match existing
        .as_ref()
        .and_then(|flow| data(flow).get("created_by").cloned())
    {
        Some(creator) => {
            payload.insert("created_by".into(), creator);
        }
        None if created => {
            payload.insert("created_by".into(), json!(identity.subject));
        }
        None => {}
    }
    let previous_source = existing
        .as_ref()
        .and_then(|flow| flow.source_id)
        .filter(|id| *id != source_id);
    let mut record = existing.unwrap_or(FlowRecord {
        id: flow_id,
        source_id: Some(source_id),
        format: Some(format.clone()),
        container: None,
        profile_id,
        status: None,
        init_segments: init,
        label: None,
        flow_collection_ids: Vec::new(),
        read_only: false,
        tags: tags.clone(),
        record: json!({}),
        metadata_updated: now,
        created: now,
        segments_updated: None,
    });
    record.source_id = Some(source_id);
    record.format = Some(format);
    record.profile_id = profile_id;
    record.status = payload
        .get("status")
        .and_then(Value::as_str)
        .map(str::to_owned);
    record.init_segments = init;
    record.flow_collection_ids = collection_ids;
    record.tags = tags;
    record.read_only = payload
        .get("read_only")
        .and_then(Value::as_bool)
        .unwrap_or(record.read_only);
    record.metadata_updated = now;
    sync_record(&mut record, payload, &identity);
    db::flows::save_flow(&mut *tx, &record)
        .await
        .map_err(internal)?;
    let relationships = db::flows::source_relationships(&mut *tx, &[source_id])
        .await
        .map_err(internal)?;
    let relationship = relationships.get(&source_id);
    if relationship.is_some_and(|r| r.conflicting_collection) {
        return Err(collection_conflict());
    }
    let source_collected_by = relationship
        .map(|value| value.collected_by.clone())
        .unwrap_or_default();
    if source_created {
        enqueue_event(
            &mut tx,
            "sources/created",
            json!({"source":model::source(&source,relationship)}),
            &[],
            &[source_id],
            &[],
            &source_collected_by,
        )
        .await?;
    }
    let parents = db::flows::list_flows_collecting(&mut *tx, &[flow_id])
        .await
        .map_err(internal)?;
    if previous_source.is_some() && !parents.is_empty() {
        let sources: Vec<_> = parents.iter().filter_map(|p| p.source_id).collect();
        if db::flows::source_relationships(&mut *tx, &sources)
            .await
            .map_err(internal)?
            .values()
            .any(|r| r.conflicting_collection)
        {
            return Err(collection_conflict());
        }
    }
    let parent_ids: Vec<_> = parents.iter().map(|value| value.id).collect();
    enqueue_event(
        &mut tx,
        if created {
            "flows/created"
        } else {
            "flows/updated"
        },
        json!({"flow":model::flow(&record,&parent_ids,None)}),
        &[flow_id],
        &[source_id],
        &parent_ids,
        &source_collected_by,
    )
    .await?;
    // Moving the flow to another source can leave the old one without flows;
    // remove it as DELETE /flows/{id} would.
    if let Some(old) = previous_source {
        let old_collected_by = db::flows::source_relationships(&mut *tx, &[old])
            .await
            .map_err(internal)?
            .get(&old)
            .map(|value| value.collected_by.clone())
            .unwrap_or_default();
        if db::flows::delete_source(&mut *tx, old)
            .await
            .map_err(internal)?
        {
            enqueue_event(
                &mut tx,
                "sources/deleted",
                json!({"source_id":old}),
                &[],
                &[old],
                &[],
                &old_collected_by,
            )
            .await?;
        }
    }
    tx.commit().await.map_err(internal)?;
    if created {
        Ok((
            StatusCode::CREATED,
            Json(model::flow(&record, &parent_ids, None)),
        )
            .into_response())
    } else {
        Ok(StatusCode::NO_CONTENT.into_response())
    }
}

async fn delete_flow(
    State(state): State<MetadataState>,
    Path(raw): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let flow_id = id(&raw)?;
    let identity = request
        .extensions()
        .get::<Actor>()
        .cloned()
        .expect("auth identity");
    let pool = state.pool;
    let mut tx = pool.begin().await.map_err(internal)?;
    db::flows::lock_flow_segments(&mut *tx, flow_id)
        .await
        .map_err(internal)?;
    let flow = db::flows::get_flow_with(&mut *tx, flow_id)
        .await
        .map_err(internal)?
        .ok_or_else(missing)?;
    if flow.read_only {
        return Err(readonly());
    }
    if db::flows::has_segments(&mut *tx, flow_id)
        .await
        .map_err(internal)?
    {
        let now = crate::now();
        let range = db::flows::flow_timeranges(&mut *tx, &[flow_id], timerange::Bounds::default())
            .await
            .map_err(internal)?
            .get(&flow_id)
            .copied()
            .flatten()
            .map_or_else(
                || "()".into(),
                |(start, end)| timerange::from_bounds(Some(start), Some(end)),
            );
        let request_id = Uuid::new_v4();
        let record = json!({"id":request_id,"flow_id":flow_id,"timerange_to_delete":range,"timerange_remaining":range,"delete_flow":true,"created":model::timestamp(now),"created_by":identity.subject,"updated":model::timestamp(now),"status":"created"});
        let deletion = DeleteRequest {
            id: request_id,
            flow_id,
            status: "created".into(),
            record: record.clone(),
            updated: now,
            created_at: now,
            claimed_at: None,
            claimed_by: None,
            claim_expires_at: None,
        };
        db::queues::save_delete_request(&mut *tx, &deletion)
            .await
            .map_err(internal)?;
        tx.commit().await.map_err(internal)?;
        let mut response = (StatusCode::ACCEPTED, Json(record)).into_response();
        response.headers_mut().insert(
            LOCATION,
            format!("/flow-delete-requests/{request_id}")
                .parse()
                .unwrap(),
        );
        return Ok(response);
    }
    let source_ids = flow.source_id.into_iter().collect::<Vec<_>>();
    let source_relationships = db::flows::source_relationships(&mut *tx, &source_ids)
        .await
        .map_err(internal)?;
    let source_collected_by = flow
        .source_id
        .and_then(|id| source_relationships.get(&id))
        .map(|value| value.collected_by.clone())
        .unwrap_or_default();
    let parents = db::flows::list_flows_collecting(&mut *tx, &[flow_id])
        .await
        .map_err(internal)?;
    let parent_ids = parents.iter().map(|value| value.id).collect::<Vec<_>>();
    for mut parent in parents {
        parent.flow_collection_ids.retain(|id| *id != flow_id);
        let mut payload = data(&parent);
        let empty = if let Some(collection) = payload
            .get_mut("flow_collection")
            .and_then(Value::as_array_mut)
        {
            collection.retain(|item| {
                item.get("id")
                    .and_then(Value::as_str)
                    .and_then(|id| id.parse::<Uuid>().ok())
                    != Some(flow_id)
            });
            collection.is_empty()
        } else {
            false
        };
        if empty {
            payload.remove("flow_collection");
        }
        parent.metadata_updated = crate::now();
        sync_record(&mut parent, payload, &identity);
        db::flows::save_flow(&mut *tx, &parent)
            .await
            .map_err(internal)?;
        emit_flow_updated(&mut tx, &parent).await?;
    }
    db::flows::delete_flow(&mut *tx, flow_id)
        .await
        .map_err(internal)?;
    enqueue_event(
        &mut tx,
        "flows/deleted",
        json!({"flow_id":flow_id}),
        &[flow_id],
        &source_ids,
        &parent_ids,
        &source_collected_by,
    )
    .await?;
    if let Some(source_id) = flow.source_id
        && db::flows::delete_source(&mut *tx, source_id)
            .await
            .map_err(internal)?
    {
        enqueue_event(
            &mut tx,
            "sources/deleted",
            json!({"source_id":source_id}),
            &[],
            &[source_id],
            &[],
            &source_collected_by,
        )
        .await?;
    }
    tx.commit().await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn load(state: &MetadataState, raw: &str) -> Result<FlowRecord, ApiError> {
    db::flows::get_flow(&state.pool, id(raw)?)
        .await
        .map_err(internal)?
        .ok_or_else(missing)
}
async fn get_collection(
    State(state): State<MetadataState>,
    Path(raw): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let flow = load(&state, &raw).await?;
    Ok(Json(
        data(&flow)
            .remove("flow_collection")
            .unwrap_or_else(|| json!([])),
    )
    .into_response())
}
fn collection_conflict() -> ApiError {
    ApiError::bad_request(
        "The collection order or member roles conflict with another representation of the Source.",
    )
}

async fn set_collection(
    state: MetadataState,
    raw: String,
    request: Request<Body>,
    clear: bool,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let flow_id = id(&raw)?;
    let identity = request
        .extensions()
        .get::<Actor>()
        .cloned()
        .expect("auth identity");
    let value = if clear {
        json!([])
    } else {
        strict_json(request, MAX_JSON_BODY_BYTES)
            .await
            .map_err(|_| ApiError::bad_request("Bad request. Invalid Flow collection."))?
    };
    let ids = rules::validate_collection(&value, flow_id)
        .map_err(|_| ApiError::bad_request("Bad request. Invalid Flow collection."))?;
    let pool = state.pool;
    let mut tx = pool.begin().await.map_err(internal)?;
    db::flows::lock_flow_segments(&mut *tx, flow_id)
        .await
        .map_err(internal)?;
    let mut flow = db::flows::get_flow_with(&mut *tx, flow_id)
        .await
        .map_err(internal)?
        .ok_or_else(missing)?;
    if flow.read_only {
        return Err(readonly());
    }
    for child in &ids {
        if db::flows::get_flow_with(&mut *tx, *child)
            .await
            .map_err(internal)?
            .is_none()
        {
            return Err(ApiError::bad_request(
                "Bad request. Invalid Flow collection.",
            ));
        }
    }
    let mut payload = data(&flow);
    if clear {
        payload.remove("flow_collection");
    } else {
        payload.insert("flow_collection".into(), value);
    }
    flow.flow_collection_ids = ids;
    flow.metadata_updated = crate::now();
    sync_record(&mut flow, payload, &identity);
    db::flows::save_flow(&mut *tx, &flow)
        .await
        .map_err(internal)?;
    if let Some(source) = flow.source_id
        && db::flows::source_relationships(&mut *tx, &[source])
            .await
            .map_err(internal)?
            .get(&source)
            .is_some_and(|r| r.conflicting_collection)
    {
        return Err(collection_conflict());
    }
    emit_flow_updated(&mut tx, &flow).await?;
    tx.commit().await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
async fn put_collection(
    State(state): State<MetadataState>,
    Path(raw): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    set_collection(state, raw, request, false).await
}
async fn delete_collection(
    State(state): State<MetadataState>,
    Path(raw): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    set_collection(state, raw, request, true).await
}

async fn get_property(
    state: MetadataState,
    raw: String,
    request: Request<Body>,
    name: &str,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let flow = load(&state, &raw).await?;
    let payload = data(&flow);
    let value = match name {
        "label" => flow.label.map_or_else(|| json!(""), Value::String),
        "description" => payload.get(name).cloned().unwrap_or_else(|| json!("")),
        "read_only" => json!(flow.read_only),
        _ => payload.get(name).cloned().unwrap_or(Value::Null),
    };
    Ok(Json(value).into_response())
}
macro_rules! getter {
    ($fn:ident,$name:literal) => {
        async fn $fn(
            State(state): State<MetadataState>,
            Path(raw): Path<String>,
            request: Request<Body>,
        ) -> Result<Response, ApiError> {
            get_property(state, raw, request, $name).await
        }
    };
}
getter!(get_label, "label");
getter!(get_description, "description");
getter!(get_avg_bit_rate, "avg_bit_rate");
getter!(get_max_bit_rate, "max_bit_rate");
getter!(get_read_only, "read_only");
async fn set_property(
    state: MetadataState,
    raw: String,
    request: Request<Body>,
    name: &str,
    clear: bool,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let flow_id = id(&raw)?;
    let identity = request
        .extensions()
        .get::<Actor>()
        .cloned()
        .expect("auth identity");
    let value = if clear {
        None
    } else {
        let value: Value = strict_json(request, MAX_JSON_BODY_BYTES)
            .await
            .map_err(|_| ApiError::bad_request("Bad request."))?;
        let valid = match name {
            "label" | "description" => value.is_string(),
            "avg_bit_rate" | "max_bit_rate" => value.as_i64().is_some_and(|value| value >= 0),
            "read_only" => value.is_boolean(),
            _ => false,
        };
        if !valid {
            return Err(ApiError::bad_request("Bad request."));
        }
        Some(value)
    };
    let pool = state.pool;
    let mut tx = pool.begin().await.map_err(internal)?;
    db::flows::lock_flow_segments(&mut *tx, flow_id)
        .await
        .map_err(internal)?;
    let mut flow = db::flows::get_flow_with(&mut *tx, flow_id)
        .await
        .map_err(internal)?
        .ok_or_else(missing)?;
    if name != "read_only" && flow.read_only {
        return Err(readonly());
    }
    if name == "avg_bit_rate" && flow.profile_id.is_some() {
        return Err(ApiError::bad_request("Bad request."));
    }
    let mut payload = data(&flow);
    match value {
        Some(value) => {
            payload.insert(name.into(), value.clone());
            if name == "read_only" {
                flow.read_only = value.as_bool().unwrap();
            }
        }
        None => {
            payload.remove(name);
        }
    }
    flow.metadata_updated = crate::now();
    sync_record(&mut flow, payload, &identity);
    db::flows::save_flow(&mut *tx, &flow)
        .await
        .map_err(internal)?;
    emit_flow_updated(&mut tx, &flow).await?;
    tx.commit().await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
macro_rules! setter {
    ($put:ident,$delete:ident,$name:literal) => {
        async fn $put(
            State(state): State<MetadataState>,
            Path(raw): Path<String>,
            request: Request<Body>,
        ) -> Result<Response, ApiError> {
            set_property(state, raw, request, $name, false).await
        }
        async fn $delete(
            State(state): State<MetadataState>,
            Path(raw): Path<String>,
            request: Request<Body>,
        ) -> Result<Response, ApiError> {
            set_property(state, raw, request, $name, true).await
        }
    };
}
setter!(put_label, delete_label, "label");
setter!(put_description, delete_description, "description");
setter!(put_avg_bit_rate, delete_avg_bit_rate, "avg_bit_rate");
setter!(put_max_bit_rate, delete_max_bit_rate, "max_bit_rate");
async fn put_read_only(
    State(state): State<MetadataState>,
    Path(raw): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    set_property(state, raw, request, "read_only", false).await
}

async fn get_tags(
    State(state): State<MetadataState>,
    Path(raw): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    Ok(Json(json!(load(&state, &raw).await?.tags)).into_response())
}
async fn get_tag(
    State(state): State<MetadataState>,
    Path((raw, name)): Path<(String, String)>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let flow = load(&state, &raw).await?;
    Ok(Json(
        flow.tags
            .get(&name)
            .cloned()
            .ok_or_else(|| ApiError::not_found("The requested Flow tag does not exist."))?,
    )
    .into_response())
}
async fn set_tag(
    state: MetadataState,
    raw: String,
    name: String,
    request: Request<Body>,
    clear: bool,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let flow_id = id(&raw)?;
    let identity = request
        .extensions()
        .get::<Actor>()
        .cloned()
        .expect("auth identity");
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
    let pool = state.pool;
    let mut tx = pool.begin().await.map_err(internal)?;
    db::flows::lock_flow_segments(&mut *tx, flow_id)
        .await
        .map_err(internal)?;
    let mut flow = db::flows::get_flow_with(&mut *tx, flow_id)
        .await
        .map_err(internal)?
        .ok_or_else(missing)?;
    if flow.read_only {
        return Err(readonly());
    }
    match value {
        Some(value) => {
            flow.tags.insert(name, value);
        }
        None => {
            flow.tags.remove(&name);
        }
    }
    let mut payload = data(&flow);
    payload.insert("tags".into(), json!(flow.tags));
    flow.metadata_updated = crate::now();
    sync_record(&mut flow, payload, &identity);
    db::flows::save_flow(&mut *tx, &flow)
        .await
        .map_err(internal)?;
    emit_flow_updated(&mut tx, &flow).await?;
    tx.commit().await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
async fn put_tag(
    State(state): State<MetadataState>,
    Path((raw, name)): Path<(String, String)>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    set_tag(state, raw, name, request, false).await
}
async fn delete_tag(
    State(state): State<MetadataState>,
    Path((raw, name)): Path<(String, String)>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    set_tag(state, raw, name, request, true).await
}
