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
    /// Generic parameters + where-clause for this item. Structured; the
    /// flat-string `where_clause` / `bound_links` fields it replaced are
    /// gone. Type IDs live inside the contained `TypeRef`s already, so
    /// the worker can build cross-crate links without a side table.
    #[serde(default, skip_serializing_if = "Generics::is_empty")]
    pub generics: Generics,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub impl_category: Option<ImplCategory>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provided_trait_methods: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_trait_methods: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_trait_methods: Option<Vec<String>>,
    /// The item's type (for Constant, Static, AssocConst, TypeAlias,
    /// AssocType, StructField with named field). Structured so the
    /// renderer can produce links + syntax-aware highlighting.
    #[serde(skip_serializing_if = "Option::is_none", rename = "type")]
    pub type_: Option<TypeRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant_kind: Option<VariantKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discriminant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub const_value: Option<String>,
    /// Bounds on the item (trait bounds for trait/trait-alias/impl-trait
    /// declarations, assoc-type bounds, etc.). Structured.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bounds: Vec<GenericBound>,
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

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub struct FieldInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: TypeRef,
    pub visibility: Visibility,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub struct VariantInfo {
    pub name: String,
    pub fields: Vec<FieldInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub struct FunctionSignature {
    pub inputs: Vec<ArgumentInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<TypeRef>,
    pub is_async: bool,
    pub is_unsafe: bool,
    pub is_const: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abi: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_c_variadic: bool,
    /// Generic params + where-clause specific to this function. Trait-method
    /// signatures carry their own here (separate from the impl block's
    /// generics).
    #[serde(default, skip_serializing_if = "Generics::is_empty")]
    pub generics: Generics,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub struct ArgumentInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: TypeRef,
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
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
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

// ─── Type AST ─────────────────────────────────────────────────────────────
//
// Mirrors `rustdoc-types::Type` faithfully so callers can render any Rust
// type expression with full structural fidelity (lifetimes, mutability,
// generic arguments, higher-rank bounds, etc.) instead of dealing with
// pre-stringified prose. Cross-crate links are preserved via the `id`
// field on `ResolvedPath` — these are rustdoc Item IDs and resolve to
// concrete nodes in the workspace graph.
//
// Tagged-union shape (`#[serde(tag = "kind")]`) so JS/TS consumers can
// `switch (type.kind)` exhaustively. Schema is pre-release; no
// backwards-compat constraints on the wire format until SCHEMA_VERSION
// starts moving.

/// One type expression in any position — function arg, return, field,
/// generic bound, where-predicate, etc. Recursive via `Box<TypeRef>`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind")]
pub enum TypeRef {
    /// Concrete named type: `Vec<T>`, `std::option::Option<T>`, `MyStruct`.
    /// `id` is the rustdoc Item ID — the renderer uses it to build
    /// cross-crate links.
    ResolvedPath {
        id: String,
        /// Path as written at the use site, e.g. "std::vec::Vec" or just "Vec".
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        args: Option<Box<GenericArgs>>,
    },
    /// `dyn Trait + 'a + Send`
    DynTrait {
        traits: Vec<PolyTrait>,
        #[serde(skip_serializing_if = "Option::is_none")]
        lifetime: Option<String>,
    },
    /// Generic type parameter: the `T` in `fn f<T>(x: T)`.
    Generic { name: String },
    /// Built-in: `i32`, `u8`, `bool`, `char`, `str`, `()`.
    Primitive { name: String },
    /// `&'a mut T`, `&T`, `&'static str`.
    BorrowedRef {
        #[serde(skip_serializing_if = "Option::is_none")]
        lifetime: Option<String>,
        mutable: bool,
        inner: Box<TypeRef>,
    },
    /// `(A, B, C)`. Empty tuple `()` is `Primitive { name: "()" }` per rustdoc.
    Tuple { elements: Vec<TypeRef> },
    /// `[T]`
    Slice { element: Box<TypeRef> },
    /// `[T; N]`. `len` is the const expression as written; may be `"N + 1"`
    /// or a parameter name — not guaranteed to be a literal.
    Array {
        element: Box<TypeRef>,
        len: String,
    },
    /// `impl Iterator<Item=T>`, `impl Trait + 'a`.
    ImplTrait { bounds: Vec<GenericBound> },
    /// `*const T` / `*mut T`.
    RawPointer {
        mutable: bool,
        inner: Box<TypeRef>,
    },
    /// `<T as Trait>::Item` or `T::Item` (inherent assoc when `trait_` is None).
    QualifiedPath {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        args: Option<Box<GenericArgs>>,
        self_type: Box<TypeRef>,
        #[serde(skip_serializing_if = "Option::is_none", rename = "trait")]
        trait_: Option<Box<TypeRef>>,
    },
    /// `fn(A, B) -> C`, `unsafe extern "C" fn() -> *const u8`.
    FunctionPointer { sig: Box<FunctionPointerSig> },
    /// `_` — type inference placeholder. Rare in published signatures.
    Infer,
    /// Pattern type, e.g. `u32 is 1..` (unstable). `pat` is the stringified
    /// pattern since rustdoc-types hides the inner pattern structure today.
    Pat {
        base: Box<TypeRef>,
        pat: String,
    },
}

/// `<…>` or `(…) -> _` arguments to a path segment.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind")]
pub enum GenericArgs {
    /// `<'a, T, 5, Item = u32>` — args + associated-item constraints.
    AngleBracketed {
        args: Vec<GenericArg>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        constraints: Vec<AssocItemConstraint>,
    },
    /// `Fn(A, B) -> C`
    Parenthesized {
        inputs: Vec<TypeRef>,
        #[serde(skip_serializing_if = "Option::is_none")]
        output: Option<Box<TypeRef>>,
    },
    /// `T::method(..)` — rustdoc 1.83+ feature for return-type notation.
    ReturnTypeNotation,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind")]
pub enum GenericArg {
    Lifetime { name: String },
    Type { value: TypeRef },
    /// Const generic value, e.g. the `42` in `IntoIter<u32, 42>`.
    Const { expr: String, is_literal: bool },
    /// `_` placeholder in generic arg position: `Vec::<_>`.
    Infer,
}

/// `IntoIterator<Item = u32, IntoIter: Clone>` — the constraints inside `<…>`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub struct AssocItemConstraint {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Box<GenericArgs>>,
    pub binding: AssocItemConstraintKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind")]
pub enum AssocItemConstraintKind {
    /// `Item = u32` (type) or `BAR = 42` (const).
    Equality { value: Term },
    /// `Item: Clone` — bounds on the associated item.
    Constraint { bounds: Vec<GenericBound> },
}

/// Either a type or a constant, as used in `=` constraints (`Item = T`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind")]
pub enum Term {
    Type { value: TypeRef },
    Const { expr: String, is_literal: bool },
}

/// A trait reference with optional higher-rank lifetime quantifier, used
/// inside `dyn Trait1 + Trait2` lists. The lifetime quantifier lets us
/// preserve `dyn for<'a> Fn(&'a i32) -> &'a i32`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub struct PolyTrait {
    #[serde(rename = "trait")]
    pub trait_: TypeRef,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hrtb_params: Vec<GenericParam>,
}

/// Function pointer signature (the `fn(...) -> ...` part of a fn-pointer type).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub struct FunctionPointerSig {
    pub inputs: Vec<NamedTypeRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<TypeRef>,
    pub is_unsafe: bool,
    pub is_const: bool,
    pub is_async: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abi: Option<String>,
    pub is_c_variadic: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hrtb_params: Vec<GenericParam>,
}

/// `name: TypeRef` pair — used for function inputs (both fn signatures and
/// fn-pointer types). For fn-pointer types the name may be empty.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub struct NamedTypeRef {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: TypeRef,
}

// ─── Generics + bounds + where-clause ─────────────────────────────────

/// Combined generic parameters + where-clause for an item. Lives on any
/// item that can be generic (fn, struct, enum, trait, impl, type alias).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default, Serialize, Deserialize, JsonSchema)]
pub struct Generics {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub params: Vec<GenericParam>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub where_predicates: Vec<WherePredicate>,
}

impl Generics {
    pub fn is_empty(&self) -> bool {
        self.params.is_empty() && self.where_predicates.is_empty()
    }
}

/// A single declaration in `<…>`: `T: Bound`, `'a`, `const N: usize`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub struct GenericParam {
    pub name: String,
    pub kind: GenericParamKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind")]
pub enum GenericParamKind {
    Lifetime {
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        outlives: Vec<String>,
    },
    Type {
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        bounds: Vec<GenericBound>,
        #[serde(skip_serializing_if = "Option::is_none")]
        default: Option<TypeRef>,
        /// Compiler-inserted synthetic parameter (e.g. lifted from
        /// `impl Trait` arg position) — flag so renderers can hide it.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        synthetic: bool,
    },
    Const {
        #[serde(rename = "type")]
        type_: TypeRef,
        #[serde(skip_serializing_if = "Option::is_none")]
        default: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind")]
pub enum WherePredicate {
    /// `T: Bound1 + Bound2`, or higher-ranked `for<'a> &'a T: Trait`.
    Bound {
        #[serde(rename = "type")]
        type_: TypeRef,
        bounds: Vec<GenericBound>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        hrtb_params: Vec<GenericParam>,
    },
    /// `'a: 'b + 'c`
    Lifetime {
        lifetime: String,
        outlives: Vec<String>,
    },
    /// `T::Item = u32`
    Eq {
        lhs: TypeRef,
        rhs: Term,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind")]
pub enum GenericBound {
    Trait {
        #[serde(rename = "trait")]
        trait_: TypeRef,
        modifier: TraitBoundModifier,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        hrtb_params: Vec<GenericParam>,
    },
    /// `: 'a` outlives bound.
    Outlives { lifetime: String },
    /// `use<'a, T>` precise-capturing bound.
    Use { captures: Vec<PreciseCapture> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TraitBoundModifier {
    None,
    /// `?Sized` — relaxes the implicit Sized bound.
    Maybe,
    /// `~const Trait` — bound applies at both runtime and const-context.
    MaybeConst,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind")]
pub enum PreciseCapture {
    Lifetime { name: String },
    Param { name: String },
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
