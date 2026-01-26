import type { Graph } from './graph';

export const sampleGraph: Graph = {
  nodes: [
    {
      id: 'codeview',
      name: 'codeview',
      kind: 'Crate',
      visibility: 'Public',
      span: null,
      attrs: []
    },
    {
      id: 'codeview::core',
      name: 'core',
      kind: 'Module',
      visibility: 'Public',
      span: null,
      attrs: []
    },
    {
      id: 'codeview::rustdoc',
      name: 'rustdoc',
      kind: 'Module',
      visibility: 'Public',
      span: null,
      attrs: []
    },
    {
      id: 'codeview::core::Graph',
      name: 'Graph',
      kind: 'Struct',
      visibility: 'Public',
      span: null,
      attrs: []
    },
    {
      id: 'codeview::core::Node',
      name: 'Node',
      kind: 'Struct',
      visibility: 'Public',
      span: null,
      attrs: []
    },
    {
      id: 'codeview::core::EdgeKind',
      name: 'EdgeKind',
      kind: 'Enum',
      visibility: 'Public',
      span: null,
      attrs: []
    },
    {
      id: 'codeview::core::Exporter',
      name: 'Exporter',
      kind: 'Trait',
      visibility: 'Public',
      span: null,
      attrs: []
    },
    {
      id: 'codeview::core::MermaidExporter',
      name: 'MermaidExporter',
      kind: 'Struct',
      visibility: 'Public',
      span: null,
      attrs: []
    },
    {
      id: 'codeview::core::export_mermaid',
      name: 'export_mermaid',
      kind: 'Function',
      visibility: 'Public',
      span: null,
      attrs: []
    },
    {
      id: 'codeview::rustdoc::generate_rustdoc_json',
      name: 'generate_rustdoc_json',
      kind: 'Function',
      visibility: 'Public',
      span: null,
      attrs: []
    },
    {
      id: 'codeview::core::impl-42',
      name: 'impl Graph',
      kind: 'Impl',
      visibility: 'Public',
      span: null,
      attrs: []
    },
    {
      id: 'codeview::core::Graph::new',
      name: 'new',
      kind: 'Method',
      visibility: 'Public',
      span: null,
      attrs: []
    },
    {
      id: 'codeview::core::Graph::add_node',
      name: 'add_node',
      kind: 'Method',
      visibility: 'Public',
      span: null,
      attrs: []
    },
    {
      id: 'codeview::core::Graph::add_edge',
      name: 'add_edge',
      kind: 'Method',
      visibility: 'Public',
      span: null,
      attrs: []
    },
    {
      id: 'codeview::core::GraphView',
      name: 'GraphView',
      kind: 'TypeAlias',
      visibility: 'Public',
      span: null,
      attrs: []
    }
  ],
  edges: [
    { from: 'codeview', to: 'codeview::core', kind: 'Contains', confidence: 'Static' },
    { from: 'codeview', to: 'codeview::rustdoc', kind: 'Contains', confidence: 'Static' },
    { from: 'codeview::core', to: 'codeview::core::Graph', kind: 'Contains', confidence: 'Static' },
    { from: 'codeview::core', to: 'codeview::core::Node', kind: 'Contains', confidence: 'Static' },
    { from: 'codeview::core', to: 'codeview::core::EdgeKind', kind: 'Contains', confidence: 'Static' },
    { from: 'codeview::core', to: 'codeview::core::Exporter', kind: 'Contains', confidence: 'Static' },
    { from: 'codeview::core', to: 'codeview::core::MermaidExporter', kind: 'Contains', confidence: 'Static' },
    { from: 'codeview::core', to: 'codeview::core::export_mermaid', kind: 'Contains', confidence: 'Static' },
    {
      from: 'codeview::core::MermaidExporter',
      to: 'codeview::core::Exporter',
      kind: 'Implements',
      confidence: 'Static'
    },
    {
      from: 'codeview::core::export_mermaid',
      to: 'codeview::core::Graph',
      kind: 'UsesType',
      confidence: 'Static'
    },
    {
      from: 'codeview::rustdoc::generate_rustdoc_json',
      to: 'codeview::core::export_mermaid',
      kind: 'CallsRuntime',
      confidence: 'Runtime'
    },
    {
      from: 'codeview::core::Graph',
      to: 'codeview::core::EdgeKind',
      kind: 'UsesType',
      confidence: 'Static'
    },
    { from: 'codeview::core::Graph', to: 'codeview::core::impl-42', kind: 'Defines', confidence: 'Static' },
    {
      from: 'codeview::core::impl-42',
      to: 'codeview::core::Graph::new',
      kind: 'Defines',
      confidence: 'Static'
    },
    {
      from: 'codeview::core::impl-42',
      to: 'codeview::core::Graph::add_node',
      kind: 'Defines',
      confidence: 'Static'
    },
    {
      from: 'codeview::core::impl-42',
      to: 'codeview::core::Graph::add_edge',
      kind: 'Defines',
      confidence: 'Static'
    },
    { from: 'codeview::core', to: 'codeview::core::GraphView', kind: 'Contains', confidence: 'Static' },
    {
      from: 'codeview::rustdoc',
      to: 'codeview::rustdoc::generate_rustdoc_json',
      kind: 'Contains',
      confidence: 'Static'
    }
  ]
};
