// TASM browser adaptation of rust-tams-api (Apache-2.0); see NOTICE for changes.
use std::collections::{BTreeMap, BTreeSet};

use uuid::Uuid;

use super::error::ApiError;

pub const TAG_PREFIXES: [&str; 6] = [
    "tag.",
    "tag_exists.",
    "flow_tag.",
    "flow_tag_exists.",
    "storage_backend_tag.",
    "storage_backend_tag_exists.",
];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct QueryParams {
    pairs: Vec<(String, String)>,
}

impl QueryParams {
    pub fn parse(raw: Option<&str>) -> Self {
        Self {
            pairs: raw
                .map(|query| {
                    url::form_urlencoded::parse(query.as_bytes())
                        .map(|(key, value)| (key.into_owned(), value.into_owned()))
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    pub fn validate(&self, allowed: &[&str], allowed_prefixes: &[&str]) -> Result<(), ApiError> {
        for (key, _) in &self.pairs {
            if key == "access_token"
                || allowed.contains(&key.as_str())
                || allowed_prefixes
                    .iter()
                    .any(|prefix| key.starts_with(prefix))
            {
                continue;
            }
            return Err(invalid_query());
        }
        Ok(())
    }

    pub fn all(&self) -> &[(String, String)] {
        &self.pairs
    }

    pub fn last(&self, name: &str) -> Option<&str> {
        self.pairs
            .iter()
            .rev()
            .find_map(|(key, value)| (key == name).then_some(value.as_str()))
    }

    pub fn last_values(&self) -> BTreeMap<&str, &str> {
        self.pairs
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect()
    }

    pub fn access_token(&self) -> Option<&str> {
        self.last("access_token")
    }

    pub fn bool(&self, name: &str) -> Result<Option<bool>, ApiError> {
        self.last(name).map(parse_bool).transpose()
    }

    pub fn integer(&self, name: &str) -> Result<Option<i64>, ApiError> {
        self.last(name)
            .map(|value| value.parse().map_err(|_| invalid_query()))
            .transpose()
    }

    pub fn uuid(&self, name: &str) -> Result<Option<Uuid>, ApiError> {
        self.last(name)
            .map(|value| value.parse().map_err(|_| invalid_query()))
            .transpose()
    }

    pub fn uuid_set(&self, name: &str) -> Result<Option<BTreeSet<Uuid>>, ApiError> {
        let Some(value) = self.last(name) else {
            return Ok(None);
        };
        if value.is_empty() {
            return Ok(None);
        }
        value
            .split(',')
            .map(|part| part.parse().map_err(|_| invalid_query()))
            .collect::<Result<_, _>>()
            .map(Some)
    }

    pub fn csv_set(&self, name: &str) -> Result<Option<BTreeSet<String>>, ApiError> {
        self.last(name).map(parse_csv_set).transpose()
    }

    pub fn dynamic_csv(
        &self,
        prefix: &str,
    ) -> Result<BTreeMap<String, BTreeSet<String>>, ApiError> {
        self.dynamic(prefix, parse_csv_set)
    }

    pub fn dynamic_bool(&self, prefix: &str) -> Result<BTreeMap<String, bool>, ApiError> {
        self.dynamic(prefix, parse_bool)
    }

    fn dynamic<T>(
        &self,
        prefix: &str,
        parse: impl Fn(&str) -> Result<T, ApiError>,
    ) -> Result<BTreeMap<String, T>, ApiError> {
        self.last_values()
            .into_iter()
            .filter_map(|(key, value)| key.strip_prefix(prefix).map(|name| (name, value)))
            .map(|(name, value)| Ok((name.to_owned(), parse(value)?)))
            .collect()
    }
}

pub fn parse_bool(value: &str) -> Result<bool, ApiError> {
    if value.eq_ignore_ascii_case("true") {
        Ok(true)
    } else if value.eq_ignore_ascii_case("false") {
        Ok(false)
    } else {
        Err(invalid_query())
    }
}

pub fn parse_csv_set(value: &str) -> Result<BTreeSet<String>, ApiError> {
    if value.is_empty() {
        return Ok(BTreeSet::new());
    }
    let values: BTreeSet<_> = value.split(',').map(str::to_owned).collect();
    if values.iter().any(String::is_empty) {
        Err(invalid_query())
    } else {
        Ok(values)
    }
}

pub fn invalid_query() -> ApiError {
    ApiError::bad_request("Bad request. Invalid query options.")
}
