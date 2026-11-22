#[test]
fn object_instance_paths_decode_once() {
    let path = "/objects/a%252F%20%26%2B/instances";
    assert_eq!(
        tasm_browser::http::routes::objects::classify(&axum::http::Method::POST, path)
            .unwrap()
            .object_id,
        "a%2F &+"
    );
}
