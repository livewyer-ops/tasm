pub use tasm_core::{canonical, domain, now};
pub mod config;
pub mod db;
use tasm_core::host;
pub mod http;
pub mod sqlite;
#[path = "../../../rust/src/storage.rs"]
pub mod storage;
pub mod webhooks;
#[path = "../../../rust/src/worker.rs"]
pub mod worker;

use axum::Router;
use serde::Deserialize;
use std::sync::Arc;
pub use tasm_core::api::Actor;
use tasm_core::api::{self, RequestIdentity, js_error};
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
struct Identity {
    actor: Actor,
}
impl RequestIdentity for Identity {
    fn actor(self) -> Actor {
        self.actor
    }
}
#[wasm_bindgen]
pub struct Tasm {
    router: Router,
    worker: worker::Worker,
}
#[wasm_bindgen]
impl Tasm {
    #[wasm_bindgen(constructor)]
    pub fn new(bridge: js_sys::Function, configuration: String) -> Result<Tasm, JsValue> {
        let database = db::Database(host::Host::new(bridge));
        let settings =
            Arc::new(serde_json::from_str::<config::Settings>(&configuration).map_err(js_error)?);
        Ok(Self {
            router: http::router(database.clone(), settings.clone()),
            worker: worker::Worker::new(database, settings),
        })
    }
    pub async fn request(&self, request_json: String) -> Result<String, JsValue> {
        api::request::<Identity>(&self.router, request_json).await
    }
    pub async fn poll(&self) -> Result<u64, JsValue> {
        self.worker.poll_once().await.map_err(js_error)
    }
}

pub use sqlite as sql;

mod webhook_target;
