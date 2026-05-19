use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Current graph schema version.
///
/// **Pinned at 1 pre-release.** We're iterating on the shape of the
/// graph (Visibility tagged enum, structured Generics + Type AST work in
/// flight, etc.) and don't want to bump-and-reparse the local R2 every
/// time something internal changes. During this phase the freshness
/// drift signal comes from `parserRevision` (git SHA of the parser):
/// any change to `codeview-rustdoc` automatically marks crates stale on
/// the next cron sweep, which is exactly what we want for iteration.
///
/// At the first public release this constant will start moving. Bump
/// when on-disk artifact shape changes in a way the worker must adapt
/// to (not for every internal parser tweak).
pub const SCHEMA_VERSION: u32 = 1;

/// Top-level workspace: per-crate graphs with cross-crate edges.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Workspace {
    #[serde(default = "default_version")]
    pub version: u32,
    /// Workspace member crates (fully analyzed)
    pub crates: Vec<CrateGraph>,
    /// External crate stubs (referenced but not analyzed)
    pub external_crates: Vec<ExternalCrate>,
    /// Edges that cross crate boundaries (from_crate != to_crate)
    pub cross_crate_edges: Vec<Edge>,
    /// GitHub repository (e.g. "owner/repo") for source fetching on Cloudflare
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// Git ref (branch, tag, or commit SHA) for source fetching on Cloudflare
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "ref")]
    pub ref_: Option<String>,
}

/// A single crate's graph data.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CrateGraph {
    /// Crate identifier (e.g. "drizzle_core")
    pub id: String,
    /// Display name
    pub name: String,
    /// Crate version string
    pub version: String,
    /// All nodes belonging to this crate
    pub nodes: Vec<Node>,
    /// Internal edges (both from+to within this crate)
    pub edges: Vec<Edge>,
    /// Public re-export path → canonical node ID (see `Graph::aliases`).
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub aliases: std::collections::HashMap<String, String>,
}

/// Stub for an external crate referenced by workspace crates.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ExternalCrate {
    /// Crate identifier (e.g. "std")
    pub id: String,
    /// Display name
    pub name: String,
    /// Pinned version from cargo metadata (None for std/core/alloc)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Stub nodes for external items referenced by workspace crates
    pub nodes: Vec<Node>,
}

const fn default_version() -> u32 {
    SCHEMA_VERSION
}

/// Internal flat graph used during per-crate graph building.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    /// Public-path → canonical-node-id aliases.
    ///
    /// When a `pub use` re-export exposes an item through a path that's shorter
    /// or doesn't traverse a private module, we record the public path as an
    /// alias of the canonical node ID. Consumers (URL routing, intra-doc link
    /// resolution) should prefer the alias for display and fall back to the
    /// canonical for lookup.
    ///
    /// Backwards-compatible: older graph JSON without this field deserialises
    /// to an empty map.
    #[serde(default)]
    pub aliases: std::collections::HashMap<String, String>,
}

impl Graph {
    pub fn new() -> Self {
        Self {
            nodes: Vec::new(),
            edges: Vec::new(),
            aliases: std::collections::HashMap::new(),
        }
    }

    pub fn add_node(&mut self, node: Node) {
        self.nodes.push(node);
    }

    pub fn add_edge(&mut self, edge: Edge) {
        self.edges.push(edge);
    }
}

impl Default for Graph {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Node {
    pub id: String,
    pub name: String,
    pub kind: NodeKind,
    pub visibility: Visibility,
    pub span: Option<Span>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_count: Option<u32>,
    pub attrs: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_external: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_deprecated: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_unsafe: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_auto: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_mutable: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_stripped: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub has_stripped_fields: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub has_stripped_variants: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_dyn_compatible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deprecation: Option<Deprecation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<FieldInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variants: Option<Vec<VariantInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<FunctionSignature>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generics: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub where_clause: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docs: Option<String>,
    /// Resolved intra-doc links: maps link text (e.g., "Vec") to node ID (e.g., "std::vec::Vec")
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub doc_links: std::collections::HashMap<String, String>,
    /// Resolved trait bound links from generics/where clauses:
    /// maps display name (e.g., "Clone") to node ID (e.g., "core::clone::Clone")
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub bound_links: std::collections::HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub impl_type: Option<ImplType>,
    /// For methods: the ID of the parent impl block
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_impl: Option<String>,
    /// For impl blocks: the ID of the trait being implemented (if trait impl)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub impl_trait: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub impl_category: Option<ImplCategory>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provided_trait_methods: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_trait_methods: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_trait_methods: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant_kind: Option<VariantKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discriminant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub const_value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub import_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub import_name: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_glob: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extern_crate_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extern_crate_rename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub macro_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proc_macro_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub proc_macro_helpers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Deprecation {
    pub since: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FieldInfo {
    pub name: String,
    pub type_name: String,
    pub visibility: Visibility,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VariantInfo {
    pub name: String,
    pub fields: Vec<FieldInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FunctionSignature {
    pub inputs: Vec<ArgumentInfo>,
    pub output: Option<String>,
    pub is_async: bool,
    pub is_unsafe: bool,
    pub is_const: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abi: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_c_variadic: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ArgumentInfo {
    pub name: String,
    pub type_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum NodeKind {
    Crate,
    Module,
    Struct,
    StructField,
    Union,
    Enum,
    Variant,
    Trait,
    TraitAlias,
    Impl,
    Function,
    TypeAlias,
    AssocType,
    Constant,
    AssocConst,
    Static,
    Macro,
    Primitive,
    ExternCrate,
    Import,
    ProcMacro,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum ImplType {
    Trait,
    Inherent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum ImplCategory {
    Inherent,
    Trait,
    Blanket,
    Negative,
    Synthetic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VariantKind {
    Unit,
    Tuple,
    Struct,
}

/// Visibility level. Carries the restriction path when the visibility is
/// `pub(crate)` / `pub(super)` / `pub(in path::to::module)`.
///
/// Tagged enum (serde `tag = "kind"`) so JSON and TypeScript consumers get
/// a uniformly-shaped object regardless of variant. Adds an optional
/// `path` only on the `Restricted` variant. Schema bump (v2 → v3): older
/// flat-string artifacts won't deserialise as-is; the freshness registry
/// re-parses everything when SCHEMA_VERSION changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind")]
pub enum Visibility {
    Public,
    Crate,
    Restricted {
        /// The path with which the restriction parent was referenced,
        /// e.g. `crate::foo::bar`, `super::super`, or `crate`. From rustdoc
        /// JSON `Visibility::Restricted.path`.
        path: String,
    },
    Inherited,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Span {
    pub file: String,
    pub line: u32,
    pub column: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub kind: EdgeKind,
    pub confidence: Confidence,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_glob: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum EdgeKind {
    Contains,
    Defines,
    Implements,
    UsesType,
    CallsStatic,
    CallsRuntime,
    Derives,
    ReExports,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum Confidence {
    Static,
    Runtime,
    Inferred,
}
