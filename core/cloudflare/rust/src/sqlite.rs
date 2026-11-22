//! TASM query bindings adapted for native SQLite in the owning Durable Object.
use crate::host::Host;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::marker::PhantomData;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

pub use tasm_core::db::transaction::{Connection, Pool, Transaction};
pub use tasm_core::host::Error;
pub struct Sqlite;
pub trait Executor<'a>: Send {
    type Database;
    fn host(&self) -> Host;
}
impl<'a> Executor<'a> for &Pool {
    type Database = Sqlite;
    fn host(&self) -> Host {
        self.0.clone()
    }
}
impl<'a> Executor<'a> for &mut Connection {
    type Database = Sqlite;
    fn host(&self) -> Host {
        self.0.clone()
    }
}

pub trait Bind {
    fn value(&self) -> Value;
}
macro_rules! scalar { ($($t:ty),+) => { $(impl Bind for $t { fn value(&self) -> Value { json!(self) } })+ }; }
scalar!(str, String, i32, u32, f64, Uuid);
impl Bind for bool {
    fn value(&self) -> Value {
        json!(i32::from(*self))
    }
}
impl Bind for i64 {
    fn value(&self) -> Value {
        json!(self.to_string())
    }
}
/// Fixed-width, sign-biased decimal text preserves ordering and all 128 bits.
pub fn range_key(value: i128) -> String {
    format!("{:039}", (value as u128) ^ (1_u128 << 127))
}
impl Bind for i128 {
    fn value(&self) -> Value {
        json!(range_key(*self))
    }
}
impl Bind for OffsetDateTime {
    fn value(&self) -> Value {
        let value = self.to_offset(time::UtcOffset::UTC);
        json!(format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:09}Z",
            value.year(),
            u8::from(value.month()),
            value.day(),
            value.hour(),
            value.minute(),
            value.second(),
            value.nanosecond()
        ))
    }
}
impl<T: Bind + ?Sized> Bind for &T {
    fn value(&self) -> Value {
        T::value(self)
    }
}
impl<T: Bind> Bind for Option<T> {
    fn value(&self) -> Value {
        self.as_ref().map_or(Value::Null, Bind::value)
    }
}
impl<T: Bind> Bind for [T] {
    fn value(&self) -> Value {
        json!(
            serde_json::to_string(&self.iter().map(Bind::value).collect::<Vec<_>>())
                .expect("JSON array")
        )
    }
}
impl<T: Bind> Bind for Vec<T> {
    fn value(&self) -> Value {
        self.as_slice().value()
    }
}
pub mod types {
    pub struct Json<T>(pub T);
}
impl<T: Serialize> Bind for types::Json<T> {
    fn value(&self) -> Value {
        json!(serde_json::to_string(&self.0).expect("JSON value"))
    }
}

pub trait Decode: Sized {
    fn decode(value: &Value) -> Result<Self, Error>;
}
macro_rules! decode { ($($t:ty),+) => { $(impl Decode for $t { fn decode(value: &Value) -> Result<Self, Error> { serde_json::from_value(value.clone()).map_err(|e| Error(e.to_string())) } })+ }; }
decode!(String, Value, Uuid, f64);
impl Decode for bool {
    fn decode(value: &Value) -> Result<Self, Error> {
        match value.as_i64() {
            Some(0) => Ok(false),
            Some(1) => Ok(true),
            _ => Err(Error("invalid boolean column".into())),
        }
    }
}
impl Decode for i128 {
    fn decode(value: &Value) -> Result<Self, Error> {
        value
            .as_str()
            .and_then(|v| v.parse::<u128>().ok())
            .map(|v| (v ^ (1_u128 << 127)) as i128)
            .ok_or_else(|| Error("invalid timestamp column".into()))
    }
}
impl Decode for i64 {
    fn decode(value: &Value) -> Result<Self, Error> {
        value
            .as_i64()
            .or_else(|| value.as_str().and_then(|v| v.parse().ok()))
            .ok_or_else(|| Error("invalid integer column".into()))
    }
}
impl Decode for i32 {
    fn decode(value: &Value) -> Result<Self, Error> {
        i64::decode(value)?
            .try_into()
            .map_err(|_| Error("integer out of range".into()))
    }
}
impl Decode for OffsetDateTime {
    fn decode(value: &Value) -> Result<Self, Error> {
        OffsetDateTime::parse(value.as_str().unwrap_or(""), &Rfc3339)
            .map_err(|e| Error(e.to_string()))
    }
}
impl<T: Decode> Decode for Option<T> {
    fn decode(value: &Value) -> Result<Self, Error> {
        if value.is_null() {
            Ok(None)
        } else {
            T::decode(value).map(Some)
        }
    }
}
impl<T: Decode> Decode for Vec<T> {
    fn decode(value: &Value) -> Result<Self, Error> {
        let values: Vec<Value> =
            serde_json::from_str(value.as_str().unwrap_or("")).map_err(|e| Error(e.to_string()))?;
        values.iter().map(T::decode).collect()
    }
}
impl<T: DeserializeOwned> Decode for types::Json<T> {
    fn decode(value: &Value) -> Result<Self, Error> {
        serde_json::from_str(
            value
                .as_str()
                .ok_or_else(|| Error("expected JSON column".into()))?,
        )
        .map(Self)
        .map_err(|e| Error(e.to_string()))
    }
}
#[derive(Clone)]
pub struct SqliteRow(pub Vec<Value>);
pub trait Row {
    fn try_get<T: Decode, I: TryInto<usize>>(&self, index: I) -> Result<T, Error>;
}
impl Row for SqliteRow {
    fn try_get<T: Decode, I: TryInto<usize>>(&self, index: I) -> Result<T, Error> {
        T::decode(
            self.0
                .get(
                    index
                        .try_into()
                        .map_err(|_| Error("invalid column index".into()))?,
                )
                .ok_or_else(|| Error("missing column".into()))?,
        )
    }
}
#[derive(Clone)]
pub struct Query {
    sql: String,
    params: Vec<Value>,
}
pub fn query(sql: &str) -> Query {
    Query {
        sql: sql.into(),
        params: vec![],
    }
}
pub struct QueryResult(u64);
impl QueryResult {
    pub fn rows_affected(&self) -> u64 {
        self.0
    }
}
impl Query {
    pub fn bind<T: Bind>(mut self, value: T) -> Self {
        self.params.push(value.value());
        self
    }
    async fn run(self, host: Host) -> Result<Value, Error> {
        host.call("sql", json!({"sql":self.sql,"params":self.params}))
            .await
    }
    pub async fn execute<'a, E: Executor<'a>>(self, executor: E) -> Result<QueryResult, Error> {
        Ok(QueryResult(
            self.run(executor.host()).await?["affectedRows"]
                .as_u64()
                .unwrap_or(0),
        ))
    }
    pub async fn fetch_all<'a, E: Executor<'a>>(
        self,
        executor: E,
    ) -> Result<Vec<SqliteRow>, Error> {
        let result = self.run(executor.host()).await?;
        let rows = crate::host::rows(result)?;
        Ok(rows.into_iter().map(SqliteRow).collect())
    }
    pub async fn fetch_optional<'a, E: Executor<'a>>(
        self,
        executor: E,
    ) -> Result<Option<SqliteRow>, Error> {
        Ok(self.fetch_all(executor).await?.into_iter().next())
    }
    pub async fn fetch_one<'a, E: Executor<'a>>(self, executor: E) -> Result<SqliteRow, Error> {
        self.fetch_optional(executor)
            .await?
            .ok_or_else(|| Error("row not found".into()))
    }
}
pub struct Scalar<T>(Query, PhantomData<T>);
pub fn query_scalar<T: Decode>(sql: &str) -> Scalar<T> {
    Scalar(query(sql), PhantomData)
}
impl<T: Decode> Scalar<T> {
    pub fn bind<B: Bind>(self, value: B) -> Self {
        Self(self.0.bind(value), PhantomData)
    }
    pub async fn fetch_one<'a, E: Executor<'a>>(self, executor: E) -> Result<T, Error> {
        self.0.fetch_one(executor).await?.try_get(0)
    }
    pub async fn fetch_all<'a, E: Executor<'a>>(self, executor: E) -> Result<Vec<T>, Error> {
        self.0
            .fetch_all(executor)
            .await?
            .iter()
            .map(|r| r.try_get(0))
            .collect()
    }
}
pub struct QueryBuilder<'a, D>(Query, PhantomData<&'a D>);
impl<D> QueryBuilder<'_, D> {
    pub fn new(sql: &str) -> Self {
        Self(query(sql), PhantomData)
    }
    pub fn push(&mut self, sql: impl std::fmt::Display) -> &mut Self {
        self.0.sql.push_str(&sql.to_string());
        self
    }
    pub fn push_bind<B: Bind>(&mut self, value: B) -> &mut Self {
        self.0.params.push(value.value());
        self.push(format!("?{}", self.0.params.len()))
    }
    pub fn build(&mut self) -> Query {
        self.0.clone()
    }
}

pub use {Sqlite as Engine, SqliteRow as RecordRow};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timestamp_keys_are_exact_and_sort_numerically() {
        let values = [
            i128::MIN,
            -9007199254740993,
            -1,
            0,
            1,
            9007199254740993,
            i128::MAX,
        ];
        let keys: Vec<_> = values.iter().map(|v| v.value()).collect();
        for (value, key) in values.iter().zip(&keys) {
            assert_eq!(*value, i128::decode(key).unwrap());
        }
        assert!(keys.windows(2).all(|w| w[0].as_str() < w[1].as_str()));
    }
}
