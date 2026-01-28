//! WebGPU-powered rendering for graph visualization.
//!
//! This module provides GPU-accelerated rendering of nodes and edges:
//! - Instanced node rendering with circle SDF
//! - Line rendering for edges with directional arrows
//! - Pan/zoom camera controls
//! - Hover and selection highlighting

mod camera;
mod pipeline;

pub use camera::Camera;
pub use pipeline::RenderPipeline;

use crate::layout::{node_half_size, LayoutResult};
use bytemuck::{Pod, Zeroable};
use codeview_core::{EdgeKind, NodeKind};
use glam::Vec2;
use serde::{Deserialize, Serialize};

/// Configuration for the renderer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderConfig {
    /// Background color (RGBA)
    pub background_color: [f32; 4],
    /// Whether to render edges
    pub show_edges: bool,
    /// Whether to show node labels
    pub show_labels: bool,
    /// Edge opacity (0-1)
    pub edge_opacity: f32,
    /// Node outline width
    pub outline_width: f32,
    /// Hover highlight radius expansion
    pub hover_expansion: f32,
    /// Selection highlight color
    pub selection_color: [f32; 4],
}

impl Default for RenderConfig {
    fn default() -> Self {
        Self {
            background_color: [0.957, 0.937, 0.902, 1.0], // #f4efe6
            show_edges: true,
            show_labels: true,
            edge_opacity: 0.6,
            outline_width: 2.0,
            hover_expansion: 4.0,
            selection_color: [0.843, 0.416, 0.184, 1.0], // #d76a2f
        }
    }
}

const FLAG_SELECTED: u32 = 1;
const FLAG_HOVERED: u32 = 2;
const FLAG_CENTER: u32 = 4;
const FLAG_RECT: u32 = 8;
const CENTER_SCALE: f32 = 1.15;

fn is_rect_kind(kind: NodeKind) -> bool {
    matches!(kind, NodeKind::Struct | NodeKind::Enum | NodeKind::Union)
}

/// Node colors based on kind (matches Svelte UI)
pub fn node_color(kind: NodeKind) -> [f32; 4] {
    match kind {
        NodeKind::Crate => [0.910, 0.365, 0.016, 1.0],    // #e85d04
        NodeKind::Module => [0.176, 0.416, 0.310, 1.0],   // #2d6a4f
        NodeKind::Struct => [0.616, 0.306, 0.867, 1.0],   // #9d4edd
        NodeKind::Union => [0.482, 0.173, 0.749, 1.0],    // #7b2cbf
        NodeKind::Enum => [0.227, 0.525, 1.0, 1.0],       // #3a86ff
        NodeKind::Trait => [0.024, 0.839, 0.627, 1.0],    // #06d6a0
        NodeKind::TraitAlias => [0.051, 0.702, 0.620, 1.0], // #0db39e
        NodeKind::Impl => [0.553, 0.600, 0.682, 1.0],     // #8d99ae
        NodeKind::Function => [0.969, 0.145, 0.522, 1.0], // #f72585
        NodeKind::Method => [0.710, 0.090, 0.745, 1.0],   // #b5179e
        NodeKind::TypeAlias => [1.0, 0.427, 0.0, 1.0],    // #ff6d00
    }
}

/// Edge colors based on kind
pub fn edge_color(kind: EdgeKind) -> [f32; 4] {
    match kind {
        EdgeKind::Contains => [0.6, 0.6, 0.6, 0.5],      // Gray, structural
        EdgeKind::Defines => [0.5, 0.5, 0.5, 0.5],       // Gray, structural
        EdgeKind::Implements => [0.024, 0.839, 0.627, 0.7], // Teal
        EdgeKind::UsesType => [0.227, 0.525, 1.0, 0.6],   // Blue
        EdgeKind::CallsStatic => [0.969, 0.145, 0.522, 0.7], // Pink
        EdgeKind::CallsRuntime => [0.710, 0.090, 0.745, 0.6], // Purple
        EdgeKind::Derives => [1.0, 0.427, 0.0, 0.6],     // Orange
    }
}

fn edge_anchor(from: Vec2, to: Vec2, size: Vec2, is_rect: bool) -> Vec2 {
    let delta = to - from;
    if delta.length_squared() == 0.0 {
        return from;
    }
    if is_rect {
        let scale = 1.0 / f32::max(delta.x.abs() / size.x, delta.y.abs() / size.y);
        return from + delta * scale;
    }
    let radius = size.x.min(size.y);
    from + delta.normalize() * radius
}

/// Instance data for a single node (GPU buffer format)
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct NodeInstance {
    /// Position (x, y)
    pub position: [f32; 2],
    /// Half-size (width/2, height/2)
    pub size: [f32; 2],
    /// Color (RGBA)
    pub color: [f32; 4],
    /// Flags (bit 0: selected, bit 1: hovered, bit 2: center, bit 3: rectangle)
    pub flags: u32,
    /// Padding for alignment
    pub _padding: [f32; 3],
}

/// Instance data for a single edge (GPU buffer format)
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct EdgeInstance {
    /// Start position (x, y)
    pub start: [f32; 2],
    /// End position (x, y)
    pub end: [f32; 2],
    /// Color (RGBA)
    pub color: [f32; 4],
    /// Line width
    pub width: f32,
    /// Flags (bit 0: highlighted)
    pub flags: u32,
    /// Padding for alignment
    pub _padding: [f32; 2],
}

/// Uniform data for camera/view transformation
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct ViewUniforms {
    /// View-projection matrix (simplified 2D: scale and translate)
    pub view_proj: [[f32; 4]; 4],
    /// Viewport size in pixels
    pub viewport_size: [f32; 2],
    /// Current time (for animations)
    pub time: f32,
    /// Padding
    pub _padding: f32,
}

/// Main renderer struct
pub struct Renderer {
    /// wgpu device
    device: wgpu::Device,
    /// wgpu queue
    queue: wgpu::Queue,
    /// Surface configuration
    surface_config: wgpu::SurfaceConfiguration,
    /// Render pipeline for nodes
    node_pipeline: RenderPipeline,
    /// Render pipeline for edges
    edge_pipeline: RenderPipeline,
    /// Node instance buffer
    node_buffer: wgpu::Buffer,
    /// Edge instance buffer
    edge_buffer: wgpu::Buffer,
    /// Uniform buffer
    uniform_buffer: wgpu::Buffer,
    /// Uniform bind group
    uniform_bind_group: wgpu::BindGroup,
    /// Camera state
    camera: Camera,
    /// Render configuration
    config: RenderConfig,
    /// Current node instances
    nodes: Vec<NodeInstance>,
    /// Current edge instances
    edges: Vec<EdgeInstance>,
    /// Currently hovered node index
    hovered_node: Option<usize>,
    /// Currently selected node index
    selected_node: Option<usize>,
}

impl Renderer {
    /// Maximum number of nodes we can render
    pub const MAX_NODES: usize = 100_000;
    /// Maximum number of edges we can render
    pub const MAX_EDGES: usize = 500_000;

    /// Create a new renderer
    pub async fn new(
        device: wgpu::Device,
        queue: wgpu::Queue,
        surface_config: wgpu::SurfaceConfiguration,
        config: RenderConfig,
    ) -> Self {
        // Create uniform buffer
        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("View Uniforms"),
            size: std::mem::size_of::<ViewUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // Create bind group layout
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Uniform Bind Group Layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        // Create bind group
        let uniform_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Uniform Bind Group"),
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
        });

        // Create node instance buffer
        let node_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Node Instance Buffer"),
            size: (Self::MAX_NODES * std::mem::size_of::<NodeInstance>()) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // Create edge instance buffer
        let edge_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Edge Instance Buffer"),
            size: (Self::MAX_EDGES * std::mem::size_of::<EdgeInstance>()) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // Create render pipelines
        let node_pipeline = RenderPipeline::create_node_pipeline(
            &device,
            &surface_config,
            &bind_group_layout,
        );
        let edge_pipeline = RenderPipeline::create_edge_pipeline(
            &device,
            &surface_config,
            &bind_group_layout,
        );

        // Initialize camera
        let camera = Camera::new(
            surface_config.width as f32,
            surface_config.height as f32,
        );

        Self {
            device,
            queue,
            surface_config,
            node_pipeline,
            edge_pipeline,
            node_buffer,
            edge_buffer,
            uniform_buffer,
            uniform_bind_group,
            camera,
            config,
            nodes: Vec::new(),
            edges: Vec::new(),
            hovered_node: None,
            selected_node: None,
        }
    }

    /// Update the renderer with a new layout
    pub fn update_layout(&mut self, layout: &LayoutResult) {
        // Build node lookup for edge anchoring
        let mut node_lookup: std::collections::HashMap<&str, (Vec2, Vec2, NodeKind)> =
            std::collections::HashMap::new();
        for node in &layout.nodes {
            let mut size = node_half_size(node.kind);
            if node.is_center {
                size *= CENTER_SCALE;
            }
            node_lookup.insert(&node.id, (Vec2::new(node.x, node.y), size, node.kind));
        }

        // Convert nodes to instances
        self.nodes.clear();
        for (i, node) in layout.nodes.iter().enumerate() {
            let mut flags = 0u32;
            if self.selected_node == Some(i) {
                flags |= FLAG_SELECTED;
            }
            if self.hovered_node == Some(i) {
                flags |= FLAG_HOVERED;
            }
            if node.is_center {
                flags |= FLAG_CENTER;
            }
            if is_rect_kind(node.kind) {
                flags |= FLAG_RECT;
            }
            let mut size = node_half_size(node.kind);
            if node.is_center {
                size *= CENTER_SCALE;
            }

            self.nodes.push(NodeInstance {
                position: [node.x, node.y],
                size: [size.x, size.y],
                color: node_color(node.kind),
                flags,
                _padding: [0.0; 3],
            });
        }
        if self.nodes.len() > Self::MAX_NODES {
            self.nodes.truncate(Self::MAX_NODES);
        }

        // Convert edges to instances
        self.edges.clear();
        for edge in &layout.edges {
            let (start_pos, start_size, start_kind) = match node_lookup.get(edge.from.as_str()) {
                Some(entry) => *entry,
                None => continue,
            };
            let (end_pos, end_size, end_kind) = match node_lookup.get(edge.to.as_str()) {
                Some(entry) => *entry,
                None => continue,
            };
            let start_anchor = edge_anchor(start_pos, end_pos, start_size, is_rect_kind(start_kind));
            let end_anchor = edge_anchor(end_pos, start_pos, end_size, is_rect_kind(end_kind));

            self.edges.push(EdgeInstance {
                start: [start_anchor.x, start_anchor.y],
                end: [end_anchor.x, end_anchor.y],
                color: edge_color(edge.kind),
                width: 1.5,
                flags: 0,
                _padding: [0.0, 0.0],
            });
        }
        if self.edges.len() > Self::MAX_EDGES {
            self.edges.truncate(Self::MAX_EDGES);
        }

        // Upload to GPU
        self.upload_buffers();

        // Fit camera to bounds
        self.camera.fit_to_bounds(
            layout.bounds.min_x,
            layout.bounds.min_y,
            layout.bounds.max_x,
            layout.bounds.max_y,
        );
    }

    /// Upload node and edge buffers to GPU
    fn upload_buffers(&self) {
        if !self.nodes.is_empty() {
            self.queue.write_buffer(
                &self.node_buffer,
                0,
                bytemuck::cast_slice(&self.nodes),
            );
        }

        if !self.edges.is_empty() {
            self.queue.write_buffer(
                &self.edge_buffer,
                0,
                bytemuck::cast_slice(&self.edges),
            );
        }
    }

    /// Update uniform buffer with current camera state
    fn upload_uniforms(&self) {
        let uniforms = ViewUniforms {
            view_proj: self.camera.view_projection_matrix(),
            viewport_size: [
                self.surface_config.width as f32,
                self.surface_config.height as f32,
            ],
            time: 0.0, // TODO: pass actual time for animations
            _padding: 0.0,
        };

        self.queue.write_buffer(
            &self.uniform_buffer,
            0,
            bytemuck::bytes_of(&uniforms),
        );
    }

    /// Render a frame
    pub fn render(&self, view: &wgpu::TextureView) {
        self.upload_uniforms();

        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Render Encoder"),
        });

        {
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Main Render Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: self.config.background_color[0] as f64,
                            g: self.config.background_color[1] as f64,
                            b: self.config.background_color[2] as f64,
                            a: self.config.background_color[3] as f64,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            // Render edges first (behind nodes)
            if self.config.show_edges && !self.edges.is_empty() {
                render_pass.set_pipeline(&self.edge_pipeline.pipeline);
                render_pass.set_bind_group(0, &self.uniform_bind_group, &[]);
                render_pass.set_vertex_buffer(0, self.edge_buffer.slice(..));
                render_pass.draw(0..6, 0..self.edges.len() as u32);
            }

            // Render nodes
            if !self.nodes.is_empty() {
                render_pass.set_pipeline(&self.node_pipeline.pipeline);
                render_pass.set_bind_group(0, &self.uniform_bind_group, &[]);
                render_pass.set_vertex_buffer(0, self.node_buffer.slice(..));
                render_pass.draw(0..6, 0..self.nodes.len() as u32);
            }
        }

        self.queue.submit(std::iter::once(encoder.finish()));
    }

    /// Handle mouse pan
    pub fn pan(&mut self, dx: f32, dy: f32) {
        self.camera.pan(dx, dy);
    }

    /// Handle mouse zoom
    pub fn zoom(&mut self, factor: f32, center_x: f32, center_y: f32) {
        self.camera.zoom(factor, center_x, center_y);
    }

    /// Reset camera to fit all content
    pub fn reset_view(&mut self) {
        self.camera.reset();
    }

    /// Set hovered node by index
    pub fn set_hovered(&mut self, index: Option<usize>) {
        if self.hovered_node != index {
            self.hovered_node = index;
            self.update_node_flags();
        }
    }

    /// Set selected node by index
    pub fn set_selected(&mut self, index: Option<usize>) {
        if self.selected_node != index {
            self.selected_node = index;
            self.update_node_flags();
        }
    }

    /// Update node flags after selection/hover changes
    fn update_node_flags(&mut self) {
        for (i, node) in self.nodes.iter_mut().enumerate() {
            let mut flags = node.flags & (FLAG_CENTER | FLAG_RECT);
            if self.selected_node == Some(i) {
                flags |= FLAG_SELECTED;
            }
            if self.hovered_node == Some(i) {
                flags |= FLAG_HOVERED;
            }
            node.flags = flags;
        }
        self.upload_buffers();
    }

    /// Find node at screen position
    pub fn hit_test(&self, screen_x: f32, screen_y: f32) -> Option<usize> {
        let world_pos = self.camera.screen_to_world(screen_x, screen_y);

        for (i, node) in self.nodes.iter().enumerate() {
            let dx = world_pos.x - node.position[0];
            let dy = world_pos.y - node.position[1];
            let half_size = Vec2::new(node.size[0], node.size[1]);
            if (node.flags & FLAG_RECT) != 0 {
                if dx.abs() <= half_size.x && dy.abs() <= half_size.y {
                    return Some(i);
                }
            } else {
                let dist = (dx * dx + dy * dy).sqrt();
                if dist <= half_size.x {
                    return Some(i);
                }
            }
        }

        None
    }

    /// Resize the renderer
    pub fn resize(&mut self, width: u32, height: u32) {
        self.surface_config.width = width;
        self.surface_config.height = height;
        self.camera.resize(width as f32, height as f32);
    }
}
