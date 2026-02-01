//! WASM entry point for codeview-rustdoc graph extraction.
//!
//! Exposes `extract_graph` and `extract_graph_with_sources` to JavaScript
//! via wasm-bindgen.
//!
//! Build with: `wasm-pack build --target web --features wasm --no-default-features`

#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

#[cfg(feature = "wasm")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = log)]
    fn console_log(s: &str);
}

#[cfg(feature = "wasm")]
macro_rules! wasm_log {
    ($($arg:tt)*) => { console_log(&format!($($arg)*)) };
}

/// Pre-grow WASM linear memory in one shot to avoid repeated resizing.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn ensure_capacity(bytes: usize) {
    let _v: Vec<u8> = Vec::with_capacity(bytes);
}

/// Extract a crate graph from rustdoc JSON (no source files — no call edges).
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn extract_graph(json: &[u8], crate_name: &str) -> Result<String, JsValue> {
    let json_str =
        std::str::from_utf8(json).map_err(|e| JsValue::from_str(&format!("invalid UTF-8: {e}")))?;

    wasm_log!("[wasm] extract_graph: {} bytes", json_str.len());
    let t0 = js_sys::Date::now();

    let graph = crate::extract_graph(json_str, crate_name)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let t1 = js_sys::Date::now();
    wasm_log!(
        "[wasm] graph built: {} nodes, {} edges, {:.0}ms",
        graph.nodes.len(),
        graph.edges.len(),
        t1 - t0
    );

    let result = serde_json::to_string(&graph).map_err(|e| JsValue::from_str(&e.to_string()))?;

    wasm_log!("[wasm] serialized: {:.0}ms", js_sys::Date::now() - t1);
    Ok(result)
}

/// Extract a crate graph with call edges from in-memory source files.
///
/// `source_files_json` is a JSON object mapping file paths to source content,
/// e.g. `{"src/lib.rs": "fn main() { ... }", "src/utils.rs": "..."}`.
/// `root_file` is the entry point (e.g. "src/lib.rs").
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn extract_graph_with_sources(
    json: &[u8],
    crate_name: &str,
    source_files_json: &[u8],
    root_file: &str,
) -> Result<String, JsValue> {
    let json_str =
        std::str::from_utf8(json).map_err(|e| JsValue::from_str(&format!("invalid UTF-8: {e}")))?;
    let source_files_str = std::str::from_utf8(source_files_json)
        .map_err(|e| JsValue::from_str(&format!("invalid source UTF-8: {e}")))?;

    wasm_log!(
        "[wasm] extract_graph_with_sources: {} bytes rustdoc, {} bytes sources",
        json_str.len(),
        source_files_str.len()
    );
    let t0 = js_sys::Date::now();

    let source_files: std::collections::HashMap<String, String> =
        serde_json::from_str(source_files_str)
            .map_err(|e| JsValue::from_str(&format!("invalid source_files JSON: {e}")))?;

    let t1 = js_sys::Date::now();
    wasm_log!(
        "[wasm] sources parsed: {} files, {:.0}ms",
        source_files.len(),
        t1 - t0
    );
    wasm_log!(
        "[wasm] about to call extract_graph_with_source_map with {} bytes rustdoc",
        json_str.len()
    );

    let graph = crate::extract_graph_with_source_map(
        json_str,
        crate_name,
        source_files,
        root_file,
        crate::CallMode::Strict,
    )
    .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let t2 = js_sys::Date::now();
    wasm_log!(
        "[wasm] graph built: {} nodes, {} edges, {:.0}ms",
        graph.nodes.len(),
        graph.edges.len(),
        t2 - t1
    );

    let result = serde_json::to_string(&graph).map_err(|e| JsValue::from_str(&e.to_string()))?;

    wasm_log!("[wasm] serialized: {:.0}ms", js_sys::Date::now() - t2);
    Ok(result)
}
