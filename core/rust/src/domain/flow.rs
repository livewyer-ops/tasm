// Cloudflare adaptation of TASM and rust-tams-api (Apache-2.0); see NOTICE.
use std::collections::BTreeSet;

use serde_json::{Map, Value};
use uuid::Uuid;

use super::{
    ValidationError,
    model::{FORMATS, tags, uuid_field},
};

const SERVER_FIELDS: &[&str] = &[
    "timerange",
    "collected_by",
    "created",
    "metadata_updated",
    "segments_updated",
    "created_by",
    "updated_by",
    "updated",
];
const PROFILE_OWNED: &[&str] = &[
    "format",
    "container",
    "codec",
    "essence_parameters",
    "avg_bit_rate",
    "segment_duration",
    "container_mapping",
];

pub fn validate_put(map: &Map<String, Value>, path_id: Uuid) -> Result<(), ValidationError> {
    if uuid_field(map, "id")? != path_id || uuid_field(map, "source_id").is_err() {
        return Err(ValidationError);
    }
    if let Some(value) = map.get("profile_id") {
        match value {
            Value::String(value) if value.is_empty() || value.parse::<Uuid>().is_ok() => {}
            _ => return Err(ValidationError),
        }
    }
    for name in ["label", "description", "metadata_version"] {
        if map.get(name).is_some_and(|value| !value.is_string()) {
            return Err(ValidationError);
        }
    }
    for name in ["created_by", "updated_by"] {
        if map
            .get(name)
            .is_some_and(|value| !value.is_string() && !value.is_null())
        {
            return Err(ValidationError);
        }
    }
    if map
        .get("read_only")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err(ValidationError);
    }
    if let Some(status) = map.get("status") {
        let status = status.as_str().ok_or(ValidationError)?;
        if !super::model::FLOW_STATUSES.contains(&status) {
            return Err(ValidationError);
        }
    }
    for name in ["avg_bit_rate", "max_bit_rate", "generation"] {
        if let Some(value) = map.get(name)
            && value.as_i64().is_none_or(|value| value < 0)
        {
            return Err(ValidationError);
        }
    }
    for name in ["container", "codec"] {
        if let Some(value) = map.get(name) {
            mime(value)?;
        }
    }
    tags(map.get("tags"))?;
    if let Some(collection) = map.get("flow_collection") {
        validate_collection(collection, path_id)?;
    }
    Ok(())
}

fn mime(value: &Value) -> Result<&str, ValidationError> {
    let value = value.as_str().ok_or(ValidationError)?;
    let (kind, subtype) = value.split_once('/').ok_or(ValidationError)?;
    if kind.is_empty()
        || subtype.is_empty()
        || value.chars().any(char::is_whitespace)
        || subtype.contains('/')
    {
        return Err(ValidationError);
    }
    Ok(value)
}

fn positive_integer(map: &Map<String, Value>, name: &str) -> Result<(), ValidationError> {
    if map
        .get(name)
        .is_some_and(|value| value.as_i64().is_none_or(|value| value <= 0))
    {
        return Err(ValidationError);
    }
    Ok(())
}

fn required_positive_integer(map: &Map<String, Value>, name: &str) -> Result<(), ValidationError> {
    positive_integer(map, name)?;
    map.contains_key(name).then_some(()).ok_or(ValidationError)
}

fn rational(value: &Value, denominator_required: bool) -> Result<(), ValidationError> {
    let map = value.as_object().ok_or(ValidationError)?;
    required_positive_integer(map, "numerator")?;
    positive_integer(map, "denominator")?;
    if denominator_required && !map.contains_key("denominator") {
        return Err(ValidationError);
    }
    Ok(())
}

fn container_mapping(value: &Value) -> Result<(), ValidationError> {
    let map = value.as_object().ok_or(ValidationError)?;
    for name in ["track_index", "format_track_index"] {
        if map
            .get(name)
            .is_some_and(|value| value.as_i64().is_none_or(|value| value < 0))
        {
            return Err(ValidationError);
        }
    }
    for name in ["mp2ts_container", "mxf_container", "isobmff_container"] {
        if map.get(name).is_some_and(|value| !value.is_object()) {
            return Err(ValidationError);
        }
    }
    if let Some(audio) = map.get("audio_track") {
        let audio = audio.as_object().ok_or(ValidationError)?;
        if let Some(numbers) = audio.get("channel_numbers") {
            let numbers = numbers
                .as_array()
                .filter(|values| !values.is_empty())
                .ok_or(ValidationError)?;
            if numbers
                .iter()
                .any(|value| value.as_i64().is_none_or(|value| value < 0))
            {
                return Err(ValidationError);
            }
        }
        if audio.get("channel_range").is_some_and(|value| {
            value
                .as_str()
                .and_then(|value| value.split_once('_'))
                .is_none_or(|(start, end)| {
                    start.parse::<u64>().is_err() || end.parse::<u64>().is_err()
                })
        }) {
            return Err(ValidationError);
        }
    }
    Ok(())
}

pub fn validate_direct(map: &Map<String, Value>) -> Result<(), ValidationError> {
    let format = map
        .get("format")
        .and_then(Value::as_str)
        .ok_or(ValidationError)?;
    if !FORMATS.contains(&format) {
        return Err(ValidationError);
    }
    if let Some(container) = map.get("container") {
        mime(container)?;
    }
    if map
        .get("avg_bit_rate")
        .is_some_and(|value| value.as_i64().is_none_or(|value| value < 0))
    {
        return Err(ValidationError);
    }
    if let Some(duration) = map.get("segment_duration") {
        rational(duration, false)?;
    }
    if let Some(mapping) = map.get("container_mapping") {
        container_mapping(mapping)?;
    }
    if format == "urn:x-nmos:format:multi" {
        if let Some(parameters) = map.get("essence_parameters") {
            let parameters = parameters.as_object().ok_or(ValidationError)?;
            if parameters.keys().any(|name| name != "init_segments")
                || parameters
                    .get("init_segments")
                    .is_some_and(|value| !value.is_boolean())
            {
                return Err(ValidationError);
            }
        }
        return Ok(());
    }

    let codec = mime(map.get("codec").ok_or(ValidationError)?)?;
    let parameters = map
        .get("essence_parameters")
        .and_then(Value::as_object)
        .ok_or(ValidationError)?;
    if parameters.values().any(Value::is_null) {
        return Err(ValidationError);
    }
    let allowed: &[&str] = match format {
        "urn:x-nmos:format:video" => &[
            "frame_width",
            "frame_height",
            "bit_depth",
            "interlace_mode",
            "colorspace",
            "transfer_characteristic",
            "aspect_ratio",
            "pixel_aspect_ratio",
            "component_type",
            "horiz_chroma_subs",
            "vert_chroma_subs",
            "unc_parameters",
            "avc_parameters",
            "frame_rate",
            "vfr",
            "init_segments",
        ],
        "urn:x-nmos:format:audio" => &[
            "sample_rate",
            "channels",
            "bit_depth",
            "codec_parameters",
            "unc_parameters",
            "init_segments",
        ],
        "urn:x-tam:format:image" => &["frame_width", "frame_height", "aspect_ratio"],
        "urn:x-nmos:format:data" => &["data_type", "init_segments"],
        _ => return Err(ValidationError),
    };
    if parameters
        .keys()
        .any(|name| !allowed.contains(&name.as_str()))
    {
        return Err(ValidationError);
    }
    for name in [
        "frame_width",
        "frame_height",
        "sample_rate",
        "channels",
        "bit_depth",
        "horiz_chroma_subs",
        "vert_chroma_subs",
    ] {
        positive_integer(parameters, name)?;
    }
    if matches!(format, "urn:x-nmos:format:video" | "urn:x-tam:format:image") {
        required_positive_integer(parameters, "frame_width")?;
        required_positive_integer(parameters, "frame_height")?;
    }
    if format == "urn:x-nmos:format:audio" {
        required_positive_integer(parameters, "sample_rate")?;
        required_positive_integer(parameters, "channels")?;
    }
    for name in ["aspect_ratio", "pixel_aspect_ratio"] {
        if let Some(value) = parameters.get(name) {
            rational(value, true)?;
        }
    }
    if parameters
        .get("data_type")
        .is_some_and(|value| !value.is_string())
        || parameters
            .get("init_segments")
            .is_some_and(|value| !value.is_boolean())
    {
        return Err(ValidationError);
    }
    for name in ["unc_parameters", "avc_parameters", "codec_parameters"] {
        if parameters.get(name).is_some_and(|value| !value.is_object()) {
            return Err(ValidationError);
        }
    }
    let unc_type = parameters
        .get("unc_parameters")
        .and_then(|value| value.get("unc_type"))
        .and_then(Value::as_str);
    if parameters.contains_key("unc_parameters") {
        let permitted: &[&str] = if format == "urn:x-nmos:format:audio" {
            &["interleaved", "planar", "pairs"]
        } else {
            &[
                "planar", "YUYV", "UYVY", "AYUV", "v210", "v216", "RGB", "RGBx", "xRGB", "BGRx",
                "xBGR", "RGBA", "ARGB", "BGRA", "ABGR", "alpha",
            ]
        };
        if unc_type.is_none_or(|value| !permitted.contains(&value)) {
            return Err(ValidationError);
        }
    }
    if let Some(parameters) = parameters.get("avc_parameters").and_then(Value::as_object) {
        for name in ["profile", "level", "flags"] {
            if parameters.get(name).and_then(Value::as_i64).is_none() {
                return Err(ValidationError);
            }
        }
    }
    if let Some(parameters) = parameters
        .get("codec_parameters")
        .and_then(Value::as_object)
    {
        for name in ["coded_frame_size", "mp4_oti"] {
            if parameters
                .get(name)
                .is_some_and(|value| value.as_i64().is_none())
            {
                return Err(ValidationError);
            }
        }
    }
    if format == "urn:x-nmos:format:audio"
        && matches!(codec, "audio/x-raw-int" | "audio/x-raw-float")
    {
        required_positive_integer(parameters, "bit_depth")?;
        if unc_type.is_none()
            || (codec == "audio/x-raw-float"
                && !matches!(parameters["bit_depth"].as_i64(), Some(32 | 64)))
        {
            return Err(ValidationError);
        }
    }
    if format == "urn:x-nmos:format:video" {
        if codec == "video/raw" {
            required_positive_integer(parameters, "bit_depth")?;
            if unc_type.is_none() {
                return Err(ValidationError);
            }
        }
        if unc_type.is_some_and(|value| ["YUYV", "UYVY", "AYUV", "v210", "v216"].contains(&value)) {
            required_positive_integer(parameters, "horiz_chroma_subs")?;
            required_positive_integer(parameters, "vert_chroma_subs")?;
        }
        for (name, values) in [
            (
                "interlace_mode",
                &[
                    "progressive",
                    "interlaced_tff",
                    "interlaced_bff",
                    "interlaced_psf",
                ][..],
            ),
            ("colorspace", &["BT601", "BT709", "BT2020", "BT2100"][..]),
            ("transfer_characteristic", &["SDR", "HLG", "PQ"][..]),
            ("component_type", &["YCbCr", "RGB"][..]),
        ] {
            if parameters
                .get(name)
                .is_some_and(|value| value.as_str().is_none_or(|value| !values.contains(&value)))
            {
                return Err(ValidationError);
            }
        }
        let variable = match parameters.get("vfr") {
            None => false,
            Some(Value::Bool(value)) => *value,
            Some(_) => return Err(ValidationError),
        };
        let frame_rate = parameters.get("frame_rate");
        if variable == frame_rate.is_some() {
            return Err(ValidationError);
        }
        if let Some(rate) = frame_rate {
            rational(rate, false)?;
        }
    }
    Ok(())
}

pub fn validate_profile_metadata(value: &Value) -> Result<(), ValidationError> {
    let map = value.as_object().ok_or(ValidationError)?;
    if map.keys().any(|name| {
        SERVER_FIELDS.contains(&name.as_str())
            || matches!(
                name.as_str(),
                "profile_id"
                    | "id"
                    | "source_id"
                    | "label"
                    | "description"
                    | "tags"
                    | "flow_collection"
                    | "read_only"
                    | "status"
                    | "metadata_version"
                    | "generation"
                    | "max_bit_rate"
            )
    }) {
        return Err(ValidationError);
    }
    validate_direct(map)?;
    if map.get("format").and_then(Value::as_str) == Some("urn:x-nmos:format:multi") {
        return Err(ValidationError);
    }
    Ok(())
}

pub fn profile_has_technical_fields(map: &Map<String, Value>) -> bool {
    PROFILE_OWNED.iter().any(|name| map.contains_key(*name))
}

pub fn validate_collection(value: &Value, parent: Uuid) -> Result<Vec<Uuid>, ValidationError> {
    let array = value.as_array().ok_or(ValidationError)?;
    let mut ids = Vec::with_capacity(array.len());
    let mut unique = BTreeSet::new();
    for item in array {
        let item = item.as_object().ok_or(ValidationError)?;
        let id = uuid_field(item, "id")?;
        if id == parent || !unique.insert(id) {
            return Err(ValidationError);
        }
        if item.get("role").is_some_and(|value| !value.is_string()) {
            return Err(ValidationError);
        }
        if item
            .get("container_mapping")
            .is_some_and(|value| !value.is_object())
        {
            return Err(ValidationError);
        }
        ids.push(id);
    }
    Ok(ids)
}

pub fn clean_client_fields(map: &mut Map<String, Value>) {
    for field in SERVER_FIELDS {
        map.remove(*field);
    }
}
