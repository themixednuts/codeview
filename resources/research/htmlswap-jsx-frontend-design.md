# htmlswap JSX Frontend Design

This is a read-only research and design pass for adding a real JSX/TSX source frontend to htmlswap, targeting idiomatic Svelte 5 output. The existing compiler is HTML-family-first: the README describes `.dc.html`, `.html`, and `.vue` sources flowing through `HtmlDocument`, then `RenderPlan`, then adapters such as Svelte 5 (`README.md:5-14`, `README.md:21-27`, `README.md:100-112`). The design below assumes that existing HTML/DC/Vue behavior must remain unchanged.

## Oxc Version Confirmation

htmlswap already depends on the oxc crates needed for JSX parsing. `Cargo.toml` pins `oxc_allocator`, `oxc_ast`, `oxc_ast_visit`, `oxc_parser`, `oxc_span`, and `oxc_syntax` to `0.137.0` (`Cargo.toml:14-19`), and `Cargo.lock` resolves those same crates at `0.137.0` (`Cargo.lock:838-846`, `Cargo.lock:849-865`, `Cargo.lock:880-889`, `Cargo.lock:941-962`). The available AST is sufficient for JSX/TSX: `SourceType::jsx()` and `SourceType::tsx()` exist in this version (`C:/Users/jonfo/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/oxc_span-0.137.0/src/source_type.rs:303-317`, `.../source_type.rs:348-365`), `SourceType::from_path` recognizes `.jsx` and `.tsx` paths (`.../source_type.rs:566-607`), and `Parser::new(&allocator, source_text, source_type)` is the parser entrypoint (`C:/Users/jonfo/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/oxc_parser-0.137.0/src/lib.rs:248-278`).

The oxc AST exposes JSX as normal expression variants: `Expression::JSXElement` and `Expression::JSXFragment` (`C:/Users/jonfo/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/oxc_ast-0.137.0/src/ast/js.rs:149-152`). The JSX node types include `JSXElement` with opening element, children, and closing element (`.../oxc_ast-0.137.0/src/ast/jsx.rs:20-54`), `JSXFragment` with children (`.../jsx.rs:112-134`), `JSXElementName` for identifiers, member expressions, namespaces, and `this` (`.../jsx.rs:159-176`), `JSXExpressionContainer` (`.../jsx.rs:260-280`), `JSXAttributeItem::{Attribute, SpreadAttribute}` (`.../jsx.rs:320-337`), `JSXAttribute` with optional value (`.../jsx.rs:353-364`), `JSXSpreadAttribute` (`.../jsx.rs:376-383`), `JSXAttributeValue::{StringLiteral, ExpressionContainer, Element, Fragment}` (`.../jsx.rs:431-439`), and `JSXChild::{Text, Element, Fragment, ExpressionContainer, Spread}` (`.../jsx.rs:468-478`). Version-specific concern: keep oxc AST types private to `src/jsx.rs` because their lifetime/allocator shapes and variant names are tied to `0.137.0`.

## 1. Pipeline Hook Point

### Current Pipeline

The CLI currently exposes `--source` as a `SourceDialectKind` with only `Html`, `Dc`, and `Vue` variants (`src/main.rs:88-90`, `src/main.rs:641-646`). `CompileCommand::compiler` converts that enum to a `Frontend` and passes it into `Compiler::with_frontend` (`src/main.rs:175-185`, `src/main.rs:648-655`). `Compiler` stores only `CompilerOptions`, jobs/cache/resolver, and an `Arc<Frontend>` (`src/compiler.rs:37-44`), while `CompilerOptions` currently carries parallelism, resource options, and bundle options only (`src/compiler.rs:420-424`). `CompiledFragment` carries only `RenderPlan`, `SourceMap`, and `BundlePlan` (`src/compiler.rs:609-614`).

The actual compilation entry is `compile_fragment_with_jobs_and_cache` (`src/compiler.rs:653-662`). It always registers the primary source as `SourceKind::Html` (`src/compiler.rs:663-665`), parses that source through `parse_html_with_source` (`src/compiler.rs:695-703`), resolves HTML-linked CSS and scripts from the parsed document (`src/compiler.rs:709-725`), then calls `lower_document_with_context(&parsed.value, ...)` to produce a `RenderPlan` (`src/compiler.rs:840-849`). `parse_html_with_source` only switches between html5ever document and fragment parsing by `looks_like_html_document` (`src/compiler.rs:870-889`).

`parse.rs` confirms that HTML parsing is html5ever-based (`src/parse.rs:7-12`), with `parse_fragment_with_source` calling `parse_html_fragment(...).one(source)` (`src/parse.rs:29-48`) and `parse_document_with_source` calling `parse_html_document(...).one(source)` (`src/parse.rs:55-66`). The sink converts parsed output to `HtmlNode::Element`, `HtmlNode::Text`, and `HtmlNode::Comment` only (`src/parse.rs:402-428`).

`Frontend` and `SourceDialect` are post-parse abstractions. The trait accepts `HtmlElement`, `HtmlAttribute`, and `HtmlNode` inputs for attribute rewriting, inferred attributes, element lowering, and template parsing (`src/frontend.rs:52-95`). `Frontend` only dispatches those post-parse hooks over dialects (`src/frontend.rs:140-205`). This verifies the architectural context: DC and Vue work because their template syntax can be represented as already-parsed HTML plus attribute rewrites and `{{ }}` parsing (`src/frontend.rs:633-705`, `src/frontend.rs:741-770`, `src/frontend.rs:1090-1206`).

### Decision: Build RenderPlan Directly

The JSX frontend should not produce `HtmlDocument`. It should parse with oxc and build `RenderPlan` directly.

Reasoning:

- `HtmlDocument` cannot represent JSX expression children, fragments, spread attributes, map callback bodies, or component expressions. Its node enum is only `Element`, `Text`, and `Comment`, and attributes are only name plus string value (`src/ir.rs:5-53`).
- `SourceDialect` cannot see raw JSX syntax because it runs after html5ever has already produced `HtmlElement` and `HtmlAttribute` values (`src/frontend.rs:52-95`).
- The existing HTML lowerer expects HTML tags/attributes and DC/Vue rewrites, not JavaScript AST constructs (`src/lower.rs:488-576`, `src/lower.rs:590-747`).
- The docs already call out missing frontend primitives for JSX-like needs: typed dynamic bindings including `Class`, `Style`, and `Spread` (`docs/frontend-primitives.md:30-35`), typed event listeners (`docs/frontend-primitives.md:36-38`), loop metadata for keys/tracking (`docs/frontend-primitives.md:40-43`), transparent/fragment hosts (`docs/frontend-primitives.md:62-68`), and broader `Expr` (`docs/frontend-primitives.md:69-70`).

The direct path can still reuse shared data types: `RenderPlan`, `RenderElement`, `RenderText`, `RenderControlFlow`, `TemplateString`, `Expr`, `StyleDeclaration`, `ActionBinding`, `SourceMap`, diagnostics, and bundle planning are already public or crate-visible (`src/lib.rs:82-96`, `src/lib.rs:106-110`). Some lowerer helpers such as role inference, accessibility, style parsing, and action analysis are currently private to `lower.rs`/`script.rs` (`src/lower.rs:2032-2100`, `src/script.rs:1049-1058`), so the implementer should extract small reusable helpers only when the JSX lowerer needs equivalent behavior.

### Concrete Integration

Use a source-kind enum distinct from `Frontend`:

```rust
pub enum SourceFrontendKind {
    Html,
    Dc,
    Vue,
    Jsx,
}
```

Minimal CLI change: add `Jsx` to the existing `SourceDialectKind` so `htmlswap compile input.jsx --source jsx --adapter svelte` parses. Better API change: rename `SourceDialectKind` to `SourceFrontendKind` because JSX is not a dialect over parsed HTML. The current enum name is misleading once JSX exists (`src/main.rs:641-655`).

Carry the source choice in `CompilerOptions` or `Compiler`, not in `CompiledFragment`. `CompiledFragment` is an output envelope with `plan`, `sources`, and `bundle` only (`src/compiler.rs:609-614`), while `CompilerOptions` is where compile-time behavior already lives (`src/compiler.rs:420-470`). A conservative shape is:

```rust
pub struct CompilerOptions {
    pub parallelism: CompilerParallelism,
    pub resources: CompilerResourceOptions,
    pub bundle: BundleConfig,
    pub source_frontend: SourceFrontendKind,
}
```

Then `CompileCommand::compiler` should set `.with_source_frontend(self.source.into())` instead of only `.with_frontend(self.source.frontend())` (`src/main.rs:175-185`). `Compiler` can keep `frontend: Arc<Frontend>` for HTML-family sources and add `source_frontend: SourceFrontendKind`, or derive the HTML `Frontend` from `CompilerOptions` when the source is `Html`, `Dc`, or `Vue` (`src/compiler.rs:37-44`, `src/compiler.rs:96-104`).

In `compile_fragment_with_jobs_and_cache`, branch before registering the source as `SourceKind::Html` and before calling `parse_html_with_source`:

```rust
match source_frontend {
    SourceFrontendKind::Html | SourceFrontendKind::Dc | SourceFrontendKind::Vue => {
        // Existing path, unchanged.
    }
    SourceFrontendKind::Jsx => {
        let jsx_id = sources.add_file(SourceKind::JavaScript, name, source);
        let lowered = jsx::lower_jsx_module(JsxLowerInput {
            source_id: jsx_id,
            sources: &mut sources,
            assets,
            jobs,
            resolver,
            cache,
        });
        // Same CompiledFragment and BundlePlan envelope.
    }
}
```

`SourceKind` currently has only `Html`, `Css`, `JavaScript`, and `Unknown` (`src/source.rs:23-29`). Phase 0 can register JSX as `JavaScript` because oxc treats JSX as JavaScript syntax with a JSX flag, but a later `SourceKind::Jsx` would make diagnostics and generated source maps clearer. `SourceMap::add_file` already accepts a kind, optional name, and source text (`src/source.rs:258-267`).

Use a new private module `src/jsx.rs` for the first implementation. The crate already keeps parser/lowering helpers flat and private for `lower.rs`, `script.rs`, and `style.rs` (`src/lib.rs:18-27`), and `script.rs` is the closest oxc prior art (`src/script.rs:6-16`, `src/script.rs:221-259`). If the module grows past a single implementation unit, move it to `src/frontends/jsx/mod.rs` and keep the public API unchanged.

The JSX branch must bypass `looks_like_html_document` entirely. That function is HTML-only and only determines whether html5ever should parse a document or fragment (`src/compiler.rs:870-889`). JSX files such as `graph-banded.jsx` are JavaScript modules containing a component function and a `window.GraphBanded = GraphBanded` export shim (`E:/Projects/codeview/resources/codeview-handoff/codeview/project/graph-banded.jsx:58-83`, `.../graph-banded.jsx:190`), so the frontend must first find the component body in the oxc AST, then lower the returned JSX expression.

## 2. IR Survey

### HtmlDocument Path, If Considered

The HTML IR is intentionally small:

```rust
pub struct HtmlDocument {
    pub nodes: Vec<HtmlNode>,
}

pub enum HtmlNode {
    Element(HtmlElement),
    Text(HtmlText),
    Comment(HtmlComment),
}

pub struct HtmlElement {
    pub name: HtmlName,
    pub attributes: Vec<HtmlAttribute>,
    pub children: Vec<HtmlNode>,
    pub span: Option<Span>,
}

pub struct HtmlAttribute {
    pub name: HtmlName,
    pub value: CompactString,
    pub span: Option<Span>,
}
```

These definitions are in `src/ir.rs:5-53`. They are sufficient for parsed HTML and for DC/Vue rewrites, but they have no slots for JSX expression containers, spread attributes, keyed fragments, component references, or hook/source-logic declarations.

### RenderPlan And Render Nodes

The target-neutral plan is the right integration target:

```rust
pub struct RenderPlan {
    pub nodes: Vec<RenderNode>,
    pub root: RenderRoot,
    pub head: Vec<RenderHeadElement>,
    pub annotations: Vec<RenderAnnotation>,
    pub state: RenderStatePlan,
    pub scripts: Vec<RenderScriptReference>,
    pub source_logic: Vec<RenderSourceLogic>,
    pub theme: RenderThemePlan,
}

pub enum RenderNode {
    Element(Box<RenderElement>),
    Text(RenderText),
    Raw(RenderRaw),
}
```

`RenderPlan` is defined at `src/plan.rs:210-220`, and `RenderNode` is defined at `src/plan.rs:605-609`. `RenderPlan::new` derives a `RenderStatePlan` from nodes (`src/plan.rs:222-284`), so JSX lowering can construct nodes first and let existing state collection run where it still applies.

`RenderElement` is the main host-element shape:

```rust
pub struct RenderElement {
    pub role: UiRole,
    pub source_tag: CompactString,
    pub attributes: Vec<RenderAttribute>,
    pub classes: Vec<CompactString>,
    pub styles: Vec<StyleDeclaration>,
    pub style_variants: Vec<RenderStyleVariant>,
    pub dynamic_styles: Vec<RenderDynamicStyleBinding>,
    pub pseudo_elements: Vec<RenderPseudoElement>,
    pub actions: Vec<ActionBinding>,
    pub state: Option<RenderStateBinding>,
    pub form_control: Option<RenderFormControl>,
    pub accessibility: Option<RenderAccessibility>,
    pub control_flow: Option<Box<RenderControlFlow>>,
    pub source_intent: Option<Box<RenderSourceIntent>>,
    pub semantics: Option<RenderSemantics>,
    pub region: Option<RegionId>,
    pub children: Vec<RenderNode>,
    pub span: Option<Span>,
}
```

This definition is in `src/plan.rs:612-631`. JSX host elements should primarily lower to `RenderNode::Element(Box<RenderElement>)`.

Attributes, text, dynamic styles, and control flow are:

```rust
pub struct RenderAttribute {
    pub name: CompactString,
    pub value: Option<CompactString>,
    pub template: Option<TemplateString>,
    pub span: Option<Span>,
}

pub struct RenderDynamicStyleBinding {
    pub state: Option<CompactString>,
    pub expression: TemplateString,
    pub span: Option<Span>,
}

pub struct RenderControlFlow {
    pub kind: RenderControlFlowKind,
    pub host: RenderControlFlowHost,
    pub expression: Option<Expr>,
    pub binding: Option<BindingPattern>,
    pub placeholder: Option<TemplateString>,
    pub span: Option<Span>,
}

pub enum RenderControlFlowHost {
    Wrapper,
    Element,
}

pub enum RenderControlFlowKind {
    For,
    If,
    ElseIf,
    Else,
    Switch,
    Case,
    Default,
}

pub struct RenderText {
    pub value: String,
    pub template: Option<TemplateString>,
    pub span: Option<Span>,
}
```

These definitions are in `src/plan.rs:633-680`. The important gap is that `RenderControlFlowHost` has no transparent/fragment host, even though the frontend primitive design says one is likely needed (`docs/frontend-primitives.md:62-68`).

Actions are already modeled but are event-handler-centric:

```rust
pub struct ActionBinding {
    pub event: CompactString,
    pub expression: Option<CompactString>,
    pub template: Option<TemplateString>,
    pub action: Option<CompactString>,
    pub resolved: bool,
    pub handler: Option<RenderActionHandler>,
    pub payload: ActionPayload,
    pub span: Option<Span>,
    pub action_span: Option<Span>,
}

pub struct RenderActionHandler {
    pub invocations: Vec<RenderActionInvocation>,
    pub effects: Vec<RenderActionHandlerEffect>,
}
```

`ActionBinding` and handler shapes are defined in `src/plan.rs:731-759`. The existing lowerer creates them from HTML `on*` attributes and `script.rs` action analysis (`src/lower.rs:2032-2072`, `src/script.rs:1049-1058`).

State is currently form/control oriented:

```rust
pub struct RenderStatePlan {
    pub bindings: Vec<RenderStateBinding>,
    pub forms: Vec<RenderFormBinding>,
    pub actions: Vec<RenderActionPlan>,
}

pub struct RenderStateBinding {
    pub id: CompactString,
    pub owner: RenderStateOwner,
    pub kind: RenderStateKind,
    pub span: Option<Span>,
}

pub enum RenderStateKind {
    TextInput(RenderTextInputState),
    Choice(RenderChoiceState),
    Toggle(RenderToggleState),
}
```

Those definitions are in `src/plan.rs:806-922`. There is no generic local component state, derived value, effect, callback, or ref primitive yet. The HTML lowerer only creates state for form controls such as text inputs, selects, checkboxes, and radios (`src/lower.rs:1214-1303`, `src/lower.rs:1452-1484`).

`RenderSourceLogic` exists, but it is currently DC-specific in the Svelte adapter:

```rust
pub struct RenderSourceLogic {
    pub dialect: CompactString,
    pub script_type: CompactString,
    pub body: CompactString,
    pub data_props: Option<CompactString>,
    pub span: Option<Span>,
}
```

The struct is defined at `src/plan.rs:596-602`. The Svelte adapter only collects source logic with `dialect == "dc"` (`src/adapters/svelte.rs:245-249`) and writes a DC bridge (`src/adapters/svelte.rs:542-707`), so JSX will need a new source-logic path or new neutral component-script primitives.

### TemplateString And Expr

Templates and expressions are currently intentionally small:

```rust
pub struct TemplateString {
    pub raw: CompactString,
    pub segments: Vec<TemplateSegment>,
    pub span: Option<Span>,
}

pub enum TemplateSegment {
    Literal(CompactString),
    Expression(Expr),
}

pub enum Expr {
    Path(Vec<CompactString>),
    Call {
        callee: Box<Expr>,
        arguments: Vec<Expr>,
    },
    Literal(ExprLiteral),
    Opaque(CompactString),
}
```

These definitions are in `src/expr.rs:7-59`. The current parser only creates literal/path/zero-argument-call/opaque expressions from `{{ }}` templates (`src/frontend.rs:672-705`). JSX needs a broader expression subset, described in section 4.

## 3. JSX -> IR Mapping Table

| JSX construct | Target IR | Gaps and notes |
| --- | --- | --- |
| `JSXElement` with a host tag such as `<div>` or `<svg>` | Lower lowercase and intrinsic SVG names to `RenderElement { source_tag, role, attributes, classes, styles, children, span }` (`src/plan.rs:612-631`). Use existing role mappings as a shared helper or duplicated table from `lower.rs` (`src/lower.rs:2074-2100`). | SVG must preserve names such as `textAnchor`, `strokeWidth`, and `fillOpacity` from the corpus (`graph-banded.jsx:119-125`, `graph-banded.jsx:143-153`). Svelte/HTML should receive kebab-case SVG attributes where appropriate. |
| Attribute names | Map `className -> class`, `htmlFor -> for`, `defaultValue -> value`, `defaultChecked -> checked`, React camel-case DOM/SVG attributes to HTML/SVG spellings, and pass through `aria-*`/`data-*`. Boolean JSX attrs with no value map to `RenderAttribute { value: None, template: None }` (`src/plan.rs:633-639`). | The HTML boolean list currently lives in `frontend.rs` (`src/frontend.rs:1060-1088`). Move or duplicate it for JSX. React SVG attrs need a focused mapping table, starting with attrs observed in `shared.jsx:5-16` and `graph-banded.jsx:98-176`. |
| Static `className="..."` | Split into `RenderElement.classes` the same way HTML lowering handles `class` (`src/lower.rs:590-604`). Svelte already joins `classes` into `class="..."` (`src/adapters/svelte.rs:1154-1188`). | Tailwind pass-through is mostly ready for static classes; the corpus is heavy on Tailwind strings such as `home-terminal.jsx:22-24` and `graph-banded.jsx:83-90`. |
| Dynamic `className={`...${x}...`}`, `className={cond ? "a" : "b"}`, concatenations | Add a class binding primitive, preferably the `RenderBinding`/`Class` primitive proposed in docs (`docs/frontend-primitives.md:30-35`). For a first slice, store the whole dynamic class as a `TemplateString` and teach Svelte to emit `class={...}` or `class={`...`}`. | Existing `RenderElement.classes` is static only (`src/plan.rs:612-631`). `RenderAttribute` named `class` is skipped by Svelte's attribute writer (`src/adapters/svelte.rs:1213-1224`, `src/adapters/svelte.rs:1491-1503`), so just pushing a dynamic `class` attribute will be lost unless the adapter changes. |
| `style={{ ... }}` static object | Convert object properties to `StyleDeclaration` with `StyleProperty` and `StyleValue` (`src/style.rs:14-20`, `src/style.rs:56-149`, `src/style.rs:366-373`). Convert React camelCase style keys to CSS kebab-case, including vendor prefixes. | Numeric values need React-like unit handling. The corpus uses numeric `width`, `height`, `fontSize`, `borderRadius`, and unitless `lineHeight` (`home-terminal.jsx:22-33`, `palette-spec.jsx:59-72`, `graph-banded.jsx:83-84`). Existing style values classify lengths/keywords but do not know React's unitless CSS whitelist (`src/style.rs:383-485`). |
| `style={{ color: expr }}` or computed object | Use `RenderDynamicStyleBinding { state: None, expression: TemplateString::single(Expr) }` (`src/plan.rs:641-646`). Svelte already has `__htmlswap_style` for dynamic style objects (`src/adapters/svelte.rs:719-760`, `src/adapters/svelte.rs:1289-1314`, `src/adapters/svelte.rs:1728-1732`). | The dynamic helper can stringify JS objects, but the frontend must preserve object literals and references as expressions. `Expr::Opaque` is workable for emission but poor for dependency/root analysis (`src/adapters/svelte.rs:1736-1760`, `src/adapters/svelte.rs:1762-1808`). |
| Event listener `onClick={handler}` | Lower to `ActionBinding { event: "click", expression: Some("handler"), handler: ... }` (`src/plan.rs:731-759`). Reuse or extract `analyze_event_handler` for function/arrow/call analysis (`src/script.rs:1049-1058`, `src/script.rs:1088-1150`, `src/script.rs:1209-1275`). Svelte already emits Svelte 5 event attributes such as `onclick={...}` (`src/adapters/svelte.rs:1316-1324`, `tests/svelte_adapter.rs:27-48`). | Current action analysis handles simple invocations and effects; it does not model listener options, event modifiers, component callback props, or arbitrary statement bodies. Frontend primitives call for typed listeners with options/effects (`docs/frontend-primitives.md:36-38`). |
| Inline handler `onClick={() => f(x)}` | Preserve the arrow function source as `ActionBinding.expression` and, where possible, parse invocations into `RenderActionHandler`. Svelte can pass arrow expressions through if normalized as an action expression (`src/adapters/svelte.rs:1565-1655`). | Handler bodies that mutate React state setters must be transformed with hook state modeling, not just copied. `tweaks-panel.jsx` has arrow handlers that call `onChange` and setters (`tweaks-panel.jsx:342-354`, `tweaks-panel.jsx:541-542`). |
| `{expr}` text child | Lower to `RenderText { value: "", template: Some(TemplateString { segments: [Expression(expr)] }) }` (`src/plan.rs:675-680`, `src/expr.rs:7-48`). Svelte emits text templates as `{expr}` (`src/adapters/svelte.rs:1346-1355`, `src/adapters/svelte.rs:1700-1708`). | Whitespace-sensitive JSX text normalization must be implemented. JSX text is not identical to HTML text, especially around expression containers and newlines. |
| `{cond && <X/>}` | Lower to `RenderControlFlowKind::If` with expression `cond`, hosted on the lowered `X` element when the child is a single element (`src/plan.rs:648-673`). | If the guarded child is a fragment or text, current IR needs a transparent host. The docs already flag this (`docs/frontend-primitives.md:62-68`). |
| `{a ? <X/> : <Y/>}` | Lower adjacent `RenderElement`s as `If` plus `Else`, following the Svelte adapter's existing if-chain emission (`src/adapters/svelte.rs:955-1014`). | Current `RenderControlFlow` has no explicit branch grouping; adjacency order must be preserved carefully. Ternaries appear in inline styles and attrs as well as JSX branches (`graph-banded.jsx:78`, `explorer.jsx:122-144`). |
| `{list.map((item, i) => <X key=... />)}` | Lower to `RenderControlFlowKind::For` with `expression = list`, `binding = item`, and children from the callback return (`src/plan.rs:648-673`). Svelte already emits `{#each expr as binding, $index}` (`src/adapters/svelte.rs:1016-1044`). | Add key/track/index metadata. Current control flow has no key or track field (`src/plan.rs:648-656`), and docs call that out (`docs/frontend-primitives.md:40-43`). `graph-banded.jsx` also has block-bodied map callbacks with local `const` declarations before the returned JSX (`graph-banded.jsx:105-143`); Svelte needs `{@const ...}` or equivalent IR for loop-local declarations. |
| `<>...</>` and `<React.Fragment>` | Inline children where no control flow/key/attrs are attached. For keyed or control-flow fragments, add a transparent host to `RenderControlFlowHost` or add a `RenderNode::Fragment`. | Existing `RenderNode` has no fragment variant (`src/plan.rs:605-609`). The corpus uses fragments in `shared.jsx:30-35`, `doc-parts.jsx:48-55`, and `tweaks-panel.jsx:291-310`. |
| `<Component prop={x}>{children}</Component>` | Short-term: lower to `RenderElement` with `source_tag = "Component"` plus `RenderSourceIntent { component, props, ... }`, following current component hints (`src/plan.rs:1129-1138`, `src/plan.rs:1365-1371`). Long-term: implement the `RenderNode::Use` component model proposed in `docs/components.md:84-114`. | Current Svelte component emission only recognizes `dc-import`/`x-import` or a component source (`src/adapters/svelte.rs:1476-1483`). The docs say `RenderSourceIntent` is temporary and should not remain the primary component representation (`docs/components.md:295-316`). |
| `<Icon.chevronRight />`, `<window.KindBadge />`, dynamic component expressions | Represent as component references, not host tags. If unresolved, preserve as `Foreign` component usage per component docs (`docs/components.md:77-82`, `docs/components.md:271-289`). | Svelte cannot emit React-style member component syntax directly as an HTML tag. `home-terminal.jsx` uses `<Icon.chevronRight />` (`home-terminal.jsx:78`), and `explorer.jsx` uses `<window.KindBadge />` and `<window.Icon.* />` (`explorer.jsx:69`, `explorer.jsx:88`, `explorer.jsx:218-245`). |
| `{...spread}` on elements or components | Add a typed spread binding as proposed in frontend primitives (`docs/frontend-primitives.md:30-35`). Svelte can emit `{...spread}` once the adapter has the data. | `HtmlAttribute` and `RenderAttribute` cannot represent spread today (`src/ir.rs:48-53`, `src/plan.rs:633-639`). The corpus uses SVG/icon prop spreads in `shared.jsx:5-16`. |
| Function component props destructuring | Parse component parameters and lower to source props. Svelte already has a `$props()` writer for inferred expression roots (`src/adapters/svelte.rs:512-539`). | Current prop inference roots ignore `Expr::Opaque` and only recurse paths/calls (`src/adapters/svelte.rs:1762-1808`). Destructured/default props such as `function Swatch({ name, varName, hex, light = true })` need explicit modeling (`palette-spec.jsx:7-23`). |
| `useState` | Add generic local component state to `RenderStatePlan` or a new component-source-logic plan. Adapter should decide Svelte spelling, usually `let x = $state(init)`. | Current `RenderStateKind` is only text input, choice, and toggle (`src/plan.rs:917-922`). Hooks appear in `explorer.jsx:167-184`, `theme-tweaks.jsx:55-65`, and `tweaks-panel.jsx:162-176`, `tweaks-panel.jsx:186-260`. |
| `useMemo` | Lower semantic derived values with dependencies. Svelte adapter should emit `$derived(...)` or `$derived.by(...)` depending on expression/body complexity. | Svelte adapter already emits `$derived.by` only in its DC bridge (`src/adapters/svelte.rs:542-707`), not from neutral IR. `tweaks-panel.jsx` uses `React.useMemo` (`tweaks-panel.jsx:195-198`). |
| `useRef` | Lower refs as component local mutable references. For DOM refs on elements, add an element binding that the Svelte adapter can emit as `bind:this`. For non-DOM mutable refs, emit plain local object/value. | No current ref primitive exists in `RenderStatePlan` (`src/plan.rs:806-922`). Refs appear in `tweaks-panel.jsx:187-188`, `tweaks-panel.jsx:222-237`, and `tweaks-panel.jsx:360-364`. |
| `useCallback` | Lower as a named function/const in source logic, with dependency metadata if known. Svelte usually does not need `useCallback`, so the adapter can emit a normal function or const arrow. | Hook semantics belong in frontend/source-logic IR; Svelte rune spelling belongs in the adapter. `useCallback` appears in `tweaks-panel.jsx:167-175` and `tweaks-panel.jsx:225-237`. |
| `useEffect` | Lower effect body plus dependency list to a neutral effect primitive. Svelte adapter should emit `$effect` or `onMount`/cleanup when dependencies are empty or lifecycle-specific. | Existing `$effect`/lifecycle output is hard-coded for DC source logic (`src/adapters/svelte.rs:542-707`, `src/adapters/svelte.rs:1932-1938`). Effects appear in `theme-tweaks.jsx:59-65` and `tweaks-panel.jsx:207-260`. |

## 4. Expr Subset

The existing `Expr` is too small for JSX. It has only `Path`, `Call`, `Literal`, and `Opaque` (`src/expr.rs:50-59`). The Svelte adapter can print those forms (`src/adapters/svelte.rs:1736-1760`), but root extraction for props only understands `Path` and `Call` (`src/adapters/svelte.rs:1762-1808`). The HTML/DC parser also only recognizes literals, paths, and zero-argument calls from template strings (`src/frontend.rs:672-705`).

Corpus expressions that need support:

- Member chains and globals: `window.KindBadge`, `window.Icon.chevronRight`, `node.path`, `offsetRef.current.x`, and `e.currentTarget.style.background` (`explorer.jsx:69-88`, `explorer.jsx:116-138`, `tweaks-panel.jsx:225-237`).
- Calls and method chains: `String(i + 1).padStart(...)`, `Math.max(...)`, `parts.slice(...).join(...)`, `data.map(...).toFixed(...)`, `.find(...)`, and `.filter(...)` (`home-terminal.jsx:90-94`, `shared.jsx:92-100`, `explorer.jsx:42-51`, `theme-tweaks.jsx:86-90`, `tweaks-panel.jsx:379-385`).
- Conditional, logical, and nullish-like patterns: `active ? ... : ...`, `breadcrumb && (...)`, `node.sig && ...`, `count != null && ...` (`shared.jsx:30-35`, `doc-parts.jsx:113-114`, `explorer.jsx:152-157`, `graph-banded.jsx:78`).
- Binary and arithmetic expressions: `10 + depth * 14`, `W / 2`, `H / 2 + 6`, and template CSS calculations (`explorer.jsx:59-67`, `graph-banded.jsx:59-71`, `tweaks-panel.jsx:419-420`).
- Template literals: SVG paths and transforms such as `` `translate(${pos.x}, ${pos.y})` `` and class names such as `` `plate ${themeClass} flex flex-col` `` (`graph-banded.jsx:143`, `doc-reading.jsx:29-31`).
- Object and array literals: style objects, data arrays, and object spreads in state updates (`palette-spec.jsx:12-15`, `graph-banded.jsx:9-47`, `tweaks-panel.jsx:167-175`).
- Arrow functions: map callbacks and event handlers (`home-terminal.jsx:59-61`, `graph-banded.jsx:101-157`, `tweaks-panel.jsx:342-354`, `tweaks-panel.jsx:541-542`).

Recommended first-class additions:

```rust
pub enum Expr {
    Path(Vec<CompactString>),
    Member { object: Box<Expr>, property: MemberProperty, optional: bool },
    Index { object: Box<Expr>, index: Box<Expr>, optional: bool },
    Call { callee: Box<Expr>, arguments: Vec<Expr>, optional: bool },
    Literal(ExprLiteral),
    Unary { op: UnaryOp, argument: Box<Expr> },
    Binary { op: BinaryOp, left: Box<Expr>, right: Box<Expr> },
    Logical { op: LogicalOp, left: Box<Expr>, right: Box<Expr> },
    Conditional { test: Box<Expr>, consequent: Box<Expr>, alternate: Box<Expr> },
    TemplateLiteral { segments: Vec<TemplateSegment> },
    Array(Vec<ExprOrSpread>),
    Object(Vec<ObjectEntry>),
    ArrowFunction { params: Vec<BindingPattern>, body: ArrowBody },
    Opaque(CompactString),
}
```

Do not try to model all JavaScript statements in `Expr` for the first version. Carry full function bodies, effect bodies, complex assignments, TypeScript-specific constructs, imports/exports, and unknown syntax as source text in source-logic nodes or `Opaque`. This follows existing `script.rs` precedent: it parses with oxc, extracts the narrow data it needs, and keeps spans/source text for actions and diagnostics (`src/script.rs:221-259`, `src/script.rs:997-1058`).

Blast radius:

- `src/adapters/svelte.rs`: extend `svelte_expr`, `expression_roots`, `loose_expression_roots`, style bindings, and control-flow emission (`src/adapters/svelte.rs:1700-1808`).
- `src/frontend.rs`: existing DC/Vue expression parsing can keep producing the old variants; no need to parse richer HTML templates immediately (`src/frontend.rs:672-739`, `src/frontend.rs:1190-1206`).
- `src/lower.rs`: `sc-for` scoped binding currently expects `Expr::Path` for list roots (`src/lower.rs:974-990`), so new variants must not break existing DC behavior.
- Text/HTML/debug emitters rely mostly on `Display`/string forms for expressions and should continue to work if every new variant has a `Display` implementation (`src/expr.rs:68-93`, `src/emit.rs:51-59`).

## 5. Svelte Adapter Readiness

What is already ready:

- The adapter targets Svelte 5 and writes a version comment with `SVELTE_PACKAGE_VERSION = 5.56.4` (`src/adapters/svelte.rs:22-23`, `src/adapters/svelte.rs:201-211`).
- It emits Svelte 5 event attributes such as `onclick`, not legacy `on:click`; tests assert this (`src/adapters/svelte.rs:1316-1324`, `tests/svelte_adapter.rs:27-48`).
- It emits `$props()` for inferred props and snippet children (`src/adapters/svelte.rs:512-539`, `tests/svelte_adapter.rs:62-78`).
- It emits target-owned form state as `$state` plus `bind:value`/`bind:checked` (`src/adapters/svelte.rs:229-239`, `src/adapters/svelte.rs:1264-1287`, `tests/svelte_adapter.rs:50-60`).
- It emits `{#if}` and `{#each}` for existing `RenderControlFlow` (`src/adapters/svelte.rs:887-1044`, `tests/svelte_adapter.rs:80-93`).
- It emits scoped `<style>` blocks for collected style rules and pseudo-state variants (`src/adapters/svelte.rs:862-885`, `tests/svelte_adapter.rs:215-226`).
- It has a dynamic style helper that can stringify object-like style values (`src/adapters/svelte.rs:719-760`, `src/adapters/svelte.rs:1289-1314`).

Concrete gaps for React-origin JSX:

- Generic local state is missing. `$state` output exists only for `RenderStateKind::{TextInput, Choice, Toggle}` (`src/plan.rs:917-922`, `src/adapters/svelte.rs:1672-1698`). React `useState` needs a neutral local-state primitive or a JSX source-logic plan.
- Derived/effect output is DC-bridge-specific. `$derived.by`, `$effect`, `onMount`, and `tick` are emitted inside `write_source_logic_bridge` for `dialect == "dc"` (`src/adapters/svelte.rs:245-249`, `src/adapters/svelte.rs:542-707`). JSX hooks should not reuse the DC class bridge.
- Keyed each blocks are missing. Current output is `{#each expr as binding, $index}` with no key expression (`src/adapters/svelte.rs:1016-1044`), while JSX `key` is common in map output (`home-terminal.jsx:59-61`, `graph-banded.jsx:117-143`).
- Dynamic classes are missing as a first-class output path. Static classes work (`src/adapters/svelte.rs:1154-1188`), but Svelte skips `class` attributes in the general attribute loop (`src/adapters/svelte.rs:1213-1224`, `src/adapters/svelte.rs:1491-1503`).
- Component usage is DC/import-specific. `should_emit_svelte_component` requires `source_intent.component` plus `dc-import`/`x-import` source tags or component source metadata (`src/adapters/svelte.rs:1476-1483`). JSX uppercase tags and member components need component IR or adapter recognition.
- Spreads have no IR or adapter output. The docs list spread as a binding target (`docs/frontend-primitives.md:30-35`), but neither `RenderAttribute` nor Svelte attribute emission has spread support (`src/plan.rs:633-639`, `src/adapters/svelte.rs:1154-1248`).
- Component setup/source logic is missing. JSX files have module constants, function-local constants, helper functions, and browser APIs that must move into `<script lang="ts">`; current `RenderSourceLogic` is collected only for DC (`src/plan.rs:596-602`, `src/adapters/svelte.rs:245-249`).
- Loop-local declarations need an IR path. `graph-banded.jsx` computes `a0`, `a1`, `midA`, `labelPos`, and other values inside `.map` callbacks before returning JSX (`graph-banded.jsx:105-143`). Idiomatic Svelte 5 can use `{@const ...}` inside `{#each}`, but the current `RenderControlFlow` has no local declaration field (`src/plan.rs:648-656`).
- SVG attribute spelling needs explicit handling. The corpus contains many SVG elements and camel-case SVG props (`shared.jsx:5-16`, `graph-banded.jsx:98-176`), while the HTML lowerer was designed around parsed HTML attributes.

The Svelte 5 runes decision should live in the Svelte adapter, not in the JSX frontend. The frontend should lower React concepts into neutral state/derived/effect/ref/source-logic data. The adapter should decide whether that becomes `$state`, `$derived`, `$derived.by`, `$effect`, `onMount`, `bind:this`, snippets, or normal local functions. This matches the repo's adapter boundary: `RenderPlan` is target-neutral and adapters own target code generation (`README.md:21-27`, `docs/components.md:19-21`, `docs/components.md:212-234`).

## 6. Phasing

### Phase 0: End-to-End Tracer Bullet

Recommended gate file: `E:/Projects/codeview/resources/codeview-handoff/codeview/project/graph-banded.jsx`.

Why this file: it is a real handoff view, has no uppercase component tags (`graph-banded.jsx:58-83`, `graph-banded.jsx:190`), avoids React hooks, and still exercises real JSX host tags, SVG, style objects, text interpolation, static Tailwind classes, array `.map`, block-bodied map callbacks, template literals, ternaries, and module/local constants (`graph-banded.jsx:59-83`, `graph-banded.jsx:98-157`, `graph-banded.jsx:178-186`). It is a better first gate than `home-terminal.jsx`, which immediately depends on `TopBar`, `KindIcon`, and `Icon.chevronRight` (`home-terminal.jsx:23`, `home-terminal.jsx:75-78`), or `palette-spec.jsx`, which depends on local and external components (`palette-spec.jsx:7-23`, `palette-spec.jsx:25-31`, `palette-spec.jsx:34-63`, `palette-spec.jsx:142-147`).

Scope:

- Add `--source jsx` and compiler branch to oxc, bypassing html5ever (`src/main.rs:88-90`, `src/compiler.rs:653-703`, `src/compiler.rs:870-889`).
- Add `src/jsx.rs` with oxc parse diagnostics, source span conversion, component selection, and JSX return lowering. Use `script.rs` parse/diagnostic structure as prior art (`src/script.rs:221-259`, `src/script.rs:989-995`).
- Lower one selected function component assigned to `window.Name` or exported/default function. `graph-banded.jsx` ends with `window.GraphBanded = GraphBanded` (`graph-banded.jsx:190`).
- Preserve module constants and component setup declarations in a JSX source-logic/prelude structure so Svelte can emit them in `<script lang="ts">` (`graph-banded.jsx:9-80`).
- Support host HTML/SVG elements, static classes, style object literals, expression attributes, text expression containers, and `.map` to `{#each}`.
- Add just enough control-flow metadata for map callback locals and key expressions, because `graph-banded.jsx` needs both `key={...}` and callback-local `const` values (`graph-banded.jsx:101-157`).
- Svelte output must compile as a standalone `.svelte` component.

Files touched in implementation:

- `src/main.rs`, `src/compiler.rs`, `src/source.rs`, `src/lib.rs`, new `src/jsx.rs`.
- `src/expr.rs` for the minimum expression forms needed by `graph-banded.jsx`.
- `src/plan.rs` for keyed each and loop-local declarations, unless encoded in a new source-logic structure.
- `src/adapters/svelte.rs` for JSX source logic, `{@const}`, SVG attrs, dynamic style object output, and keyed each.
- `tests/jsx_frontend.rs` and/or `tests/jsx_svelte.rs`.

Tests:

- Unit: parse a minimal JSX component and assert diagnostics are empty.
- IR: lower `<div className="p-2">{label}</div>` to `RenderElement.classes` plus `RenderText.template`.
- IR: lower `[1,2].map((x) => <span key={x}>{x}</span>)` to `RenderControlFlowKind::For` with a key.
- Svelte: compile/lower a minimized `graph-banded` fixture and assert output contains `<svg`, `{#each SECTORS as s`, `{@const a0`, keyed each if modeled, and no React `className`.

### Phase 1: Attribute, Style, Class, And SVG Completeness

Gate files: `graph-banded.jsx` full file, then `home-terminal.jsx` with external components temporarily diagnosed or stubbed (`home-terminal.jsx:20-126`).

Scope:

- DOM/SVG attr mapping table.
- React style object numeric-unit handling and CSS variable preservation.
- Dynamic `className` output.
- JSX text whitespace normalization.
- `<style>{`...`}</style>` support for source CSS, needed by `home-terminal.jsx:121`.

Tests:

- Style object `width: 1280` emits `width: 1280px`, while `lineHeight: 1.05` stays unitless.
- SVG `strokeWidth` emits valid Svelte/SVG.
- Dynamic class emits `class={...}` and static Tailwind classes remain intact.

### Phase 2: Components, Fragments, And Spreads

Gate files: `shared.jsx`, `palette-spec.jsx`, `home-terminal.jsx`.

Scope:

- Local function component detection and same-file component lowering.
- Foreign/member component representation for `Icon.search`, `window.KindBadge`, and related patterns (`shared.jsx:4-16`, `explorer.jsx:69-88`).
- JSX fragments and `React.Fragment` (`shared.jsx:30-35`, `doc-parts.jsx:48-55`, `doc-parts.jsx:188`).
- Element/component spread attrs (`shared.jsx:5-16`).
- Children/snippet handling for Svelte 5, building on existing snippet support (`src/adapters/svelte.rs:512-539`, `tests/svelte_adapter.rs:62-78`).

Tests:

- Same-file component emits a Svelte component, snippet, or flattened fragment according to the chosen component strategy.
- `<Icon.search {...p} />` produces a diagnostic or valid component/spread output, not a silently broken tag.
- Fragment with keyed children preserves order and keys.

### Phase 3: Control Flow Beyond Simple Map

Gate files: `doc-parts.jsx`, `doc-classic.jsx`, `doc-reading.jsx`.

Scope:

- `&&`, ternary JSX branches, null returns, and nested if/else chains.
- `.map` callbacks with early `if` returns and multiple branches (`doc-parts.jsx:48-55`).
- Keyed each and optional empty/fallback branch metadata.
- Better expression roots for props/defaults.

Tests:

- `{cond && <span/>}` emits `{#if cond}`.
- `{cond ? <A/> : <B/>}` emits one if/else chain.
- Map callback with `if (...) return <br/>; return <span/>;` emits equivalent Svelte without raw React code.

### Phase 4: React Hooks And Component State

Gate files: `explorer.jsx`, `theme-tweaks.jsx`, then `tweaks-panel.jsx`.

Scope:

- `useState` to neutral local state and Svelte `$state`.
- Setter rewriting: `setX(v)`, `setX(prev => ...)`, object spreads.
- `useMemo` to derived values.
- `useRef` to local refs or `bind:this` where attached to an element.
- `useCallback` to local functions.
- `useEffect` to `$effect`/`onMount` with cleanup.
- Event handlers that close over component state.

Tests:

- `const [open, setOpen] = React.useState(false)` emits `let open = $state(false)`.
- `setValues(prev => ({ ...prev, ...edits }))` emits a state assignment preserving object spread semantics.
- `useEffect(() => { add; return cleanup; }, [])` emits valid Svelte lifecycle/effect code.

### Phase 5: Corpus Hardening

Gate files: `graph-focus.jsx`, `design-canvas.jsx`, and all `project/*.jsx`.

Scope:

- More SVG/path-heavy views.
- Complex callbacks and browser APIs.
- Imports/exports/module graph if the handoff corpus moves away from global `window.*` patterns.
- Diagnostics for unsupported React features instead of silent lossy output.

Tests:

- Add minimized regression fixtures for every unsupported construct found.
- Add a corpus compile smoke test outside normal CI or behind an env var, because the source path is outside the htmlswap repo.

## 7. Testing

Current test structure:

- `tests/pipeline.rs` is the main RenderPlan integration test file. It defines helpers for finding elements and asserts directly on `RenderPlan` fields (`tests/pipeline.rs:39-72`, `tests/pipeline.rs:74-101`). It also tests full document parsing, default frontend behavior, regions/semantics, styles, spans, actions, and source maps (`tests/pipeline.rs:103-214`, `tests/pipeline.rs:2631-2712`).
- `tests/svelte_adapter.rs` uses inline source strings, compiles them through `Compiler`, adapts with `SvelteAdapter`, and asserts on output substrings (`tests/svelte_adapter.rs:1-25`). It covers Svelte 5 event attrs, `$state`, snippets, control flow, source-owned inputs, component imports, and pseudo styles (`tests/svelte_adapter.rs:27-226`).
- `tests/dc_bundle.rs` covers DC component import expansion and source-span preservation (`tests/dc_bundle.rs:1-112`).
- `tests/html_emitter.rs` checks recoverable HTML output with inline source and substring assertions (`tests/html_emitter.rs:1-24`).
- `tests/common/mod.rs` contains helper parsing for generated GPUI child call assertions, not general fixtures (`tests/common/mod.rs:1-185`).
- The `tests` tree has Rust integration test files and no golden fixture directory today (`tests/common/mod.rs`, `tests/pipeline.rs`, `tests/svelte_adapter.rs`, etc.).

Proposed JSX test layout:

- `tests/jsx_frontend.rs`: focused compiler/IR tests for oxc parse errors, component selection, JSXElement host tags, JSX text normalization, attrs, style object lowering, event lowering, map/if/ternary lowering, fragments, spreads, and spans.
- `tests/jsx_svelte.rs`: adapter-level tests using a helper like `emit_svelte_jsx(source: &str) -> String`, mirroring `tests/svelte_adapter.rs:6-25`.
- `tests/fixtures/jsx/`: add this only once real handoff outputs become too large for inline strings. The current project style favors inline inputs and substring assertions, but full real views such as `graph-banded.jsx` are large enough to justify fixture files after Phase 0.
- Optional `tests/fixtures/svelte/` snapshots: useful once the output stabilizes, but avoid brittle full-file goldens for early phases. Prefer semantic substrings plus a Svelte compile smoke.
- Svelte compile validation: add a Node/Svelte compiler smoke only if the repo is ready to carry that test dependency. The existing Rust tests do a `cargo check` smoke for GPUI examples (`tests/gpui_smoke_example.rs:4-25`) but have no Node/Svelte compile test.

Test gates per phase should use minimized fixtures copied from the corpus, not absolute `E:/Projects/...` paths, so CI and other workspaces can run them. The absolute corpus path is appropriate for local research and manual phase gates.

## 8. Risks, Open Questions, And Effort

Risks:

- IR gaps are larger than the parser work. JSX needs fragments, spreads, dynamic classes, keyed each, loop-local declarations, generic state, derived values, effects, refs, and component usage. Current IR lacks these (`src/plan.rs:605-680`, `src/plan.rs:806-922`, `docs/frontend-primitives.md:30-70`, `docs/components.md:84-114`).
- Oxc AST ergonomics are version-bound. The parser and AST are available in `0.137.0`, but the frontend should isolate oxc types inside `src/jsx.rs` and convert quickly to htmlswap-owned spans/IR (`Cargo.toml:14-19`, `src/script.rs:221-259`).
- Svelte state modeling is semantic, not syntactic. `useState`, `useMemo`, `useRef`, `useCallback`, and `useEffect` should lower to neutral concepts, while Svelte rune spelling belongs in the adapter (`src/plan.rs:806-922`, `src/adapters/svelte.rs:542-707`).
- Component handling is currently a temporary bridge through `RenderSourceIntent`, and the docs explicitly say it should not remain the primary representation (`docs/components.md:295-316`). JSX will stress this immediately with local components, member components, `children`, and foreign/global components.
- Scope creep toward "general React" is dangerous. The corpus is React 18 plus Babel plus Tailwind design files, not a full React app. General React would include context, portals, Suspense, refs with imperative APIs, synthetic event edge cases, CSS-in-JS, runtime component expressions, and arbitrary effects. The component docs list many of these concepts as future component-graph concerns (`docs/components.md:23-46`, `docs/components.md:271-293`).

Open questions:

- Should the public enum be `SourceDialectKind::Jsx` for minimal CLI churn, or should the code rename it to `SourceFrontendKind` now to avoid encoding a false abstraction? Current naming says "dialect", but JSX is a separate parse path (`src/main.rs:641-655`, `src/frontend.rs:52-95`).
- Should primary JSX sources be `SourceKind::JavaScript` or should `SourceKind::Jsx` be added? Current variants do not include JSX (`src/source.rs:23-29`).
- Should Phase 0 add minimal generic source logic through `RenderSourceLogic { dialect: "jsx" }`, or introduce typed component script primitives immediately? `RenderSourceLogic` exists but is DC-specific in Svelte collection (`src/plan.rs:596-602`, `src/adapters/svelte.rs:245-249`).
- Should component usage be implemented through the current `RenderSourceIntent` bridge first, or should JSX force the first slice of the `RenderNode::Use` design? The current adapter only emits Svelte components for DC imports or component sources (`src/adapters/svelte.rs:1476-1483`), while `docs/components.md:84-114` argues for a real component-use node.
- How much React style compatibility is required? Numeric unit conversion needs a unitless-property whitelist to match React behavior, while htmlswap style values currently classify CSS strings after conversion (`src/style.rs:383-485`).

Effort estimate:

- Phase 0: about 1,500 to 2,500 LOC across parser/lowerer, minimal `Expr`, minimal plan additions, Svelte adapter output, and tests. The tracer is real but intentionally avoids hooks and components.
- Phases 1-3: about 2,000 to 4,000 additional LOC for attrs/styles/classes/SVG/components/fragments/spreads/control flow.
- Phase 4: about 1,500 to 3,000 LOC for hook/state/effect modeling and Svelte rune emission.
- Full corpus hardening: likely 5 to 7 phases total. A useful corpus-scoped frontend is plausible in roughly 4,000 to 7,000 LOC. A general React frontend would be materially larger and should not be the initial goal.

Recommendation: scope the frontend to "just enough for this corpus" until all handoff files compile to valid Svelte 5. The repo's existing architecture is target-neutral, but the documented component and frontend primitive designs are not fully implemented yet (`docs/frontend-primitives.md:30-70`, `docs/components.md:318-365`). The fastest safe path is a direct oxc-to-RenderPlan JSX frontend with narrowly added IR primitives where the corpus proves they are needed, plus Svelte adapter work in the same phases.
