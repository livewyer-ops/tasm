// Shared webhook target validation for both hosts. Compiled into each adapter
// crate with #[path], like worker.rs, because it uses the adapter's routes.
use crate::http::{
    error::ApiError,
    routes::{service::MetadataState, webhooks::invalid_payload},
};
use crate::webhooks::WebhookPolicy;
use ipnet::IpNet;
use serde_json::{Map, Value};
use std::net::{IpAddr, Ipv4Addr};

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
            // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d),
            // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) embed an IPv4 target.
            let embedded = if let Some(mapped) = value.to_ipv4_mapped() {
                Some(mapped)
            } else if (o[..12] == [0; 12] && !value.is_loopback() && !value.is_unspecified())
                || o[..12] == [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0]
            {
                Some(Ipv4Addr::new(o[12], o[13], o[14], o[15]))
            } else if o[..2] == [0x20, 0x02] {
                Some(Ipv4Addr::new(o[2], o[3], o[4], o[5]))
            } else {
                None
            };
            if let Some(v4) = embedded {
                return blocked(IpAddr::V4(v4));
            }
            value.is_loopback()
                || value.is_unspecified()
                || value.is_multicast()
                || o[0] & 0xfe == 0xfc
                || (o[0] == 0xfe && o[1] & 0xc0 == 0x80)
                || (o[0] == 0xfe && o[1] & 0xc0 == 0xc0)
        }
    }
}

/// An allowlist entry is `*` (any host), an exact host name or IP address,
/// a `*.example.com` wildcard for subdomains, or an IP network in CIDR form.
fn allowed(policy: &WebhookPolicy, host: &str, address: Option<IpAddr>) -> bool {
    policy.allowed_hosts.iter().any(|raw| {
        let item = raw.trim().to_ascii_lowercase();
        let item = item.trim_end_matches('.');
        item == "*"
            || item == host
            || item.strip_prefix("*.").is_some_and(|suffix| {
                suffix.contains('.')
                    && !suffix.contains('*')
                    && suffix.split('.').all(|part| !part.is_empty())
                    && address.is_none()
                    && suffix.parse::<IpAddr>().is_err()
                    && host.ends_with(&format!(".{suffix}"))
            })
            || address.is_some_and(|address| {
                item.parse::<IpAddr>() == Ok(address)
                    || (item.contains('/')
                        && item
                            .parse::<IpNet>()
                            .is_ok_and(|network| network.contains(&address)))
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
    validate_target(map, &WebhookPolicy::from_settings(&state.settings))
}

pub(crate) fn validate_target(
    map: &Map<String, Value>,
    policy: &WebhookPolicy,
) -> Result<(), ApiError> {
    let url = map
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(invalid_payload)?;
    let parsed = url::Url::parse(url).map_err(|_| invalid_payload())?;
    let scheme_ok = if policy.require_https {
        parsed.scheme() == "https" && parsed.port_or_known_default() == Some(443)
    } else {
        matches!(parsed.scheme(), "http" | "https") && parsed.port_or_known_default().is_some()
    };
    let Some(host) = parsed.host_str() else {
        return Err(invalid_payload());
    };
    if !scheme_ok
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err(invalid_payload());
    }
    // host_str() keeps the brackets around IPv6 literals.
    let host = host
        .trim()
        .trim_end_matches('.')
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();
    let literal = host.parse::<IpAddr>().ok();
    if !allowed(policy, &host, literal)
        || (!policy.allow_private_targets
            && (matches!(host.as_str(), "metadata" | "metadata.google.internal")
                || host == "localhost"
                || host.ends_with(".localhost")
                || host.ends_with(".svc")
                || host.ends_with(".cluster.local")
                || literal.is_some_and(blocked)))
    {
        return Err(invalid_payload());
    }
    if map
        .get("api_key_name")
        .and_then(Value::as_str)
        .is_some_and(|value| !valid_header(value))
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn check(url: &str, policy: &WebhookPolicy) -> bool {
        let value = json!({ "url": url });
        validate_target(value.as_object().unwrap(), policy).is_ok()
    }
    fn strict(hosts: &[&str]) -> WebhookPolicy {
        WebhookPolicy {
            allow_private_targets: false,
            allowed_hosts: hosts.iter().map(|host| host.to_string()).collect(),
            require_https: true,
        }
    }

    #[test]
    fn requires_an_allowlisted_https_host() {
        let policy = strict(&["hooks.example.com", "*.example.org"]);
        assert!(check("https://hooks.example.com/a", &policy));
        assert!(check("https://a.example.org/a", &policy));
        assert!(!check("https://example.org/a", &policy));
        assert!(!check("http://hooks.example.com/a", &policy));
        assert!(!check("https://hooks.example.com:8443/a", &policy));
        assert!(!check("https://user:pass@hooks.example.com/a", &policy));
        assert!(!check("https://hooks.example.com/a#x", &policy));
        assert!(!check("https://other.example.com/a", &policy));
    }

    #[test]
    fn blocks_private_targets_even_when_listed() {
        let policy = strict(&[
            "127.0.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "::127.0.0.1",
            "64:ff9b::a00:1",
            "2002:a00:1::",
            "fec0::1",
            "localhost",
            "10.0.0.0/8",
        ]);
        for url in [
            "https://127.0.0.1/",
            "https://[::1]/",
            "https://[::ffff:127.0.0.1]/",
            "https://[::127.0.0.1]/",
            "https://[64:ff9b::a00:1]/",
            "https://[2002:a00:1::]/",
            "https://[fec0::1]/",
            "https://localhost/",
            "https://10.1.2.3/",
        ] {
            assert!(!check(url, &policy), "{url} must be blocked");
        }
        assert!(check(
            "https://93.184.216.34/",
            &strict(&["93.184.216.0/24"])
        ));
    }

    #[test]
    fn browser_policy_allows_local_receivers() {
        let policy = WebhookPolicy {
            allow_private_targets: true,
            allowed_hosts: vec!["*".into()],
            require_https: false,
        };
        assert!(check("http://localhost:8080/hook", &policy));
        assert!(check("http://[::1]:9000/", &policy));
        assert!(!check("ftp://localhost/", &policy));
    }

    #[test]
    fn rejects_unsafe_api_key_headers() {
        let policy = strict(&["hooks.example.com"]);
        let with = |extra: Value| {
            let mut value = json!({ "url": "https://hooks.example.com/" });
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            validate_target(value.as_object().unwrap(), &policy).is_ok()
        };
        assert!(with(
            json!({ "api_key_name": "X-Key", "api_key_value": "abc" })
        ));
        assert!(!with(json!({ "api_key_name": "Host" })));
        assert!(!with(json!({ "api_key_name": "X Key" })));
        assert!(!with(json!({ "api_key_value": "a\r\nInjected: 1" })));
    }
}
