//! Parameterised PGlite queries for the reused PostgreSQL repository.
//! No database protocol, connection pool or SQL execution is implemented here.
use crate::host::Host;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::marker::PhantomData;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

pub use tasm_core::host::Error;

pub use tasm_core::db::transaction::{Connection, Pool, Transaction};
pub struct Postgres;
pub trait Executor<'a>: Send {
    type Database;
    fn host(&self) -> Host;
}
impl<'a> Executor<'a> for &Pool {
    type Database = Postgres;
    fn host(&self) -> Host {
        self.0.clone()
    }
}
impl<'a> Executor<'a> for &mut Connection {
    type Database = Postgres;
    fn host(&self) -> Host {
        self.0.clone()
    }
}

pub trait Bind {
    fn pg_type() -> String;
    fn value(&self) -> Value;
}
macro_rules! scalar {
    ($t:ty, $pg:literal) => {
        impl Bind for $t {
            fn pg_type() -> String {
                $pg.into()
            }
            fn value(&self) -> Value {
                json!(self)
            }
        }
    };
}
scalar!(str, "text");
scalar!(String, "text");
scalar!(bool, "bool");
scalar!(i32, "int4");
scalar!(u32, "int8");
scalar!(f64, "float8");
impl Bind for i64 {
    fn pg_type() -> String {
        "int8".into()
    }
    fn value(&self) -> Value {
        json!(self.to_string())
    }
}
impl Bind for i128 {
    fn pg_type() -> String {
        "numeric".into()
    }
    fn value(&self) -> Value {
        json!(self.to_string())
    }
}
impl Decode for i128 {
    fn decode(v: &Value) -> Result<Self, Error> {
        v.as_str()
            .and_then(|v| v.parse().ok())
            .or_else(|| v.as_i64().map(i128::from))
            .ok_or_else(|| Error("invalid numeric timestamp".into()))
    }
}
impl Bind for Uuid {
    fn pg_type() -> String {
        "uuid".into()
    }
    fn value(&self) -> Value {
        json!(self.to_string())
    }
}
impl Bind for OffsetDateTime {
    fn pg_type() -> String {
        "timestamptz".into()
    }
    fn value(&self) -> Value {
        json!(self.format(&Rfc3339).expect("valid date"))
    }
}
impl<T: Bind + ?Sized> Bind for &T {
    fn pg_type() -> String {
        T::pg_type()
    }
    fn value(&self) -> Value {
        T::value(self)
    }
}
impl<T: Bind> Bind for Option<T> {
    fn pg_type() -> String {
        T::pg_type()
    }
    fn value(&self) -> Value {
        self.as_ref().map_or(Value::Null, Bind::value)
    }
}
impl<T: Bind> Bind for [T] {
    fn pg_type() -> String {
        format!("{}[]", T::pg_type())
    }
    fn value(&self) -> Value {
        Value::Array(self.iter().map(Bind::value).collect())
    }
}
impl<T: Bind> Bind for Vec<T> {
    fn pg_type() -> String {
        <[T]>::pg_type()
    }
    fn value(&self) -> Value {
        self.as_slice().value()
    }
}
pub mod types {
    pub struct Json<T>(pub T);
}
impl<T: Serialize> Bind for types::Json<T> {
    fn pg_type() -> String {
        "jsonb".into()
    }
    fn value(&self) -> Value {
        json!(serde_json::to_string(&self.0).expect("JSON value"))
    }
}

pub trait Decode: Sized {
    fn decode(value: &Value) -> Result<Self, Error>;
}
macro_rules! decode {
    ($($t:ty),+) => { $(impl Decode for $t {
        fn decode(value: &Value) -> Result<Self, Error> {
            serde_json::from_value(value.clone()).map_err(|e| Error(e.to_string()))
        }
    })+ };
}
decode!(String, bool, Value, Uuid, f64);
impl Decode for i64 {
    fn decode(v: &Value) -> Result<Self, Error> {
        v.as_i64()
            .or_else(|| v.as_str().and_then(|v| v.parse().ok()))
            .ok_or_else(|| Error("invalid integer column".into()))
    }
}
impl Decode for i32 {
    fn decode(v: &Value) -> Result<Self, Error> {
        i64::decode(v)?
            .try_into()
            .map_err(|_| Error("integer out of range".into()))
    }
}
impl Decode for OffsetDateTime {
    fn decode(v: &Value) -> Result<Self, Error> {
        OffsetDateTime::parse(v.as_str().unwrap_or(""), &Rfc3339).map_err(|e| Error(e.to_string()))
    }
}
impl<T: Decode> Decode for Option<T> {
    fn decode(v: &Value) -> Result<Self, Error> {
        if v.is_null() {
            Ok(None)
        } else {
            T::decode(v).map(Some)
        }
    }
}
impl<T: Decode> Decode for Vec<T> {
    fn decode(v: &Value) -> Result<Self, Error> {
        v.as_array()
            .ok_or_else(|| Error("expected array".into()))?
            .iter()
            .map(T::decode)
            .collect()
    }
}
impl<T: DeserializeOwned> Decode for types::Json<T> {
    fn decode(v: &Value) -> Result<Self, Error> {
        serde_json::from_str(
            v.as_str()
                .ok_or_else(|| Error("expected JSON column text".into()))?,
        )
        .map(Self)
        .map_err(|e| Error(e.to_string()))
    }
}
pub mod postgres {
    #[derive(Clone)]
    pub struct PgRow(pub Vec<serde_json::Value>);
}
pub trait Row {
    fn try_get<T: Decode, I: TryInto<usize>>(&self, index: I) -> Result<T, Error>;
    fn get<T: Decode, I: TryInto<usize>>(&self, index: I) -> T {
        self.try_get(index).expect("typed database column")
    }
}
impl Row for postgres::PgRow {
    fn try_get<T: Decode, I: TryInto<usize>>(&self, index: I) -> Result<T, Error> {
        let i = index
            .try_into()
            .map_err(|_| Error("invalid column index".into()))?;
        T::decode(
            self.0
                .get(i)
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
        self.params
            .push(json!({"type": T::pg_type(), "value": value.value()}));
        self
    }
    async fn run<'a, E: Executor<'a>>(self, e: E) -> Result<Value, Error> {
        e.host()
            .call("sql", json!({"sql": self.sql, "params": self.params}))
            .await
    }
    pub async fn execute<'a, E: Executor<'a>>(self, e: E) -> Result<QueryResult, Error> {
        Ok(QueryResult(
            self.run(e).await?["affectedRows"].as_u64().unwrap_or(0),
        ))
    }
    pub async fn fetch_all<'a, E: Executor<'a>>(self, e: E) -> Result<Vec<postgres::PgRow>, Error> {
        let result = self.run(e).await?;
        let rows = crate::host::rows(result)?;
        Ok(rows.into_iter().map(postgres::PgRow).collect())
    }
    pub async fn fetch_optional<'a, E: Executor<'a>>(
        self,
        e: E,
    ) -> Result<Option<postgres::PgRow>, Error> {
        Ok(self.fetch_all(e).await?.into_iter().next())
    }
    pub async fn fetch_one<'a, E: Executor<'a>>(self, e: E) -> Result<postgres::PgRow, Error> {
        self.fetch_optional(e)
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
    pub async fn fetch_one<'a, E: Executor<'a>>(self, e: E) -> Result<T, Error> {
        self.0.fetch_one(e).await?.try_get(0)
    }
    pub async fn fetch_all<'a, E: Executor<'a>>(self, e: E) -> Result<Vec<T>, Error> {
        self.0
            .fetch_all(e)
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
        self.0
            .params
            .push(json!({"type": B::pg_type(), "value": value.value()}));
        self.push(format!("${}", self.0.params.len()))
    }
    pub fn build(&mut self) -> Query {
        self.0.clone()
    }
}

pub use {Postgres as Engine, postgres::PgRow as RecordRow};
