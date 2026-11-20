#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct Error(pub String);
use js_sys::{Function, Promise};
use serde_json::Value;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[derive(Clone)]
pub struct Host(send_wrapper::SendWrapper<Function>);

impl Host {
    pub fn new(function: Function) -> Self {
        Self(send_wrapper::SendWrapper::new(function))
    }

    pub fn call(
        &self,
        operation: &str,
        payload: Value,
    ) -> impl Future<Output = Result<Value, Error>> + Send + use<> {
        let result = self.0.call2(
            &JsValue::NULL,
            &operation.into(),
            &payload.to_string().into(),
        );
        send_wrapper::SendWrapper::new(async move {
            let value = JsFuture::from(Promise::resolve(&result.map_err(js_error)?))
                .await
                .map_err(js_error)?;
            serde_json::from_str(value.as_string().as_deref().unwrap_or("null"))
                .map_err(|e| Error(e.to_string()))
        })
    }

    pub fn fire(&self, operation: &str, payload: Value) {
        let _ = self.0.call2(
            &JsValue::NULL,
            &operation.into(),
            &payload.to_string().into(),
        );
    }
}

fn js_error(_: JsValue) -> Error {
    Error("Storage operation failed".into())
}
