//! WASM entry point for codeview-rustdoc graph extraction.
//!
//! Exposes `extract_graph` and `extract_graph_with_sources` to JavaScript
//! via wasm-bindgen.
//!
//! Build with: `wasm-pack build --target web --features wasm --no-default-features`

#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

/// Extract a crate graph from rustdoc JSON (no source files — no call edges).
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn extract_graph(json: &str, crate_name: &str) -> Result<String, JsValue> {
    let graph = crate::extract_graph(json, crate_name)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    serde_json::to_string(&graph)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Extract a crate graph with call edges from in-memory source files.
///
/// `source_files_json` is a JSON object mapping file paths to source content,
/// e.g. `{"src/lib.rs": "fn main() { ... }", "src/utils.rs": "..."}`.
/// `root_file` is the entry point (e.g. "src/lib.rs").
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn extract_graph_with_sources(
    json: &str,
    crate_name: &str,
    source_files_json: &str,
    root_file: &str,
) -> Result<String, JsValue> {
    let source_files: std::collections::HashMap<String, String> =
        serde_json::from_str(source_files_json)
            .map_err(|e| JsValue::from_str(&format!("invalid source_files JSON: {e}")))?;

    let graph = crate::extract_graph_with_source_map(
        json,
        crate_name,
        source_files,
        root_file,
        crate::CallMode::Strict,
    )
    .map_err(|e| JsValue::from_str(&e.to_string()))?;

    serde_json::to_string(&graph)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
