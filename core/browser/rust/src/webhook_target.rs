use crate::http::{
    error::ApiError,
    routes::{service::MetadataState, webhooks::invalid_payload},
};
use ipnet::IpNet;
use serde_json::{Map, Value};
use std::net::IpAddr;
fn blocked(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(value) => {
            let [a, b, _, _] = value.octets();
            value.is_private()
                || value.is_loopback()
                || value.is_link_local()
                || value.is_multicast()
                || value.is_unspecified()
                || a == 0
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0)
                || a >= 240
        }
        IpAddr::V6(value) => {
            let o = value.octets();
            value.is_loopback()
                || value.is_unspecified()
                || value.is_multicast()
                || o[0] & 0xfe == 0xfc
                || (o[0] == 0xfe && o[1] & 0xc0 == 0x80)
        }
    }
}
fn allowed(state: &MetadataState, host: &str, address: Option<IpAddr>) -> bool {
    state.settings.webhook_allowed_hosts.iter().any(|raw| {
        let item = raw.trim().to_ascii_lowercase();
        let item = item.trim_end_matches('.');
        item == "*"
            || item == host
            || item.starts_with('.') && host.ends_with(item)
            || address.is_some_and(|address| {
                item.parse::<IpAddr>() == Ok(address)
                    || item
                        .parse::<IpNet>()
                        .is_ok_and(|network| network.contains(&address))
            })
    })
}
fn valid_header(value: &str) -> bool {
    const RESERVED: &[&str] = &[
        "connection",
        "content-length",
        "content-type",
        "host",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ];
    !value.is_empty()
        && value.trim() == value
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
        && !RESERVED.contains(&value.to_ascii_lowercase().as_str())
}
pub(crate) async fn validate_configuration(
    state: &MetadataState,
    map: &Map<String, Value>,
) -> Result<(), ApiError> {
    let url = map
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(invalid_payload)?;
    let parsed = url::Url::parse(url).map_err(|_| invalid_payload())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port_or_known_default().is_none()
    {
        return Err(invalid_payload());
    }
    let host = parsed
        .host_str()
        .unwrap()
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let literal = host.parse::<IpAddr>().ok();
    if !allowed(state, &host, literal)
        && (matches!(host.as_str(), "metadata" | "metadata.google.internal")
            || host == "localhost"
            || host.ends_with(".svc")
            || host.ends_with(".svc.cluster.local")
            || host.ends_with(".cluster.local")
            || literal.is_some_and(blocked))
    {
        return Err(invalid_payload());
    }
    if map
        .get("api_key_name")
        .is_some_and(|value| !valid_header(value.as_str().unwrap()))
    {
        return Err(invalid_payload());
    }
    Ok(())
}
