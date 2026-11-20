use core::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

/// UTF-8 JSON with recursively lexicographic object keys and no insignificant
/// whitespace. `serde_json`'s default map is ordered, so every constructor
/// converges on one byte representation.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CanonicalJson(Box<str>);

impl CanonicalJson {
    pub fn new(value: impl Serialize) -> Result<Self, CanonicalJsonError> {
        Self::from_value(serde_json::to_value(value)?)
    }

    pub fn from_value(value: Value) -> Result<Self, CanonicalJsonError> {
        Ok(Self(serde_json::to_string(&value)?.into_boxed_str()))
    }

    pub fn parse(input: &str) -> Result<Self, CanonicalJsonError> {
        Self::from_value(serde_json::from_str(input)?)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn to_value(&self) -> Value {
        // Construction guarantees valid JSON.
        serde_json::from_str(&self.0).expect("CanonicalJson invariant")
    }
}

impl fmt::Display for CanonicalJson {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for CanonicalJson {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_value().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for CanonicalJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Self::from_value(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug)]
pub struct CanonicalJsonError(serde_json::Error);

impl fmt::Display for CanonicalJsonError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid JSON: {}", self.0)
    }
}

impl std::error::Error for CanonicalJsonError {}

impl From<serde_json::Error> for CanonicalJsonError {
    fn from(error: serde_json::Error) -> Self {
        Self(error)
    }
}
