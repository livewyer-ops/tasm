pub use tasm_core::{domain, now};
pub mod config;
pub mod db;
use tasm_core::host;
pub mod http;
pub mod sqlite;
#[path = "../../../rust/src/storage.rs"]
pub mod storage;
#[path = "../../../rust/src/webhooks.rs"]
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
    host: host::Host,
    router: Router,
    worker: worker::Worker,
    #[wasm_bindgen(readonly, js_name = queueRetentionSeconds)]
    pub queue_retention_seconds: u64,
}
#[wasm_bindgen]
impl Tasm {
    #[wasm_bindgen(constructor)]
    pub fn new(bridge: js_sys::Function, configuration: String) -> Result<Tasm, JsValue> {
        let pool = sql::Pool(host::Host::new(bridge));
        let settings =
            Arc::new(serde_json::from_str::<config::Settings>(&configuration).map_err(js_error)?);
        Ok(Self {
            host: pool.0.clone(),
            router: http::router(pool.clone(), settings.clone()),
            queue_retention_seconds: settings.worker_queue_retention_seconds,
            worker: worker::Worker::new(pool, settings),
        })
    }
    #[wasm_bindgen(getter, js_name = allocationLifetimeSeconds)]
    pub fn allocation_lifetime_seconds(&self) -> u64 {
        self.worker.allocation_lifetime_seconds()
    }
    #[wasm_bindgen(getter, js_name = signedUrlLifetimeSeconds)]
    pub fn signed_url_lifetime_seconds(&self) -> u32 {
        domain::object::MIN_SIGNED_URL_SECONDS + domain::object::STORAGE_GRACE_SECONDS
    }
    #[wasm_bindgen(getter, js_name = storageGraceSeconds)]
    pub fn storage_grace_seconds(&self) -> u32 {
        domain::object::STORAGE_GRACE_SECONDS
    }
    pub async fn request(&self, request_json: String) -> Result<String, JsValue> {
        self.host
            .guard(api::request::<Identity>(&self.router, request_json))
            .await
    }
    pub async fn poll(&self) -> Result<u64, JsValue> {
        self.host
            .guard(self.worker.poll_once())
            .await
            .map_err(js_error)
    }
}

pub use sqlite as sql;

#[path = "../../../rust/src/webhook_target.rs"]
mod webhook_target;
