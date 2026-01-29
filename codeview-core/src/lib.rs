use serde::{Deserialize, Serialize};

/// Current graph schema version.
pub const SCHEMA_VERSION: u32 = 1;

/// Top-level workspace: per-crate graphs with cross-crate edges.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

/// Stub for an external crate referenced by workspace crates.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalCrate {
    /// Crate identifier (e.g. "std")
    pub id: String,
    /// Display name
    pub name: String,
    /// Stub nodes for external items referenced by workspace crates
    pub nodes: Vec<Node>,
}

const fn default_version() -> u32 {
    SCHEMA_VERSION
}

/// Internal flat graph used during per-crate graph building.
/// Not serialized to the output format.
#[derive(Debug, Clone)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

impl Graph {
    pub fn new() -> Self {
        Self {
            nodes: Vec::new(),
            edges: Vec::new(),
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub name: String,
    pub kind: NodeKind,
    pub visibility: Visibility,
    pub span: Option<Span>,
    pub attrs: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_external: bool,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldInfo {
    pub name: String,
    pub type_name: String,
    pub visibility: Visibility,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VariantInfo {
    pub name: String,
    pub fields: Vec<FieldInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionSignature {
    pub inputs: Vec<ArgumentInfo>,
    pub output: Option<String>,
    pub is_async: bool,
    pub is_unsafe: bool,
    pub is_const: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArgumentInfo {
    pub name: String,
    pub type_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NodeKind {
    Crate,
    Module,
    Struct,
    Union,
    Enum,
    Trait,
    TraitAlias,
    Impl,
    Function,
    Method,
    TypeAlias,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ImplType {
    Trait,
    Inherent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Visibility {
    Public,
    Crate,
    Restricted,
    Inherited,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Span {
    pub file: String,
    pub line: u32,
    pub column: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub kind: EdgeKind,
    pub confidence: Confidence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Confidence {
    Static,
    Runtime,
    Inferred,
}
