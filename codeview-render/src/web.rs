//! WASM bindings for web integration.
//!
//! Provides a JavaScript-friendly API for the graph renderer.

use crate::layout::{create_layout, Layout, LayoutConfig, LayoutMode, LayoutResult};
use crate::render::{RenderConfig, Renderer};
use codeview_core::Graph;
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

macro_rules! console_log {
    ($($t:tt)*) => (log(&format_args!($($t)*).to_string()))
}

/// Initialize panic hook for better error messages
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
    console_log!("codeview-render WASM initialized");
}

/// Internal wrapper for storing web-specific state
#[allow(dead_code)]
struct WebState {
    canvas: HtmlCanvasElement,
    surface: wgpu::Surface<'static>,
    surface_config: wgpu::SurfaceConfiguration,
    device: wgpu::Device,
    queue: wgpu::Queue,
}

/// Graph renderer exposed to JavaScript
#[wasm_bindgen]
pub struct GraphRenderer {
    web_state: Option<WebState>,
    renderer: Option<Renderer>,
    layout: Box<dyn Layout>,
    graph: Option<Graph>,
    layout_result: Option<LayoutResult>,
    config: LayoutConfig,
    #[allow(dead_code)]
    render_config: RenderConfig,
    node_ids: Vec<String>,
    hovered_id: Option<String>,
    selected_id: Option<String>,
}

#[wasm_bindgen]
impl GraphRenderer {
    /// Create a new graph renderer from a canvas element
    #[wasm_bindgen]
    pub async fn create(canvas: HtmlCanvasElement) -> Result<GraphRenderer, JsValue> {
        console_log!("Creating GraphRenderer...");

        let width = canvas.width();
        let height = canvas.height();

        // Create wgpu instance with appropriate backends for web
        let instance_desc = wgpu::InstanceDescriptor {
            backends: wgpu::Backends::all(),
            ..Default::default()
        }
        .with_env();
        let instance = wgpu::Instance::new(&instance_desc);

        // Create surface from canvas using safe web target
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
            .map_err(|e| JsValue::from_str(&format!("Failed to create surface: {}", e)))?;

        // Request adapter
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .ok_or_else(|| JsValue::from_str("Failed to find suitable GPU adapter"))?;

        console_log!("Adapter: {:?}", adapter.get_info());

        // Request device with WebGL2-compatible limits
        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("codeview-render device"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::downlevel_webgl2_defaults(),
                    memory_hints: Default::default(),
                },
                None,
            )
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to create device: {}", e)))?;

        // Configure surface
        let surface_caps = surface.get_capabilities(&adapter);
        let mut surface_config = surface
            .get_default_config(&adapter, width, height)
            .ok_or_else(|| JsValue::from_str("Surface configuration unsupported"))?;
        if let Some(format) = surface_caps.formats.iter().find(|f| f.is_srgb()) {
            surface_config.format = *format;
        }

        surface.configure(&device, &surface_config);

        // Create renderer
        let render_config = RenderConfig::default();
        let renderer = Renderer::new(
            device.clone(),
            queue.clone(),
            surface_config.clone(),
            render_config.clone(),
        )
        .await;

        // Create default layout
        let layout = create_layout(LayoutMode::Ego);

        let config = LayoutConfig {
            width: width as f32,
            height: height as f32,
            ..Default::default()
        };

        let web_state = WebState {
            canvas,
            surface,
            surface_config,
            device,
            queue,
        };

        Ok(GraphRenderer {
            web_state: Some(web_state),
            renderer: Some(renderer),
            layout,
            graph: None,
            layout_result: None,
            config,
            render_config,
            node_ids: Vec::new(),
            hovered_id: None,
            selected_id: None,
        })
    }

    /// Load graph data from JSON string
    #[wasm_bindgen(js_name = loadGraph)]
    pub fn load_graph(&mut self, json: &str) -> Result<(), JsValue> {
        let graph: Graph = serde_json::from_str(json)
            .map_err(|e| JsValue::from_str(&format!("Failed to parse graph JSON: {}", e)))?;

        console_log!(
            "Loaded graph with {} nodes, {} edges",
            graph.nodes.len(),
            graph.edges.len()
        );

        self.graph = Some(graph);
        self.compute_layout()?;

        Ok(())
    }

    /// Set the layout mode
    #[wasm_bindgen(js_name = setLayoutMode)]
    pub fn set_layout_mode(&mut self, mode: &str) -> Result<(), JsValue> {
        let layout_mode = match mode {
            "ego" => LayoutMode::Ego,
            "force" => LayoutMode::Force,
            "hierarchical" => LayoutMode::Hierarchical,
            "radial" => LayoutMode::Radial,
            _ => return Err(JsValue::from_str(&format!("Unknown layout mode: {}", mode))),
        };

        self.config.mode = layout_mode;
        self.layout = create_layout(layout_mode);
        self.compute_layout()?;

        Ok(())
    }

    /// Set the center node for ego/radial layouts
    #[wasm_bindgen(js_name = setCenterNode)]
    pub fn set_center_node(&mut self, node_id: Option<String>) -> Result<(), JsValue> {
        self.config.center_node = node_id;
        self.compute_layout()?;
        Ok(())
    }

    /// Compute the layout
    fn compute_layout(&mut self) -> Result<(), JsValue> {
        let graph = match &self.graph {
            Some(g) => g,
            None => return Ok(()),
        };

        let result = self.layout.compute(graph, &self.config);

        // Store node IDs for hit testing
        self.node_ids = result.nodes.iter().map(|n| n.id.clone()).collect();

        // Update renderer
        if let Some(renderer) = &mut self.renderer {
            renderer.update_layout(&result);
        }

        // Reapply selection/hover to new indices
        self.apply_hover_selection();

        self.layout_result = Some(result);

        Ok(())
    }

    /// Render a frame
    #[wasm_bindgen]
    pub fn render(&self) -> Result<(), JsValue> {
        let web_state = match &self.web_state {
            Some(s) => s,
            None => return Err(JsValue::from_str("No web state")),
        };

        let renderer = match &self.renderer {
            Some(r) => r,
            None => return Err(JsValue::from_str("No renderer")),
        };

        let output = match web_state.surface.get_current_texture() {
            Ok(output) => output,
            Err(wgpu::SurfaceError::Outdated | wgpu::SurfaceError::Lost) => {
                web_state
                    .surface
                    .configure(&web_state.device, &web_state.surface_config);
                return Ok(());
            }
            Err(wgpu::SurfaceError::Timeout) => return Ok(()),
            Err(wgpu::SurfaceError::OutOfMemory) => {
                return Err(JsValue::from_str("WebGPU out of memory"))
            }
            Err(e) => {
                return Err(JsValue::from_str(&format!(
                    "Failed to get surface texture: {e}"
                )))
            }
        };

        let view = output
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        renderer.render(&view);

        output.present();

        Ok(())
    }

    /// Handle mouse pan
    #[wasm_bindgen]
    pub fn pan(&mut self, dx: f32, dy: f32) {
        if let Some(renderer) = &mut self.renderer {
            renderer.pan(dx, dy);
        }
    }

    /// Handle mouse zoom
    #[wasm_bindgen]
    pub fn zoom(&mut self, factor: f32, x: f32, y: f32) {
        if let Some(renderer) = &mut self.renderer {
            renderer.zoom(factor, x, y);
        }
    }

    /// Reset view to fit all content
    #[wasm_bindgen(js_name = resetView)]
    pub fn reset_view(&mut self) {
        if let Some(renderer) = &mut self.renderer {
            renderer.reset_view();
        }
    }

    /// Handle canvas resize
    #[wasm_bindgen]
    pub fn resize(&mut self, width: u32, height: u32) -> Result<(), JsValue> {
        if width == 0 || height == 0 {
            return Ok(());
        }

        self.config.width = width as f32;
        self.config.height = height as f32;

        // Reconfigure surface
        if let Some(web_state) = &mut self.web_state {
            web_state.surface_config.width = width;
            web_state.surface_config.height = height;
            web_state
                .surface
                .configure(&web_state.device, &web_state.surface_config);

            if let Some(renderer) = &mut self.renderer {
                renderer.resize(width, height);
            }
        }

        // Recompute layout for new dimensions
        self.compute_layout()?;

        Ok(())
    }

    /// Hit test at screen coordinates, returns node ID or null
    #[wasm_bindgen(js_name = hitTest)]
    pub fn hit_test(&self, x: f32, y: f32) -> Option<String> {
        let renderer = self.renderer.as_ref()?;
        let index = renderer.hit_test(x, y)?;
        self.node_ids.get(index).cloned()
    }

    /// Set hovered node by ID
    #[wasm_bindgen(js_name = setHovered)]
    pub fn set_hovered(&mut self, node_id: Option<String>) {
        self.hovered_id = node_id.clone();
        let index = node_id.as_ref().and_then(|id| self.node_ids.iter().position(|n| n == id));
        if let Some(renderer) = &mut self.renderer {
            renderer.set_hovered(index);
        }
    }

    /// Set selected node by ID
    #[wasm_bindgen(js_name = setSelected)]
    pub fn set_selected(&mut self, node_id: Option<String>) {
        self.selected_id = node_id.clone();
        let index = node_id.as_ref().and_then(|id| self.node_ids.iter().position(|n| n == id));
        if let Some(renderer) = &mut self.renderer {
            renderer.set_selected(index);
        }
    }

    /// Get the current layout result as JSON
    #[wasm_bindgen(js_name = getLayoutResult)]
    pub fn get_layout_result(&self) -> Result<String, JsValue> {
        match &self.layout_result {
            Some(result) => serde_json::to_string(result)
                .map_err(|e| JsValue::from_str(&format!("Failed to serialize layout: {}", e))),
            None => Ok("null".to_string()),
        }
    }

    /// Get node count
    #[wasm_bindgen(js_name = nodeCount)]
    pub fn node_count(&self) -> usize {
        self.graph.as_ref().map(|g| g.nodes.len()).unwrap_or(0)
    }

    /// Get edge count
    #[wasm_bindgen(js_name = edgeCount)]
    pub fn edge_count(&self) -> usize {
        self.graph.as_ref().map(|g| g.edges.len()).unwrap_or(0)
    }
}

impl GraphRenderer {
    fn apply_hover_selection(&mut self) {
        let hovered_index = self
            .hovered_id
            .as_ref()
            .and_then(|id| self.node_ids.iter().position(|n| n == id));
        let selected_index = self
            .selected_id
            .as_ref()
            .and_then(|id| self.node_ids.iter().position(|n| n == id));

        if let Some(renderer) = &mut self.renderer {
            renderer.set_hovered(hovered_index);
            renderer.set_selected(selected_index);
        }
    }
}

/// Check if WebGPU is available
#[wasm_bindgen(js_name = isWebGPUAvailable)]
pub fn is_webgpu_available() -> bool {
    // Check if navigator.gpu exists
    let window = match web_sys::window() {
        Some(w) => w,
        None => return false,
    };

    let navigator = window.navigator();

    // Try to access GPU - this will fail gracefully if not available
    js_sys::Reflect::get(&navigator, &JsValue::from_str("gpu"))
        .map(|v| !v.is_undefined())
        .unwrap_or(false)
}
