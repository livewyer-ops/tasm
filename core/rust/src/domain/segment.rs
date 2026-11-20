// TASM browser adaptation of rust-tams-api (Apache-2.0); see NOTICE for changes.
use std::collections::BTreeSet;

use serde_json::{Value, json};

use crate::{
    db::SegmentRecord,
    domain::{ValidationError, timerange},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SegmentBounds {
    pub start: i128,
    pub end: i128,
    pub point: bool,
}

pub fn bounds(value: &str) -> Result<SegmentBounds, ValidationError> {
    let parsed = timerange::parse(value)?;
    if parsed.empty {
        return Err(ValidationError);
    }
    let start = parsed.start.ok_or(ValidationError)?;
    let end = parsed.end.ok_or(ValidationError)?;
    Ok(SegmentBounds {
        start,
        end: if parsed.point {
            start.checked_add(1).ok_or(ValidationError)?
        } else {
            end
        },
        point: parsed.point,
    })
}

pub fn overlaps(a: SegmentBounds, b: SegmentBounds) -> bool {
    a.start < b.end && b.start < a.end
}

pub fn coverage_gaps(segments: &[SegmentRecord]) -> Result<Vec<String>, ValidationError> {
    let mut ranges = segments
        .iter()
        .map(|segment| bounds(&segment.timerange))
        .collect::<Result<Vec<_>, _>>()?;
    ranges.sort_by_key(|range| (range.start, range.end));
    let Some(first) = ranges.first() else {
        return Ok(Vec::new());
    };
    let mut end = first.end;
    let mut gaps = Vec::new();
    for range in ranges.into_iter().skip(1) {
        if range.start > end {
            gaps.push(timerange::from_bounds(Some(end), Some(range.start)));
        }
        end = end.max(range.end);
    }
    Ok(gaps)
}

pub fn effective_object_timerange(
    timerange_value: &str,
    ts_offset: Option<&str>,
    explicit: Option<&str>,
) -> Result<String, ValidationError> {
    if let Some(explicit) = explicit {
        bounds(explicit)?;
        return Ok(explicit.to_owned());
    }
    let Some(offset) = ts_offset else {
        return Ok(timerange_value.to_owned());
    };
    let offset = timerange::parse(&format!("[{offset}]"))?
        .start
        .ok_or(ValidationError)?;
    let parsed = timerange::parse(timerange_value)?;
    let start = parsed
        .start
        .ok_or(ValidationError)?
        .checked_sub(offset)
        .ok_or(ValidationError)?;
    let end = parsed
        .end
        .ok_or(ValidationError)?
        .checked_sub(offset)
        .ok_or(ValidationError)?;
    if parsed.point {
        return Ok(format!("[{}]", format_timestamp(start)));
    }
    let inclusive_end = timerange_value.ends_with(']');
    let end = if inclusive_end {
        end.checked_sub(1).ok_or(ValidationError)?
    } else {
        end
    };
    let start_delimiter = '[';
    let end_delimiter = if inclusive_end { ']' } else { ')' };
    Ok(format!(
        "{start_delimiter}{}_{}{end_delimiter}",
        format_timestamp(start),
        format_timestamp(end)
    ))
}

fn format_timestamp(value: i128) -> String {
    timerange::format_timestamp(value)
}

pub fn response(
    segment: &SegmentRecord,
    get_urls: Vec<Value>,
    init_object: Option<(&str, Vec<Value>)>,
    include_object_timerange: bool,
) -> Value {
    let data = segment.record.as_object();
    let mut value = json!({
        "object_id": segment.object_id,
        "timerange": segment.timerange,
        "ts_offset": data.and_then(|value| value.get("ts_offset")),
        "last_duration": data.and_then(|value| value.get("last_duration")),
        "sample_offset": data.and_then(|value| value.get("sample_offset")),
        "sample_count": data.and_then(|value| value.get("sample_count")),
        "key_frame_count": data.and_then(|value| value.get("key_frame_count")),
        "get_urls": get_urls,
        "init_object": init_object.map(|(object_id, get_urls)| json!({"object_id":object_id,"get_urls":get_urls})),
    });
    if include_object_timerange {
        let effective = effective_object_timerange(
            &segment.timerange,
            data.and_then(|value| value.get("ts_offset"))
                .and_then(Value::as_str),
            data.and_then(|value| value.get("object_timerange"))
                .and_then(Value::as_str),
        )
        .unwrap_or_else(|_| segment.timerange.clone());
        value
            .as_object_mut()
            .expect("segment response")
            .insert("object_timerange".into(), json!(effective));
    }
    value
        .as_object_mut()
        .expect("segment response")
        .retain(|_, value| !value.is_null());
    value
}

pub fn validate_post(value: &Value) -> Result<(&str, &str, SegmentBounds), ValidationError> {
    let object = value.as_object().ok_or(ValidationError)?;
    let object_id = object
        .get("object_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(ValidationError)?;
    let timerange_value = object
        .get("timerange")
        .and_then(Value::as_str)
        .ok_or(ValidationError)?;
    let parsed = bounds(timerange_value)?;
    if !timerange_value.starts_with('[') {
        return Err(ValidationError);
    }
    for field in [
        "init_object_id",
        "ts_offset",
        "last_duration",
        "object_timerange",
    ] {
        if object
            .get(field)
            .is_some_and(|value| value.as_str().is_none())
        {
            return Err(ValidationError);
        }
    }
    for field in ["sample_offset", "sample_count", "key_frame_count"] {
        if object
            .get(field)
            .is_some_and(|value| value.as_i64().is_none_or(|value| value < 0))
        {
            return Err(ValidationError);
        }
    }
    if let Some(offset) = object.get("ts_offset").and_then(Value::as_str) {
        effective_object_timerange(timerange_value, Some(offset), None)?;
    }
    if let Some(last_duration) = object.get("last_duration").and_then(Value::as_str) {
        let duration = timerange::parse(&format!("[{last_duration}]"))?
            .start
            .ok_or(ValidationError)?;
        if duration < 0 || timerange_value.ends_with(']') {
            return Err(ValidationError);
        }
    }
    if let Some(value) = object.get("object_timerange").and_then(Value::as_str) {
        bounds(value)?;
    }
    if let Some(urls) = object.get("get_urls") {
        let urls = urls
            .as_array()
            .filter(|urls| !urls.is_empty())
            .ok_or(ValidationError)?;
        let mut labels = BTreeSet::new();
        for value in urls {
            let entry = value.as_object().ok_or(ValidationError)?;
            let url = entry
                .get("url")
                .and_then(Value::as_str)
                .ok_or(ValidationError)?;
            let label = entry
                .get("label")
                .and_then(Value::as_str)
                .filter(|label| !label.is_empty())
                .ok_or(ValidationError)?;
            if entry
                .get("presigned")
                .is_some_and(|value| value.as_bool().is_none())
                || !labels.insert(label)
                || url::Url::parse(url).ok().is_none_or(|parsed| {
                    !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none()
                })
            {
                return Err(ValidationError);
            }
        }
    }
    Ok((object_id, timerange_value, parsed))
}
