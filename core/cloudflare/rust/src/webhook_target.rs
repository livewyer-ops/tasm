use crate::http::{
    error::ApiError,
    routes::{service::MetadataState, webhooks::invalid_payload},
};
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
            if let Some(mapped) = value.to_ipv4_mapped() {
                return blocked(IpAddr::V4(mapped));
            }
            let o = value.octets();
            value.is_loopback()
                || value.is_unspecified()
                || value.is_multicast()
                || o[0] & 0xfe == 0xfc
                || (o[0] == 0xfe && o[1] & 0xc0 == 0x80)
        }
    }
}
fn allowed(policy: &crate::webhooks::WebhookPolicy, host: &str, address: Option<IpAddr>) -> bool {
    policy.allowed_hosts.iter().any(|raw| {
        let item = raw.trim().to_ascii_lowercase();
        let item = item.trim_end_matches('.');
        item == host
            || item.strip_prefix("*.").is_some_and(|suffix| {
                suffix.contains('.')
                    && !suffix.contains('*')
                    && suffix.split('.').all(|part| !part.is_empty())
                    && address.is_none()
                    && suffix.parse::<IpAddr>().is_err()
                    && host.ends_with(&format!(".{suffix}"))
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
    validate_target(
        map,
        &crate::webhooks::WebhookPolicy {
            allow_private_targets: state.settings.webhook_allow_private_targets,
            allowed_hosts: state.settings.webhook_allowed_hosts.clone(),
        },
    )
}

pub(crate) fn validate_target(
    map: &Map<String, Value>,
    policy: &crate::webhooks::WebhookPolicy,
) -> Result<(), ApiError> {
    let url = map
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(invalid_payload)?;
    let parsed = url::Url::parse(url).map_err(|_| invalid_payload())?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port_or_known_default() != Some(443)
        || parsed.fragment().is_some()
    {
        return Err(invalid_payload());
    }
    let host = parsed
        .host_str()
        .unwrap()
        .trim()
        .trim_end_matches('.')
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();
    let literal = host.parse::<IpAddr>().ok();
    if !allowed(policy, &host, literal)
        || (!policy.allow_private_targets
            && (matches!(host.as_str(), "metadata" | "metadata.google.internal")
                || host == "localhost"
                || host.ends_with(".svc")
                || host.ends_with(".svc.cluster.local")
                || host.ends_with(".cluster.local")
                || literal.is_some_and(blocked)))
    {
        return Err(invalid_payload());
    }
    if map
        .get("api_key_name")
        .is_some_and(|value| !valid_header(value.as_str().unwrap()))
    {
        return Err(invalid_payload());
    }
    if map
        .get("api_key_value")
        .and_then(Value::as_str)
        .is_some_and(|value| value.contains(['\r', '\n']))
    {
        return Err(invalid_payload());
    }
    Ok(())
}
