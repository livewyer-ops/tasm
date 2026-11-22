// TASM browser adaptation of rust-tams-api (Apache-2.0); see NOTICE for changes.
pub mod flow;
pub mod model;
pub mod object;
pub mod segment;
pub mod timerange;

#[derive(Debug)]
pub struct ValidationError;

/// Matches the parameter-free MIME type in the TAMS filter and allocation schemas.
pub fn valid_mime_type(value: &str) -> bool {
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
