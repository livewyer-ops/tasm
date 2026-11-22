#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct Error(pub String);
use js_sys::{Function, Promise};
use serde_json::Value;
use std::{cell::RefCell, future::poll_fn, sync::Once};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[derive(Clone)]
pub struct Host(send_wrapper::SendWrapper<Function>);

thread_local! {
    static ACTIVE: RefCell<Option<Host>> = const { RefCell::new(None) };
}

impl Host {
    pub fn new(function: Function) -> Self {
        static HOOK: Once = Once::new();
        HOOK.call_once(|| {
            std::panic::set_hook(Box::new(|_| {
                if let Some(host) = ACTIVE.take() {
                    host.fire("fatal", Value::Null);
                }
            }))
        });
        Self(send_wrapper::SendWrapper::new(function))
    }

    // Several Durable Objects can share a Wasm module. Attribute a trap to the
    // host whose future is being polled, including after an asynchronous wake.
    pub async fn guard<T>(&self, work: impl Future<Output = T>) -> T {
        let mut work = std::pin::pin!(work);
        poll_fn(|cx| {
            let previous = ACTIVE.replace(Some(self.clone()));
            let result = work.as_mut().poll(cx);
            ACTIVE.replace(previous);
            result
        })
        .await
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
            let json = value
                .as_string()
                .ok_or_else(|| Error("Host response must be a JSON string".into()))?;
            serde_json::from_str(&json).map_err(|e| Error(e.to_string()))
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

/// Decodes the owned SQL result without copying the host's rows.
pub fn rows(result: Value) -> Result<Vec<Vec<Value>>, Error> {
    #[derive(serde::Deserialize)]
    struct ResultSet {
        rows: Vec<Vec<Value>>,
    }
    serde_json::from_value::<ResultSet>(result)
        .map(|result| result.rows)
        .map_err(|e| Error(e.to_string()))
}

fn js_error(_: JsValue) -> Error {
    Error("Storage operation failed".into())
}

/// Keep input, credentials and backend error messages out of operator logs.
pub fn incident(stage: &'static str, category: &'static str) -> uuid::Uuid {
    let id = uuid::Uuid::new_v4();
    let event = serde_json::json!({"stage":stage,"category":category,"incident_id":id});
    #[cfg(target_arch = "wasm32")]
    {
        #[wasm_bindgen]
        extern "C" {
            #[wasm_bindgen(js_namespace=console, js_name=error)]
            fn log(event: &str);
        }
        log(&event.to_string());
    }
    #[cfg(not(target_arch = "wasm32"))]
    eprintln!("{event}");
    id
}
