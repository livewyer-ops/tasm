use tasm_cloudflare::{
    canonical::CanonicalJson,
    domain::{segment, timerange},
    http::query::QueryParams,
};

#[test]
fn raw_media_metadata_enforces_bbc_requirements() {
    use serde_json::json;
    use tasm_cloudflare::domain::flow::validate_direct;
    let mut audio = json!({"format":"urn:x-nmos:format:audio","codec":"audio/x-raw-float","essence_parameters":{"sample_rate":48000,"channels":2,"unc_parameters":{"unc_type":"interleaved"}}});
    assert!(validate_direct(audio.as_object().unwrap()).is_err());
    audio["essence_parameters"]["bit_depth"] = json!(24);
    assert!(validate_direct(audio.as_object().unwrap()).is_err());
    audio["essence_parameters"]["bit_depth"] = json!(32);
    assert!(validate_direct(audio.as_object().unwrap()).is_ok());
    audio["essence_parameters"]["unc_parameters"] = json!({});
    assert!(validate_direct(audio.as_object().unwrap()).is_err());
    let mut video = json!({"format":"urn:x-nmos:format:video","codec":"video/raw","essence_parameters":{"frame_width":1920,"frame_height":1080,"frame_rate":{"numerator":25},"bit_depth":10,"unc_parameters":{"unc_type":"v210"}}});
    assert!(validate_direct(video.as_object().unwrap()).is_err());
    video["essence_parameters"]["horiz_chroma_subs"] = json!(2);
    video["essence_parameters"]["vert_chroma_subs"] = json!(1);
    assert!(validate_direct(video.as_object().unwrap()).is_ok());
}

#[test]
fn precise_timestamps_ranges_and_query_identity() {
    for (text, expected) in [
        ("-0:1", -1),
        ("-1:5", -1_000_000_005),
        ("281474976710655:999999999", 281474976710655999999999),
    ] {
        let point = timerange::parse(&format!("[{text}]")).unwrap();
        assert_eq!(point.start, Some(expected));
        assert_eq!(timerange::format_timestamp(expected), text);
    }
    assert!(timerange::parse("_").unwrap().start.is_none());
    assert!(timerange::parse("()").unwrap().empty);
    assert!(segment::bounds("[1:0_0:0)").is_err());
    assert_eq!(timerange::parse("(0:0_").unwrap().start, Some(1));
    assert_eq!(timerange::parse("_1:0]").unwrap().end, Some(1_000_000_001));
    assert_eq!(
        timerange::parse("[0:1]").unwrap(),
        timerange::parse("[0:1_0:1]").unwrap()
    );
    for invalid in [
        "[00:1]",
        "[1:1000000000]",
        "[+1:0]",
        "[1:01]",
        "[1:0_2:0_3:0)",
    ] {
        assert!(timerange::parse(invalid).is_err(), "{invalid}");
    }
    assert_eq!(
        segment::effective_object_timerange("[-0:5_0:5)", Some("-0:10"), None).unwrap(),
        "[0:5_0:15)"
    );
    let query = QueryParams::parse(Some("tag.%252F=%2520&tag.space=+&tag.plus=%2B"));
    assert_eq!(query.last("tag.%2F"), Some("%20"));
    assert_eq!(query.last("tag.space"), Some(" "));
    assert_eq!(query.last("tag.plus"), Some("+"));
    let path = "/objects/a%252F%20%26%2B/instances";
    assert_eq!(
        tasm_cloudflare::http::routes::objects::classify(&axum::http::Method::POST, path)
            .unwrap()
            .object_id,
        "a%2F &+"
    );
    assert_eq!(
        tasm_cloudflare::http::lenient_decode_path("/objects/a&b+c"),
        "/objects/a&b+c"
    );
    assert_eq!(
        CanonicalJson::parse("{\"z\":1,\"a\":2}").unwrap().as_str(),
        "{\"a\":2,\"z\":1}"
    );
}
