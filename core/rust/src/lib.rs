pub mod api;
pub mod config;
pub mod db;
pub mod domain;
pub mod host;
pub mod http;
pub mod webhook_target;

pub fn now() -> time::OffsetDateTime {
    #[cfg(target_arch = "wasm32")]
    {
        time::OffsetDateTime::from_unix_timestamp_nanos((js_sys::Date::now() as i128) * 1_000_000)
            .expect("runtime clock")
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        time::OffsetDateTime::now_utc()
    }
}
