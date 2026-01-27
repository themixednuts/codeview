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
  | 'Derives';

export type Confidence = 'Static' | 'Runtime' | 'Inferred';

export interface Span {
  file: string;
  line: number;
  column: number;
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
  impl_type?: ImplType | null;
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
}
