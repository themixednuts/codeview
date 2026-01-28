use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    /// Crate name → version string (e.g. "drizzle_core" → "0.1.4")
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub crate_versions: std::collections::HashMap<String, String>,
    /// GitHub repository (e.g. "owner/repo") for source fetching on Cloudflare
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// Git ref (branch, tag, or commit SHA) for source fetching on Cloudflare
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "ref")]
    pub ref_: Option<String>,
}

impl Graph {
    pub fn new() -> Self {
        Self {
            nodes: Vec::new(),
            edges: Vec::new(),
            crate_versions: std::collections::HashMap::new(),
            repo: None,
            ref_: None,
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
    pub docs: Option<String>,
    /// Resolved intra-doc links: maps link text (e.g., "Vec") to node ID (e.g., "std::vec::Vec")
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub doc_links: std::collections::HashMap<String, String>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MermaidKind {
    Flow,
    Class,
}

pub fn export_mermaid(graph: &Graph, kind: MermaidKind) -> String {
    match kind {
        MermaidKind::Flow => export_mermaid_flow(graph),
        MermaidKind::Class => export_mermaid_class(graph),
    }
}

fn export_mermaid_flow(graph: &Graph) -> String {
    let mut lines = Vec::new();
    lines.push("graph TD".to_string());

    for node in &graph.nodes {
        let node_id = mermaid_id(&node.id);
        let label = mermaid_label(&node.name);
        lines.push(format!("    {node_id}[\"{label}\"]"));
    }

    for edge in &graph.edges {
        let from = mermaid_id(&edge.from);
        let to = mermaid_id(&edge.to);
        let label = edge_label(edge.kind);
        lines.push(format!("    {from} -->|{label}| {to}"));
    }

    lines.join("\n")
}

fn export_mermaid_class(graph: &Graph) -> String {
    let mut lines = Vec::new();
    lines.push("classDiagram".to_string());

    for node in &graph.nodes {
        match node.kind {
            NodeKind::Struct
            | NodeKind::Union
            | NodeKind::Enum
            | NodeKind::Trait
            | NodeKind::TraitAlias
            | NodeKind::TypeAlias => {
                let node_id = mermaid_id(&node.id);
                lines.push(format!("    class {node_id} {{ }}"));
            }
            _ => {}
        }
    }

    for edge in &graph.edges {
        let from = mermaid_id(&edge.from);
        let to = mermaid_id(&edge.to);
        match edge.kind {
            EdgeKind::Implements => lines.push(format!("    {from} ..|> {to}")),
            EdgeKind::UsesType => lines.push(format!("    {from} --> {to}")),
            _ => {}
        }
    }

    lines.join("\n")
}

fn mermaid_id(raw: &str) -> String {
    let mut id = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            id.push(ch);
        } else {
            id.push('_');
        }
    }
    if id.is_empty() {
        "node".to_string()
    } else {
        id
    }
}

fn mermaid_label(raw: &str) -> String {
    raw.replace('"', "\\\"")
}

fn edge_label(kind: EdgeKind) -> &'static str {
    match kind {
        EdgeKind::Contains => "contains",
        EdgeKind::Defines => "defines",
        EdgeKind::Implements => "implements",
        EdgeKind::UsesType => "uses",
        EdgeKind::CallsStatic => "calls",
        EdgeKind::CallsRuntime => "calls_runtime",
        EdgeKind::Derives => "derives",
        EdgeKind::ReExports => "re-exports",
    }
}
