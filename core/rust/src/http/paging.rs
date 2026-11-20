// TASM browser adaptation of rust-tams-api (Apache-2.0); see NOTICE for changes.
use axum::http::{HeaderMap, HeaderValue, Uri, header::HOST};

use super::error::ApiError;

pub fn page_headers(
    headers: &mut HeaderMap,
    uri: &Uri,
    request_headers: &HeaderMap,
    limit: usize,
    count: usize,
    next_page: Option<&str>,
    reverse_order: Option<bool>,
) -> Result<(), ApiError> {
    insert(headers, "x-paging-limit", &limit.to_string())?;
    insert(headers, "x-paging-count", &count.to_string())?;
    if let Some(reverse) = reverse_order {
        insert(
            headers,
            "x-paging-reverse-order",
            if reverse { "true" } else { "false" },
        )?;
    }
    if let Some(next) = next_page {
        insert(headers, "x-paging-nextkey", next)?;
        let url = replace_query_value(&absolute_request_url(uri, request_headers)?, "page", next);
        insert(headers, "link", &format!("<{url}>; rel=\"next\""))?;
    }
    Ok(())
}

pub fn absolute_request_url(uri: &Uri, headers: &HeaderMap) -> Result<String, ApiError> {
    let forwarded_scheme = headers
        .get_all("x-forwarded-proto")
        .iter()
        .next_back()
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| matches!(*value, "http" | "https"));
    let scheme = forwarded_scheme
        .or_else(|| uri.scheme_str())
        .unwrap_or("http");
    let authority = uri
        .authority()
        .map(|value| value.as_str())
        .or_else(|| headers.get(HOST).and_then(|value| value.to_str().ok()))
        .ok_or_else(|| ApiError::bad_request("Invalid request origin."))?;
    Ok(format!(
        "{scheme}://{authority}{}",
        uri.path_and_query().map_or("/", |value| value.as_str())
    ))
}

pub fn origin(uri: &Uri, headers: &HeaderMap) -> Result<String, ApiError> {
    let absolute = absolute_request_url(uri, headers)?;
    let parsed =
        url::Url::parse(&absolute).map_err(|_| ApiError::bad_request("Invalid request origin."))?;
    Ok(parsed.origin().ascii_serialization())
}

fn replace_query_value(url: &str, name: &str, value: &str) -> String {
    let Ok(mut url) = url::Url::parse(url) else {
        return url.to_owned();
    };
    let pairs: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key != name)
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    url.query_pairs_mut()
        .clear()
        .extend_pairs(pairs)
        .append_pair(name, value);
    url.into()
}

fn insert(headers: &mut HeaderMap, name: &'static str, value: &str) -> Result<(), ApiError> {
    headers.insert(
        name,
        HeaderValue::from_str(value).map_err(|_| ApiError::internal(&"invalid response header"))?,
    );
    Ok(())
}
