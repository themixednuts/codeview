export type NodeKind =
  | 'Crate'
  | 'Module'
  | 'Struct'
  | 'Union'
  | 'Enum'
  | 'Trait'
  | 'TraitAlias'
  | 'Impl'
  | 'Function'
  | 'Method'
  | 'TypeAlias';

export type ImplType = 'Trait' | 'Inherent';

export type Visibility = 'Public' | 'Crate' | 'Restricted' | 'Inherited' | 'Unknown';

export type EdgeKind =
  | 'Contains'
  | 'Defines'
  | 'Implements'
  | 'UsesType'
  | 'CallsStatic'
  | 'CallsRuntime'
  | 'Derives'
  | 'ReExports';

export type Confidence = 'Static' | 'Runtime' | 'Inferred';

export interface Span {
  file: string;
  line: number;
  column: number;
  end_line?: number;
  end_column?: number;
}

export interface FieldInfo {
  name: string;
  type_name: string;
  visibility: Visibility;
}

export interface VariantInfo {
  name: string;
  fields: FieldInfo[];
}

export interface ArgumentInfo {
  name: string;
  type_name: string;
}

export interface FunctionSignature {
  inputs: ArgumentInfo[];
  output?: string | null;
  is_async: boolean;
  is_unsafe: boolean;
  is_const: boolean;
}

export interface Node {
  id: string;
  name: string;
  kind: NodeKind;
  visibility: Visibility;
  span?: Span | null;
  attrs?: string[];
  is_external?: boolean;
  fields?: FieldInfo[] | null;
  variants?: VariantInfo[] | null;
  signature?: FunctionSignature | null;
  generics?: string[] | null;
  docs?: string | null;
  /** Resolved intra-doc links: maps link text (e.g., "Vec") to node ID (e.g., "std::vec::Vec") */
  doc_links?: Record<string, string>;
  impl_type?: ImplType | null;
  /** For methods: the ID of the parent impl block */
  parent_impl?: string | null;
  /** For impl blocks: the ID of the trait being implemented (if trait impl) */
  impl_trait?: string | null;
}

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
  confidence: Confidence;
}

export interface Graph {
  nodes: Node[];
  edges: Edge[];
  /** Crate name → version string (e.g. "drizzle_core" → "0.1.4") */
  crate_versions?: Record<string, string>;
  /** GitHub repository (e.g. "owner/repo") for source fetching on Cloudflare */
  repo?: string;
  /** Git ref (branch, tag, or commit SHA) for source fetching on Cloudflare */
  ref?: string;
}
