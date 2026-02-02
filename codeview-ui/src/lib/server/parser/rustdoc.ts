/**
 * Native TypeScript parser for rustdoc JSON → crate graph.
 *
 * Replaces the WASM-based parser (codeview-rustdoc) with a pure TS
 * implementation. Handles format versions v35–v57+.
 */

import { Result } from 'better-result';
import type { ParserAdapter, ParseResult, SourceFiles } from './types';
import { resolveRootFileForCrate } from './manifest';
import { getLogger } from '$lib/log';
import { JsonParseError } from '../errors';

const log = getLogger('rustdoc');
import type {
	Node,
	Edge,
	NodeKind,
	ImplType,
	Visibility,
	EdgeKind,
	Confidence,
	Span,
	FieldInfo,
	VariantInfo,
	FunctionSignature as FunctionSignatureOut,
	Graph
} from '$lib/graph';
import type {
	RustdocCrate,
	Id,
	Item,
	ItemSummary,
	ItemEnum,
	Type,
	Path as RdtPath,
	GenericArgs,
	GenericArg,
	GenericBound,
	GenericParamDef,
	GenericParamDefKind,
	Generics,
	WherePredicate,
	FunctionSignature as RdtFunctionSignature,
	FunctionHeader,
	Impl,
	StructKind,
	VariantKind,
	Attribute,
	AssocItemConstraint,
	AssocItemConstraintKind,
	Term,
	Visibility as RdtVisibility
} from './rustdoc.types';

// ---------------------------------------------------------------------------
// Module-level constants — regex patterns and keyword set
// ---------------------------------------------------------------------------

const MOD_RE = /\bmod\s+(\w+)\s*;/g;
const INLINE_MOD_RE = /\bmod\s+(\w+)\s*\{/g;
const FN_RE = /\bfn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g;
const PATH_CALL_RE = /\b((?:\w+::)*\w+)\s*(?:::<[^>]*>)?\s*\(/g;
const METHOD_CALL_RE = /\.(\w+)\s*(?:::<[^>]*>)?\s*\(/g;
const IMPL_RE = /\bimpl(?:\s*<[^>]*>)?\s+([\w:]+(?:<[^>]*>)?)\s*(?:for\s+([\w:]+(?:<[^>]*>)?)\s*)?\{/g;

const RUST_KEYWORDS = new Set([
	'if', 'else', 'while', 'for', 'loop', 'match', 'return', 'break',
	'continue', 'let', 'const', 'static', 'fn', 'pub', 'mod', 'use',
	'struct', 'enum', 'trait', 'impl', 'type', 'where', 'as', 'in',
	'ref', 'mut', 'self', 'Self', 'super', 'crate', 'unsafe', 'async',
	'await', 'move', 'dyn', 'true', 'false', 'Some', 'None', 'Ok', 'Err'
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createRustdocParser(): ParserAdapter {
	return {
		async parse(artifact, name, version, sourceFiles) {
			const json =
				typeof artifact === 'string'
					? artifact
					: new TextDecoder().decode(artifact instanceof Uint8Array ? artifact : new Uint8Array(artifact));

			const crateName = name.replace(/-/g, '_');

			const t0 = performance.now();

			const krateResult = parseRustdocLenient(json);
			if (krateResult.isErr()) throw krateResult.error;
			const krate = krateResult.value;
			let graph: Graph;
			if (sourceFiles && sourceFiles.size > 0) {
				const rootFile = resolveRootFileForCrate(name, sourceFiles) ?? 'src/lib.rs';
				graph = buildGraph(krate, crateName, {
					skipExternalNodes: true,
					source: { rootFile, sourceFiles }
				});
			} else {
				graph = buildGraph(krate, crateName, { skipExternalNodes: true });
			}

			const elapsed = performance.now() - t0;
			log.info`parsed ${crateName}: ${String(graph.nodes.length)} nodes, ${String(graph.edges.length)} edges in ${elapsed.toFixed(0)}ms`;

			// Extract external crates from rustdoc metadata
			const externalCrates = Object.values(krate.external_crates)
				.filter((ec) => ec.name !== crateName)
				.map((ec) => ({
					id: ec.name.replace(/-/g, '_'),
					name: ec.name,
					version: null,
					nodes: [] as Node[]
				}));

			return {
				graph: {
					id: crateName,
					name: crateName,
					version,
					nodes: graph.nodes,
					edges: graph.edges
				},
				externalCrates
			} satisfies ParseResult;
		}
	};
}

// ---------------------------------------------------------------------------
// Lenient JSON parsing with format version compatibility
// ---------------------------------------------------------------------------

function parseRustdocLenient(json: string): Result<RustdocCrate, JsonParseError> {
	const parseResult = Result.try(() => JSON.parse(json) as RustdocCrate);
	if (parseResult.isErr()) {
		return Result.err(new JsonParseError({ message: 'Failed to parse rustdoc JSON' }));
	}
	const doc = parseResult.value;
	const version = doc.format_version ?? 0;

	// v44+: ensure target field exists
	if (version < 44 && !doc.target) {
		(doc as any).target = { triple: 'unknown', target_features: [] };
	}

	// v54: attrs changed from string[] to Attribute[]
	// v57: ExternalCrate gained path field
	// We handle these in accessor functions since TS is naturally lenient

	// Ensure external_crates have path (v57+)
	if (version < 57 && doc.external_crates) {
		for (const ec of Object.values(doc.external_crates)) {
			if (ec.path === undefined) {
				(ec as any).path = '';
			}
		}
	}

	return Result.ok(doc);
}

// ---------------------------------------------------------------------------
// Core graph building
// ---------------------------------------------------------------------------

interface BuildGraphOptions {
	skipExternalNodes: boolean;
	source?: {
		rootFile: string;
		sourceFiles: SourceFiles;
	};
}

function buildGraph(krate: RustdocCrate, crateName: string, opts: BuildGraphOptions): Graph {
	const graph: Graph = { nodes: [], edges: [] };
	const nodeCache = new Set<string>();
	const edgeCache = new Set<string>();
	const methodIds = collectMethodIds(krate);
	const functionIndex = buildFunctionIndex(krate, methodIds, crateName);
	const traitLookup = buildTraitLookup(krate, crateName);
	let skippedItems = 0;

	const workspaceMembers = new Set([crateName]);

	ensureCrateNode(graph, nodeCache, crateName, 'Public', false);

	// Process paths → create nodes + module hierarchy + Contains edges
	for (const [itemIdStr, summary] of Object.entries(krate.paths)) {
	  try {
		const itemId = Number(itemIdStr);
		const isMethod = methodIds.has(itemId);
		const nodeKind = mapItemKind(summary.kind, isMethod);
		if (!nodeKind) continue;
		if (summary.path.length === 0) continue;

		// Skip internal/generated paths
		if (summary.path.some((seg) => seg === '_' || seg.startsWith('__'))) continue;

		const itemCrateName = crateNameForId(krate, summary.crate_id, crateName);
		const isExternal = !workspaceMembers.has(itemCrateName);

		if (isExternal && opts.skipExternalNodes) continue;

		ensureCrateNode(graph, nodeCache, itemCrateName, 'Public', isExternal);
		ensureModuleNodes(graph, nodeCache, edgeCache, itemCrateName, summary.path, isExternal);

		const nodeId = joinPath(itemCrateName, summary.path);
		if (!nodeCache.has(nodeId)) {
			const item = krate.index[itemIdStr];
			const visibility = item ? mapVisibility(item.visibility) : 'Unknown';
			const span = item?.span ? mapSpan(item.span) : null;
			const attrs = item ? formatAttributes(item.attrs) : [];
			const name = summary.path[summary.path.length - 1] ?? nodeId;

			const details = item ? extractItemDetails(krate.index, item) : emptyDetails();
			const docLinks = item ? extractDocLinks(item, krate, crateName) : {};

			let boundLinks = item ? (itemGenerics(item) ? extractBoundLinks(itemGenerics(item)!, krate, crateName) : {}) : {};

			// Add type links from signatures and fields
			if (item) {
				const inner = item.inner;
				if ('function' in inner) {
					Object.assign(boundLinks, extractSignatureLinks(inner.function.sig, krate, crateName));
				} else if ('struct' in inner) {
					const fieldIds = getStructFieldIds(inner.struct.kind);
					Object.assign(boundLinks, extractFieldTypeLinks(krate.index, fieldIds, krate, crateName));
				} else if ('enum' in inner) {
					for (const variantId of inner.enum.variants) {
						const variantItem = krate.index[variantId];
						if (variantItem && 'variant' in variantItem.inner) {
							const fieldIds = getVariantFieldIds(variantItem.inner.variant.kind);
							Object.assign(boundLinks, extractFieldTypeLinks(krate.index, fieldIds, krate, crateName));
						}
					}
				}
			}

			graph.nodes.push({
				id: nodeId,
				name,
				kind: nodeKind,
				visibility,
				span,
				attrs,
				is_external: isExternal || undefined,
				fields: details.fields,
				variants: details.variants,
				signature: details.signature,
				generics: details.generics,
				where_clause: details.whereClause,
				docs: details.docs,
				doc_links: Object.keys(docLinks).length > 0 ? docLinks : undefined,
				bound_links: Object.keys(boundLinks).length > 0 ? boundLinks : undefined,
				impl_type: null,
				parent_impl: null,
				impl_trait: null
			});
			nodeCache.add(nodeId);
		}

		const parentId = parentPathId(itemCrateName, summary.path);
		if (parentId && parentId !== nodeId) {
			pushEdge(graph, edgeCache, parentId, nodeId, 'Contains', 'Static');
		}
	  } catch (err) {
		skippedItems++;
		log.warn`skipped path item ${itemIdStr}: ${err instanceof Error ? err.message : String(err)}`;
	  }
	}

	// Build item_to_parent map from module children
	const itemToParent = new Map<Id, Id>();
	for (const [moduleIdStr, item] of Object.entries(krate.index)) {
		if ('module' in item.inner) {
			const moduleId = Number(moduleIdStr);
			for (const childId of item.inner.module.items) {
				itemToParent.set(childId, moduleId);
			}
		}
	}

	// Re-export edges
	try {
		addUseImportEdges(graph, edgeCache, krate, crateName, itemToParent);
	} catch (err) {
		log.warn`failed to build re-export edges: ${err instanceof Error ? err.message : String(err)}`;
	}

	// Process impl blocks and type references
	for (const [itemIdStr, item] of Object.entries(krate.index)) {
	  try {
		const itemId = Number(itemIdStr);

		if ('impl' in item.inner) {
			const implBlock = item.inner.impl;
			const itemCrateName = crateNameForId(krate, item.crate_id, crateName);
			const isExternal = !workspaceMembers.has(itemCrateName);

			if (isExternal && opts.skipExternalNodes) continue;

			ensureCrateNode(graph, nodeCache, itemCrateName, 'Public', isExternal);
			const implId = implNodeId(itemCrateName, itemId);
			const implTraitId = implBlock.trait
				? resolveId(krate, crateName, implBlock.trait.id)
				: null;

			if (!nodeCache.has(implId)) {
				const name = implNodeName(krate, crateName, implBlock);
				const implType: ImplType | null = implBlock.trait ? 'Trait' : 'Inherent';
				graph.nodes.push({
					id: implId,
					name,
					kind: 'Impl',
					visibility: mapVisibility(item.visibility),
					span: item.span ? mapSpan(item.span) : null,
					attrs: formatAttributes(item.attrs),
					is_external: isExternal || undefined,
					generics: extractGenerics(implBlock.generics),
					where_clause: extractWhereClause(implBlock.generics),
					docs: item.docs ?? null,
					doc_links: extractDocLinks(item, krate, crateName),
					bound_links: extractBoundLinks(implBlock.generics, krate, crateName),
					impl_type: implType,
					parent_impl: null,
					impl_trait: implTraitId ?? null
				});
				nodeCache.add(implId);
			}

			// Contains edge from parent module to impl
			const parentModuleId = itemToParent.get(itemId);
			if (parentModuleId !== undefined) {
				const parentNodeId = resolveId(krate, crateName, parentModuleId);
				if (parentNodeId) {
					pushEdge(graph, edgeCache, parentNodeId, implId, 'Contains', 'Static');
				}
			}

			// Defines edge from type to impl
			const forId = typeToId(implBlock.for);
			if (forId !== null) {
				const typeNodeId = resolveId(krate, crateName, forId);
				if (typeNodeId) {
					pushEdge(graph, edgeCache, typeNodeId, implId, 'Defines', 'Static');

					// Implements edge from type to trait
					if (implBlock.trait) {
						const traitNodeId = resolveId(krate, crateName, implBlock.trait.id);
						if (traitNodeId) {
							pushEdge(graph, edgeCache, typeNodeId, traitNodeId, 'Implements', 'Static');
						}
					}
				}
			}

			// Process impl items (methods, types, constants)
			for (const assocId of implBlock.items) {
			  try {
				const assocItem = krate.index[assocId];
				if (!assocItem) continue;

				let kind: NodeKind;
				if ('function' in assocItem.inner) {
					kind = 'Method';
				} else if ('type_alias' in assocItem.inner || ('assoc_type' in assocItem.inner)) {
					kind = 'TypeAlias';
				} else {
					continue; // Skip constants etc.
				}

				const assocNodeId = `${implId}::method-${assocId}`;
				if (!nodeCache.has(assocNodeId)) {
					const assocName = assocItem.name ?? assocNodeId;
					const details = extractItemDetails(krate.index, assocItem);
					let assocBoundLinks = itemGenerics(assocItem)
						? extractBoundLinks(itemGenerics(assocItem)!, krate, crateName)
						: {};
					if ('function' in assocItem.inner) {
						Object.assign(assocBoundLinks, extractSignatureLinks(assocItem.inner.function.sig, krate, crateName));
					}
					graph.nodes.push({
						id: assocNodeId,
						name: assocName,
						kind,
						visibility: mapVisibility(assocItem.visibility),
						span: assocItem.span ? mapSpan(assocItem.span) : null,
						attrs: formatAttributes(assocItem.attrs),
						is_external: isExternal || undefined,
						fields: details.fields,
						variants: details.variants,
						signature: details.signature,
						generics: details.generics,
						where_clause: details.whereClause,
						docs: details.docs,
						doc_links: extractDocLinks(assocItem, krate, crateName),
						bound_links: Object.keys(assocBoundLinks).length > 0 ? assocBoundLinks : undefined,
						impl_type: null,
						parent_impl: implId,
						impl_trait: null
					});
					nodeCache.add(assocNodeId);
				}

				pushEdge(graph, edgeCache, implId, assocNodeId, 'Defines', 'Static');
			  } catch (err) {
				skippedItems++;
				log.warn`skipped impl item ${assocId} in ${itemIdStr}: ${err instanceof Error ? err.message : String(err)}`;
			  }
			}

			// Continue to collect type IDs below (impl is handled as owner)
		}

		// Collect type references (UsesType edges)
		const ownerId = 'impl' in item.inner
			? implNodeId(crateNameForId(krate, item.crate_id, crateName), itemId)
			: resolveId(krate, crateName, itemId);

		if (!ownerId) continue;

		const typeIds = new Set<Id>();
		const inner = item.inner;

		if ('struct' in inner) {
			collectGenericsIds(inner.struct.generics, typeIds);
			collectStructFieldIds(krate.index, inner.struct.kind, typeIds);
		} else if ('union' in inner) {
			collectGenericsIds(inner.union.generics, typeIds);
			collectFieldIds(krate.index, inner.union.fields, typeIds);
		} else if ('enum' in inner) {
			collectGenericsIds(inner.enum.generics, typeIds);
			collectEnumVariantIds(krate.index, inner.enum.variants, typeIds);
		} else if ('trait' in inner) {
			collectGenericsIds(inner.trait.generics, typeIds);
			collectBoundsIds(inner.trait.bounds, typeIds);
			for (const assocId of inner.trait.items) {
				const assocNodeId2 = resolveId(krate, crateName, assocId);
				if (assocNodeId2) {
					pushEdge(graph, edgeCache, ownerId, assocNodeId2, 'Defines', 'Static');
				}
			}
		} else if ('trait_alias' in inner) {
			collectGenericsIds(inner.trait_alias.generics, typeIds);
			collectBoundsIds(inner.trait_alias.params, typeIds);
		} else if ('type_alias' in inner) {
			collectTypeIds(inner.type_alias.type, typeIds);
			collectGenericsIds(inner.type_alias.generics, typeIds);
		} else if ('function' in inner) {
			collectSignatureIds(inner.function.sig, typeIds);
			collectGenericsIds(inner.function.generics, typeIds);
		} else if ('impl' in inner) {
			collectGenericsIds(inner.impl.generics, typeIds);
			collectTypeIds(inner.impl.for, typeIds);
			if (inner.impl.trait) {
				typeIds.add(inner.impl.trait.id);
				if (inner.impl.trait.args) {
					collectGenericArgsIds(inner.impl.trait.args, typeIds);
				}
			}
		} else if ('constant' in inner) {
			collectTypeIds(inner.constant.type, typeIds);
		} else if ('static' in inner) {
			collectTypeIds(inner.static.type, typeIds);
		}

		addUsesEdges(graph, edgeCache, ownerId, typeIds, krate, crateName);
		addDerivesEdges(graph, edgeCache, ownerId, item.attrs, traitLookup);
	  } catch (err) {
		skippedItems++;
		log.warn`skipped index item ${itemIdStr}: ${err instanceof Error ? err.message : String(err)}`;
	  }
	}

	// Call edges from source files
	if (opts.source) {
		try {
			addCallEdges(
				graph,
				edgeCache,
				opts.source.rootFile,
				functionIndex,
				opts.source.sourceFiles
			);
		} catch (err) {
			log.warn`failed to build call edges: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	if (skippedItems > 0) {
		log.warn`completed with ${skippedItems} skipped item(s) due to parse errors`;
	}

	return graph;
}

// ---------------------------------------------------------------------------
// Method ID collection
// ---------------------------------------------------------------------------

function collectMethodIds(krate: RustdocCrate): Set<Id> {
	const methodIds = new Set<Id>();
	for (const item of Object.values(krate.index)) {
		if ('impl' in item.inner) {
			for (const id of item.inner.impl.items) methodIds.add(id);
		} else if ('trait' in item.inner) {
			for (const id of item.inner.trait.items) methodIds.add(id);
		}
	}
	return methodIds;
}

// ---------------------------------------------------------------------------
// Trait lookup
// ---------------------------------------------------------------------------

function buildTraitLookup(
	krate: RustdocCrate,
	defaultCrateName: string
): Map<string, string[]> {
	const lookup = new Map<string, string[]>();
	for (const summary of Object.values(krate.paths)) {
		if (summary.kind !== 'trait') continue;
		const cn = crateNameForId(krate, summary.crate_id, defaultCrateName);
		const fullPath = joinPath(cn, summary.path);
		if (!lookup.has(fullPath)) lookup.set(fullPath, [fullPath]);
		const name = summary.path[summary.path.length - 1];
		if (name) {
			const arr = lookup.get(name);
			if (arr) arr.push(fullPath);
			else lookup.set(name, [fullPath]);
		}
	}
	return lookup;
}

// ---------------------------------------------------------------------------
// Item kind mapping
// ---------------------------------------------------------------------------

function mapItemKind(kind: string, isMethod: boolean): NodeKind | null {
	switch (kind) {
		case 'module':
			return 'Module';
		case 'struct':
			return 'Struct';
		case 'union':
			return 'Union';
		case 'enum':
			return 'Enum';
		case 'trait':
			return 'Trait';
		case 'trait_alias':
			return 'TraitAlias';
		case 'impl':
			return 'Impl';
		case 'function':
			return isMethod ? 'Method' : 'Function';
		case 'type_alias':
			return 'TypeAlias';
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Visibility mapping
// ---------------------------------------------------------------------------

function mapVisibility(vis: RdtVisibility): Visibility {
	if (typeof vis === 'string') {
		switch (vis) {
			case 'public':
				return 'Public';
			case 'crate':
				return 'Crate';
			case 'default':
				return 'Inherited';
			default:
				return 'Unknown';
		}
	}
	if (vis && typeof vis === 'object' && 'restricted' in vis) return 'Restricted';
	return 'Unknown';
}

// ---------------------------------------------------------------------------
// Span mapping
// ---------------------------------------------------------------------------

function mapSpan(span: { filename: string; begin: [number, number]; end: [number, number] }): Span {
	return {
		file: span.filename,
		line: span.begin[0],
		column: span.begin[1],
		end_line: span.end[0],
		end_column: span.end[1]
	};
}

// ---------------------------------------------------------------------------
// Type formatting
// ---------------------------------------------------------------------------

function cleanPath(path: string): string {
	const last = path.split('::').pop();
	return last ?? path;
}

function formatType(ty: Type): string {
	if (!ty || typeof ty === 'string') {
		return '_';
	}
	if ('resolved_path' in ty) {
		let result = cleanPath(ty.resolved_path.path);
		if (ty.resolved_path.args) {
			result += formatGenericArgs(ty.resolved_path.args);
		}
		return result;
	}
	if ('dyn_trait' in ty) {
		const traits = ty.dyn_trait.traits.map((p) => p.trait?.path ? cleanPath(p.trait.path) : 'Trait');
		return `dyn ${traits.join(' + ')}`;
	}
	if ('generic' in ty) return ty.generic;
	if ('primitive' in ty) return ty.primitive;
	if ('function_pointer' in ty) {
		const inputs = ty.function_pointer.sig.inputs.map(([, t]) => formatType(t));
		const output = ty.function_pointer.sig.output ? ` -> ${formatType(ty.function_pointer.sig.output)}` : '';
		return `fn(${inputs.join(', ')})${output}`;
	}
	if ('tuple' in ty) {
		const inner = ty.tuple.map(formatType);
		return `(${inner.join(', ')})`;
	}
	if ('slice' in ty) return `[${formatType(ty.slice)}]`;
	if ('array' in ty) return `[${formatType(ty.array.type)}; ${ty.array.len}]`;
	if ('pat' in ty) return formatType(ty.pat.type);
	if ('impl_trait' in ty) {
		const boundStrs = ty.impl_trait
			.filter((b): b is { trait_bound: any } => 'trait_bound' in b && !!b.trait_bound?.trait?.path)
			.map((b) => cleanPath(b.trait_bound.trait.path));
		return `impl ${boundStrs.join(' + ')}`;
	}
	if ('raw_pointer' in ty) {
		const mut = ty.raw_pointer.is_mutable ? 'mut' : 'const';
		return `*${mut} ${formatType(ty.raw_pointer.type)}`;
	}
	if ('borrowed_ref' in ty) {
		const mut = ty.borrowed_ref.is_mutable ? 'mut ' : '';
		return `&${mut}${formatType(ty.borrowed_ref.type)}`;
	}
	if ('qualified_path' in ty) {
		return `<${formatType(ty.qualified_path.self_type)}>::${ty.qualified_path.name}`;
	}
	return '_';
}

function formatGenericArgs(args: GenericArgs): string {
	if (!args || typeof args === 'string') {
		return args === 'return_type_notation' ? '(..)' : '';
	}
	if ('angle_bracketed' in args) {
		const a = args.angle_bracketed.args;
		if (a.length === 0) return '';
		const strs = a.map((arg) => {
			if (typeof arg === 'string') return '_'; // 'infer'
			if ('type' in arg) return formatType(arg.type);
			if ('lifetime' in arg) return arg.lifetime;
			if ('const' in arg) return arg.const.value ?? '';
			return '_';
		});
		return `<${strs.join(', ')}>`;
	}
	if ('parenthesized' in args) {
		const inputs = args.parenthesized.inputs.map(formatType);
		const output = args.parenthesized.output ? ` -> ${formatType(args.parenthesized.output)}` : '';
		return `(${inputs.join(', ')})${output}`;
	}
	return '';
}

// ---------------------------------------------------------------------------
// Field and variant extraction
// ---------------------------------------------------------------------------

function getStructFieldIds(kind: StructKind): Id[] {
	if (typeof kind === 'string') return []; // 'unit'
	if ('tuple' in kind) return kind.tuple.filter((id): id is Id => id !== null);
	if ('plain' in kind) return kind.plain.fields;
	return [];
}

function getVariantFieldIds(kind: VariantKind): Id[] {
	if (typeof kind === 'string') return []; // 'plain'
	if ('tuple' in kind) return kind.tuple.filter((id): id is Id => id !== null);
	if ('struct' in kind) return kind.struct.fields;
	return [];
}

function extractStructFields(index: Record<string, Item>, kind: StructKind): FieldInfo[] | null {
	if (typeof kind === 'string') return null; // 'unit'
	if ('tuple' in kind) {
		const fields: FieldInfo[] = [];
		kind.tuple.forEach((id, i) => {
			if (id === null) return;
			const item = index[id];
			if (!item || !('struct_field' in item.inner)) return;
			fields.push({
				name: String(i),
				type_name: formatType(item.inner.struct_field),
				visibility: mapVisibility(item.visibility)
			});
		});
		return fields.length > 0 ? fields : null;
	}
	if ('plain' in kind) {
		const fields: FieldInfo[] = [];
		for (const id of kind.plain.fields) {
			const item = index[id];
			if (!item || !('struct_field' in item.inner)) continue;
			fields.push({
				name: item.name ?? '',
				type_name: formatType(item.inner.struct_field),
				visibility: mapVisibility(item.visibility)
			});
		}
		return fields.length > 0 ? fields : null;
	}
	return null;
}

function extractEnumVariants(index: Record<string, Item>, variants: Id[]): VariantInfo[] | null {
	const infos: VariantInfo[] = [];
	for (const id of variants) {
		const item = index[id];
		if (!item || !('variant' in item.inner)) continue;
		const variant = item.inner.variant;
		let fields: FieldInfo[] = [];
		const kind = variant.kind;
		if (typeof kind !== 'string') {
			if ('tuple' in kind) {
				kind.tuple.forEach((fieldId, i) => {
					if (fieldId === null) return;
					const fieldItem = index[fieldId];
					if (!fieldItem || !('struct_field' in fieldItem.inner)) return;
					fields.push({
						name: String(i),
						type_name: formatType(fieldItem.inner.struct_field),
						visibility: 'Inherited'
					});
				});
			} else if ('struct' in kind) {
				for (const fieldId of kind.struct.fields) {
					const fieldItem = index[fieldId];
					if (!fieldItem || !('struct_field' in fieldItem.inner)) continue;
					fields.push({
						name: fieldItem.name ?? '',
						type_name: formatType(fieldItem.inner.struct_field),
						visibility: mapVisibility(fieldItem.visibility)
					});
				}
			}
		}
		infos.push({ name: item.name ?? '', fields });
	}
	return infos.length > 0 ? infos : null;
}

function extractFunctionSignature(
	sig: RdtFunctionSignature,
	header: FunctionHeader
): FunctionSignatureOut {
	return {
		inputs: sig.inputs.map(([name, ty]) => ({
			name,
			type_name: formatType(ty)
		})),
		output: sig.output ? formatType(sig.output) : null,
		is_async: header.is_async,
		is_unsafe: header.is_unsafe,
		is_const: header.is_const
	};
}

// ---------------------------------------------------------------------------
// Generics extraction
// ---------------------------------------------------------------------------

function itemGenerics(item: Item): Generics | null {
	const inner = item.inner;
	if ('struct' in inner) return inner.struct.generics;
	if ('union' in inner) return inner.union.generics;
	if ('enum' in inner) return inner.enum.generics;
	if ('function' in inner) return inner.function.generics;
	if ('trait' in inner) return inner.trait.generics;
	if ('trait_alias' in inner) return inner.trait_alias.generics;
	if ('type_alias' in inner) return inner.type_alias.generics;
	return null;
}

function formatBoundsStr(bounds: GenericBound[]): string[] {
	return bounds
		.map((b) => {
			if ('trait_bound' in b) return b.trait_bound?.trait?.path ? cleanPath(b.trait_bound.trait.path) : null;
			if ('outlives' in b) return b.outlives;
			return null;
		})
		.filter((s): s is string => s !== null);
}

function extractGenerics(generics: Generics): string[] | null {
	const params = generics.params.map((p) => {
		const kind = p.kind;
		if ('type' in kind) {
			let s = p.name;
			const boundStrs = formatBoundsStr(kind.type.bounds);
			if (boundStrs.length > 0) s += `: ${boundStrs.join(' + ')}`;
			if (kind.type.default) s += ` = ${formatType(kind.type.default)}`;
			return s;
		}
		if ('lifetime' in kind) return p.name;
		if ('const' in kind) return `const ${p.name}: ${formatType(kind.const.type)}`;
		return p.name;
	});
	return params.length > 0 ? params : null;
}

function extractWhereClause(generics: Generics): string[] | null {
	const predicates: string[] = [];
	for (const pred of generics.where_predicates) {
		if ('bound_predicate' in pred) {
			const ty = formatType(pred.bound_predicate.type);
			const boundStrs = formatBoundsStr(pred.bound_predicate.bounds);
			if (boundStrs.length > 0) predicates.push(`${ty}: ${boundStrs.join(' + ')}`);
		} else if ('lifetime_predicate' in pred) {
			const outlives = pred.lifetime_predicate.outlives;
			if (outlives.length > 0) {
				predicates.push(`${pred.lifetime_predicate.lifetime}: ${outlives.join(' + ')}`);
			}
		} else if ('eq_predicate' in pred) {
			const lhs = formatType(pred.eq_predicate.lhs);
			const rhs = formatTerm(pred.eq_predicate.rhs);
			predicates.push(`${lhs} = ${rhs}`);
		}
	}
	return predicates.length > 0 ? predicates : null;
}

function formatTerm(term: Term): string {
	if ('type' in term) return formatType(term.type);
	if ('constant' in term) return term.constant.value ?? '';
	return '';
}

// ---------------------------------------------------------------------------
// Doc links and bound links
// ---------------------------------------------------------------------------

function extractDocLinks(item: Item, krate: RustdocCrate, crateName: string): Record<string, string> {
	const links: Record<string, string> = {};
	for (const [text, id] of Object.entries(item.links)) {
		const resolved = resolveId(krate, crateName, Number(id));
		if (resolved) links[text] = resolved;
	}
	return links;
}

function extractBoundLinks(
	generics: Generics,
	krate: RustdocCrate,
	crateName: string
): Record<string, string> {
	const links: Record<string, string> = {};
	walkGenerics(generics, linkCollector(krate, crateName, links));
	return links;
}

function collectBoundLinks(
	bounds: GenericBound[],
	krate: RustdocCrate,
	crateName: string
): Record<string, string> {
	const links: Record<string, string> = {};
	walkBounds(bounds, linkCollector(krate, crateName, links));
	return links;
}

function extractSignatureLinks(
	sig: RdtFunctionSignature,
	krate: RustdocCrate,
	crateName: string
): Record<string, string> {
	const links: Record<string, string> = {};
	walkSignature(sig, linkCollector(krate, crateName, links));
	return links;
}

function extractFieldTypeLinks(
	index: Record<string, Item>,
	fieldIds: Id[],
	krate: RustdocCrate,
	crateName: string
): Record<string, string> {
	const links: Record<string, string> = {};
	const v = linkCollector(krate, crateName, links);
	for (const fieldId of fieldIds) {
		const item = index[fieldId];
		if (item && 'struct_field' in item.inner) {
			walkType(item.inner.struct_field, v);
		}
	}
	return links;
}

// ---------------------------------------------------------------------------
// Item details extraction
// ---------------------------------------------------------------------------

interface ItemDetails {
	fields: FieldInfo[] | null;
	variants: VariantInfo[] | null;
	signature: FunctionSignatureOut | null;
	generics: string[] | null;
	whereClause: string[] | null;
	docs: string | null;
}

function emptyDetails(): ItemDetails {
	return { fields: null, variants: null, signature: null, generics: null, whereClause: null, docs: null };
}

function extractItemDetails(index: Record<string, Item>, item: Item): ItemDetails {
	const docs = item.docs ?? null;
	const inner = item.inner;
	if ('struct' in inner) {
		return {
			fields: extractStructFields(index, inner.struct.kind),
			variants: null,
			signature: null,
			generics: extractGenerics(inner.struct.generics),
			whereClause: extractWhereClause(inner.struct.generics),
			docs
		};
	}
	if ('union' in inner) {
		const fields: FieldInfo[] = [];
		for (const id of inner.union.fields) {
			const fieldItem = index[id];
			if (!fieldItem || !('struct_field' in fieldItem.inner)) continue;
			fields.push({
				name: fieldItem.name ?? '',
				type_name: formatType(fieldItem.inner.struct_field),
				visibility: mapVisibility(fieldItem.visibility)
			});
		}
		return {
			fields: fields.length > 0 ? fields : null,
			variants: null,
			signature: null,
			generics: extractGenerics(inner.union.generics),
			whereClause: extractWhereClause(inner.union.generics),
			docs
		};
	}
	if ('enum' in inner) {
		return {
			fields: null,
			variants: extractEnumVariants(index, inner.enum.variants),
			signature: null,
			generics: extractGenerics(inner.enum.generics),
			whereClause: extractWhereClause(inner.enum.generics),
			docs
		};
	}
	if ('function' in inner) {
		return {
			fields: null,
			variants: null,
			signature: extractFunctionSignature(inner.function.sig, inner.function.header),
			generics: extractGenerics(inner.function.generics),
			whereClause: extractWhereClause(inner.function.generics),
			docs
		};
	}
	if ('trait' in inner) {
		return {
			fields: null,
			variants: null,
			signature: null,
			generics: extractGenerics(inner.trait.generics),
			whereClause: extractWhereClause(inner.trait.generics),
			docs
		};
	}
	if ('trait_alias' in inner) {
		return {
			fields: null,
			variants: null,
			signature: null,
			generics: extractGenerics(inner.trait_alias.generics),
			whereClause: extractWhereClause(inner.trait_alias.generics),
			docs
		};
	}
	if ('type_alias' in inner) {
		return {
			fields: null,
			variants: null,
			signature: null,
			generics: extractGenerics(inner.type_alias.generics),
			whereClause: extractWhereClause(inner.type_alias.generics),
			docs
		};
	}
	return { ...emptyDetails(), docs };
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

function ensureCrateNode(
	graph: Graph,
	nodeCache: Set<string>,
	crateName: string,
	visibility: Visibility,
	isExternal: boolean
): void {
	if (nodeCache.has(crateName)) return;
	graph.nodes.push({
		id: crateName,
		name: crateName,
		kind: 'Crate',
		visibility,
		attrs: [],
		is_external: isExternal || undefined
	});
	nodeCache.add(crateName);
}

function ensureModuleNodes(
	graph: Graph,
	nodeCache: Set<string>,
	edgeCache: Set<string>,
	crateName: string,
	path: string[],
	isExternal: boolean
): void {
	if (path.length <= 1) return;
	let parentId = crateName;
	for (let i = 0; i < path.length - 1; i++) {
		const moduleId = joinPath(crateName, path.slice(0, i + 1));
		if (!nodeCache.has(moduleId)) {
			graph.nodes.push({
				id: moduleId,
				name: path[i],
				kind: 'Module',
				visibility: 'Unknown',
				attrs: [],
				is_external: isExternal || undefined
			});
			nodeCache.add(moduleId);
		}
		if (parentId !== moduleId) {
			pushEdge(graph, edgeCache, parentId, moduleId, 'Contains', 'Static');
		}
		parentId = moduleId;
	}
}

function parentPathId(crateName: string, path: string[]): string | null {
	if (path.length === 0) return null;
	if (path.length === 1) return crateName;
	return joinPath(crateName, path.slice(0, -1));
}

function joinPath(crateName: string, path: string[]): string {
	if (path.length === 0) return crateName;
	const start = path[0] === crateName ? 1 : 0;
	if (start >= path.length) return crateName;
	return `${crateName}::${path.slice(start).join('::')}`;
}

function crateNameForId(krate: RustdocCrate, crateId: number, fallback: string): string {
	const ext = krate.external_crates[crateId];
	return ext ? ext.name.replace(/-/g, '_') : fallback;
}

function resolveId(krate: RustdocCrate, defaultCrateName: string, id: Id): string | null {
	const summary = krate.paths[id];
	if (!summary) return null;
	const cn = crateNameForId(krate, summary.crate_id, defaultCrateName);
	return joinPath(cn, summary.path);
}

function typeToId(ty: Type): Id | null {
	if (!ty || typeof ty === 'string') return null;
	if ('resolved_path' in ty) return ty.resolved_path.id;
	if ('qualified_path' in ty) return typeToId(ty.qualified_path.self_type);
	return null;
}

function implNodeId(crateName: string, id: Id): string {
	return `${crateName}::impl-${id}`;
}

function implNodeName(krate: RustdocCrate, defaultCrateName: string, implBlock: Impl): string {
	const forId = typeToId(implBlock.for);
	const typeName = forId !== null
		? (resolveId(krate, defaultCrateName, forId)?.split('::').pop() ?? 'type')
		: 'type';

	if (implBlock.trait) {
		const traitName = resolveId(krate, defaultCrateName, implBlock.trait.id)?.split('::').pop()
			?? implBlock.trait.path?.split('::').pop()
			?? 'Trait';
		return `impl ${traitName} for ${typeName}`;
	}
	return `impl ${typeName}`;
}

// ---------------------------------------------------------------------------
// Attribute handling
// ---------------------------------------------------------------------------

function formatAttributes(attrs: Attribute[]): string[] {
	return attrs.map(attributeToString).filter((s): s is string => s !== null);
}

function attributeToString(attr: Attribute): string | null {
	if (typeof attr === 'string') {
		switch (attr) {
			case 'non_exhaustive':
				return '#[non_exhaustive]';
			case 'automatically_derived':
				return '#[automatically_derived]';
			case 'macro_export':
				return '#[macro_export]';
			case 'no_mangle':
				return '#[no_mangle]';
			default:
				// Pre-v54: plain strings are the attribute text itself
				return cleanTraceAttrs(attr);
		}
	}
	if ('must_use' in attr) {
		return attr.must_use.reason ? `#[must_use = "${attr.must_use.reason}"]` : '#[must_use]';
	}
	if ('export_name' in attr) return `#[export_name = "${attr.export_name}"]`;
	if ('link_section' in attr) return `#[link_section = "${attr.link_section}"]`;
	if ('repr' in attr) return `#[repr(${formatRepr(attr.repr)})]`;
	if ('target_feature' in attr) {
		const joined = attr.target_feature.enable.map((f) => `enable = "${f}"`).join(', ');
		return `#[target_feature(${joined})]`;
	}
	if ('other' in attr) return cleanTraceAttrs(attr.other);
	return null;
}

/** Clean up compiler-internal trace attributes left by `#[cfg]`/`#[cfg_attr]` expansion. */
function cleanTraceAttrs(value: string): string {
	return value.replace(/<cfg_attr_trace>/g, 'cfg_attr').replace(/<cfg_trace>/g, 'cfg');
}

function formatRepr(repr: { kind: string; align?: number | null; packed?: number | null; int?: string | null }): string {
	const parts: string[] = [];
	switch (repr.kind) {
		case 'rust':
			parts.push('rust');
			break;
		case 'c':
			parts.push('C');
			break;
		case 'transparent':
			parts.push('transparent');
			break;
		case 'simd':
			parts.push('simd');
			break;
		default:
			parts.push(repr.kind);
	}
	if (repr.int) parts.push(repr.int);
	if (repr.align != null) parts.push(`align(${repr.align})`);
	if (repr.packed != null) parts.push(`packed(${repr.packed})`);
	return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Derive edge extraction
// ---------------------------------------------------------------------------

function parseDeriveTaits(attrs: Attribute[]): string[] {
	const traits: string[] = [];
	for (const attr of attrs) {
		const s = attributeToString(attr);
		if (!s) continue;
		const trimmed = s.trim();
		const start = trimmed.indexOf('derive(');
		if (start === -1) continue;
		const remainder = trimmed.slice(start + 7);
		const end = remainder.indexOf(')');
		if (end === -1) continue;
		const inside = remainder.slice(0, end);
		for (const name of inside.split(',')) {
			const t = name.trim();
			if (t) traits.push(t);
		}
	}
	return traits;
}

function addDerivesEdges(
	graph: Graph,
	edgeCache: Set<string>,
	ownerId: string,
	attrs: Attribute[],
	traitLookup: Map<string, string[]>
): void {
	for (const traitName of parseDeriveTaits(attrs)) {
		if (traitName.includes('::')) {
			const paths = traitLookup.get(traitName);
			if (paths) {
				for (const path of paths) {
					pushEdge(graph, edgeCache, ownerId, path, 'Derives', 'Inferred');
				}
			}
		} else {
			const paths = traitLookup.get(traitName);
			if (paths && paths.length === 1) {
				pushEdge(graph, edgeCache, ownerId, paths[0], 'Derives', 'Inferred');
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Type tree visitor — shared walker for ID collection and link collection
// ---------------------------------------------------------------------------

interface TypeVisitor {
	onResolvedPath?(id: Id, path: string, args: GenericArgs | null): void;
	onTraitBound?(id: Id, path: string, args: GenericArgs | null): void;
	onQualifiedTrait?(id: Id, args: GenericArgs | null): void;
}

function walkType(ty: Type, v: TypeVisitor): void {
	if (!ty || typeof ty === 'string') return;
	if ('resolved_path' in ty) {
		v.onResolvedPath?.(ty.resolved_path.id, ty.resolved_path.path, ty.resolved_path.args);
		if (ty.resolved_path.args) walkGenericArgs(ty.resolved_path.args, v);
	} else if ('dyn_trait' in ty) {
		for (const poly of ty.dyn_trait.traits) {
			if (poly.trait) {
				v.onTraitBound?.(poly.trait.id, poly.trait.path, poly.trait.args);
				if (poly.trait.args) walkGenericArgs(poly.trait.args, v);
			}
			walkGenericParamDefs(poly.generic_params, v);
		}
	} else if ('function_pointer' in ty) {
		walkSignature(ty.function_pointer.sig, v);
		walkGenericParamDefs(ty.function_pointer.generic_params, v);
	} else if ('tuple' in ty) {
		for (const t of ty.tuple) walkType(t, v);
	} else if ('slice' in ty) {
		walkType(ty.slice, v);
	} else if ('array' in ty) {
		walkType(ty.array.type, v);
	} else if ('pat' in ty) {
		walkType(ty.pat.type, v);
	} else if ('impl_trait' in ty) {
		walkBounds(ty.impl_trait, v);
	} else if ('raw_pointer' in ty) {
		walkType(ty.raw_pointer.type, v);
	} else if ('borrowed_ref' in ty) {
		walkType(ty.borrowed_ref.type, v);
	} else if ('qualified_path' in ty) {
		walkType(ty.qualified_path.self_type, v);
		if (ty.qualified_path.trait) {
			v.onQualifiedTrait?.(ty.qualified_path.trait.id, ty.qualified_path.trait.args);
			if (ty.qualified_path.trait.args) walkGenericArgs(ty.qualified_path.trait.args, v);
		}
		if (ty.qualified_path.args) walkGenericArgs(ty.qualified_path.args, v);
	}
}

function walkGenericArgs(args: GenericArgs, v: TypeVisitor): void {
	if (!args || typeof args === 'string') return;
	if ('angle_bracketed' in args) {
		for (const arg of args.angle_bracketed.args) {
			if (typeof arg !== 'string' && 'type' in arg) walkType(arg.type, v);
		}
		for (const constraint of args.angle_bracketed.constraints) {
			if (constraint.args) walkGenericArgs(constraint.args, v);
			const binding = constraint.binding;
			if ('equality' in binding) walkTerm(binding.equality, v);
			else if ('constraint' in binding) walkBounds(binding.constraint, v);
		}
	} else if ('parenthesized' in args) {
		for (const input of args.parenthesized.inputs) walkType(input, v);
		if (args.parenthesized.output) walkType(args.parenthesized.output, v);
	}
}

function walkBounds(bounds: GenericBound[], v: TypeVisitor): void {
	for (const bound of bounds) {
		if ('trait_bound' in bound && bound.trait_bound?.trait) {
			v.onTraitBound?.(bound.trait_bound.trait.id, bound.trait_bound.trait.path, bound.trait_bound.trait.args);
			if (bound.trait_bound.trait.args) walkGenericArgs(bound.trait_bound.trait.args, v);
			if (bound.trait_bound.generic_params) walkGenericParamDefs(bound.trait_bound.generic_params, v);
		}
	}
}

function walkSignature(sig: RdtFunctionSignature, v: TypeVisitor): void {
	for (const [, ty] of sig.inputs) walkType(ty, v);
	if (sig.output) walkType(sig.output, v);
}

function walkTerm(term: Term, v: TypeVisitor): void {
	if ('type' in term) walkType(term.type, v);
}

function walkGenericParamDefs(params: GenericParamDef[], v: TypeVisitor): void {
	for (const param of params) {
		const kind = param.kind;
		if ('type' in kind) {
			walkBounds(kind.type.bounds, v);
			if (kind.type.default) walkType(kind.type.default, v);
		} else if ('const' in kind) {
			walkType(kind.const.type, v);
		}
	}
}

function walkGenerics(generics: Generics, v: TypeVisitor): void {
	walkGenericParamDefs(generics.params, v);
	for (const pred of generics.where_predicates) {
		if ('bound_predicate' in pred) {
			walkType(pred.bound_predicate.type, v);
			walkBounds(pred.bound_predicate.bounds, v);
			walkGenericParamDefs(pred.bound_predicate.generic_params, v);
		} else if ('eq_predicate' in pred) {
			walkType(pred.eq_predicate.lhs, v);
			walkTerm(pred.eq_predicate.rhs, v);
		}
	}
}

// --- Concrete visitors ---

/** Collects all referenced type IDs from a type tree. */
function idCollector(ids: Set<Id>): TypeVisitor {
	return {
		onResolvedPath(id) { ids.add(id); },
		onTraitBound(id) { ids.add(id); },
		onQualifiedTrait(id) { ids.add(id); }
	};
}

/** Collects display-name → node-id links from a type tree. */
function linkCollector(
	krate: RustdocCrate,
	crateName: string,
	links: Record<string, string>
): TypeVisitor {
	return {
		onResolvedPath(id, path) {
			const display = cleanPath(path);
			const nodeId = resolveId(krate, crateName, id);
			if (nodeId) links[display] = nodeId;
		},
		onTraitBound(id, path) {
			const display = cleanPath(path);
			const nodeId = resolveId(krate, crateName, id);
			if (nodeId) links[display] = nodeId;
		}
	};
}

// --- Backwards-compatible wrappers (used by buildGraph) ---

function collectTypeIds(ty: Type, ids: Set<Id>): void {
	walkType(ty, idCollector(ids));
}

function collectGenericArgsIds(args: GenericArgs, ids: Set<Id>): void {
	walkGenericArgs(args, idCollector(ids));
}

function collectBoundsIds(bounds: GenericBound[], ids: Set<Id>): void {
	walkBounds(bounds, idCollector(ids));
}

function collectGenericsIds(generics: Generics, ids: Set<Id>): void {
	walkGenerics(generics, idCollector(ids));
}

function collectSignatureIds(sig: RdtFunctionSignature, ids: Set<Id>): void {
	walkSignature(sig, idCollector(ids));
}

function collectStructFieldIds(index: Record<string, Item>, kind: StructKind, ids: Set<Id>): void {
	if (typeof kind === 'string') return;
	if ('tuple' in kind) {
		for (const id of kind.tuple) {
			if (id !== null) collectFieldIds(index, [id], ids);
		}
	} else if ('plain' in kind) {
		collectFieldIds(index, kind.plain.fields, ids);
	}
}

function collectEnumVariantIds(index: Record<string, Item>, variants: Id[], ids: Set<Id>): void {
	for (const variantId of variants) {
		const item = index[variantId];
		if (!item || !('variant' in item.inner)) continue;
		const kind = item.inner.variant.kind;
		if (typeof kind === 'string') continue;
		if ('tuple' in kind) {
			for (const id of kind.tuple) {
				if (id !== null) collectFieldIds(index, [id], ids);
			}
		} else if ('struct' in kind) {
			collectFieldIds(index, kind.struct.fields, ids);
		}
	}
}

function collectFieldIds(index: Record<string, Item>, fields: Id[], ids: Set<Id>): void {
	for (const fieldId of fields) {
		const item = index[fieldId];
		if (item && 'struct_field' in item.inner) {
			collectTypeIds(item.inner.struct_field, ids);
		}
	}
}

// ---------------------------------------------------------------------------
// Edge helpers
// ---------------------------------------------------------------------------

function pushEdge(
	graph: Graph,
	edgeCache: Set<string>,
	from: string,
	to: string,
	kind: EdgeKind,
	confidence: Confidence
): void {
	const key = `${from}|${to}|${kind}`;
	if (edgeCache.has(key)) return;
	edgeCache.add(key);
	graph.edges.push({ from, to, kind, confidence });
}

function addUsesEdges(
	graph: Graph,
	edgeCache: Set<string>,
	ownerId: string,
	typeIds: Set<Id>,
	krate: RustdocCrate,
	defaultCrateName: string
): void {
	for (const typeId of typeIds) {
		const targetId = resolveId(krate, defaultCrateName, typeId);
		if (targetId && targetId !== ownerId) {
			pushEdge(graph, edgeCache, ownerId, targetId, 'UsesType', 'Static');
		}
	}
}

function addUseImportEdges(
	graph: Graph,
	edgeCache: Set<string>,
	krate: RustdocCrate,
	defaultCrateName: string,
	itemToParent: Map<Id, Id>
): void {
	for (const [itemIdStr, item] of Object.entries(krate.index)) {
		if (!('use' in item.inner)) continue;
		const useItem = item.inner.use;
		if (useItem.id == null) continue;
		const itemId = Number(itemIdStr);

		const parentModuleId = itemToParent.get(itemId);
		if (parentModuleId === undefined) continue;

		const parentNodeId = resolveId(krate, defaultCrateName, parentModuleId);
		if (!parentNodeId) continue;

		const targetNodeId = resolveId(krate, defaultCrateName, useItem.id);
		if (!targetNodeId) continue;

		pushEdge(graph, edgeCache, parentNodeId, targetNodeId, 'ReExports', 'Static');
	}
}

// ---------------------------------------------------------------------------
// Function index (for call edge resolution)
// ---------------------------------------------------------------------------

interface FunctionIndex {
	callables: string[];
	callablesByName: Map<string, string[]>;
	methods: string[];
	methodsByName: Map<string, string[]>;
}

function buildFunctionIndex(
	krate: RustdocCrate,
	methodIds: Set<Id>,
	defaultCrateName: string
): FunctionIndex {
	const index: FunctionIndex = {
		callables: [],
		callablesByName: new Map(),
		methods: [],
		methodsByName: new Map()
	};

	for (const [itemIdStr, summary] of Object.entries(krate.paths)) {
		if (summary.kind !== 'function') continue;
		if (summary.path.length === 0) continue;
		if (summary.path.some((seg) => seg === '_' || seg.startsWith('__'))) continue;

		const cn = crateNameForId(krate, summary.crate_id, defaultCrateName);
		const fullPath = joinPath(cn, summary.path);
		const name = summary.path[summary.path.length - 1] ?? fullPath;

		index.callables.push(fullPath);
		const byName = index.callablesByName.get(name);
		if (byName) byName.push(fullPath);
		else index.callablesByName.set(name, [fullPath]);

		if (methodIds.has(Number(itemIdStr))) {
			index.methods.push(fullPath);
			const byMethodName = index.methodsByName.get(name);
			if (byMethodName) byMethodName.push(fullPath);
			else index.methodsByName.set(name, [fullPath]);
		}
	}

	return index;
}

function resolveCallableBySuffix(index: FunctionIndex, segments: string[]): string | null {
	const matches = resolveAllBySuffix(index.callables, segments);
	return matches.length === 1 ? matches[0] : null;
}

function resolveAllBySuffix(paths: string[], segments: string[]): string[] {
	if (segments.length === 0) return [];
	const suffix = `::${segments.join('::')}`;
	return paths.filter((p) => p.endsWith(suffix));
}

function resolveByNameUnique(map: Map<string, string[]>, name: string): string | null {
	const paths = map.get(name);
	return paths && paths.length === 1 ? paths[0] : null;
}

// ---------------------------------------------------------------------------
// Call edge extraction (regex-based, replacing syn AST parsing)
// ---------------------------------------------------------------------------

interface CallExpr {
	type: 'path' | 'method';
	segments?: string[];
	name?: string;
}

/**
 * Regex-based call edge extraction from Rust source files.
 * Not as accurate as syn AST parsing but handles common patterns.
 */
function addCallEdges(
	graph: Graph,
	edgeCache: Set<string>,
	rootFile: string,
	functionIndex: FunctionIndex,
	sourceFiles: SourceFiles
): void {
	const visitedFiles = new Set<string>();
	parseModuleFile(rootFile, [], graph, edgeCache, functionIndex, sourceFiles, visitedFiles);
}

function parseModuleFile(
	path: string,
	modulePath: string[],
	graph: Graph,
	edgeCache: Set<string>,
	functionIndex: FunctionIndex,
	sourceFiles: SourceFiles,
	visitedFiles: Set<string>
): void {
	const normalizedPath = path.replace(/\\/g, '/');
	if (visitedFiles.has(normalizedPath)) return;
	visitedFiles.add(normalizedPath);

	const content = sourceFiles.get(normalizedPath) ?? sourceFiles.get(path);
	if (!content) return;

	const currentDir = normalizedPath.includes('/')
		? normalizedPath.slice(0, normalizedPath.lastIndexOf('/'))
		: '';

	extractCallsFromSource(content, modulePath, currentDir, graph, edgeCache, functionIndex, sourceFiles, visitedFiles);
}

function extractCallsFromSource(
	source: string,
	modulePath: string[],
	currentDir: string,
	graph: Graph,
	edgeCache: Set<string>,
	functionIndex: FunctionIndex,
	sourceFiles: SourceFiles,
	visitedFiles: Set<string>
): void {
	// Strip comments and string literals to avoid false matches
	const cleaned = stripCommentsAndStrings(source);

	// Find mod declarations for recursive traversal
	for (const modMatch of cleaned.matchAll(MOD_RE)) {
		const modName = modMatch[1];
		const nextPath = [...modulePath, modName];
		// Try name.rs, then name/mod.rs
		const candidate1 = currentDir ? `${currentDir}/${modName}.rs` : `${modName}.rs`;
		const candidate2 = currentDir ? `${currentDir}/${modName}/mod.rs` : `${modName}/mod.rs`;

		if (sourceFiles.has(candidate1)) {
			parseModuleFile(candidate1, nextPath, graph, edgeCache, functionIndex, sourceFiles, visitedFiles);
		} else if (sourceFiles.has(candidate2)) {
			parseModuleFile(candidate2, nextPath, graph, edgeCache, functionIndex, sourceFiles, visitedFiles);
		}
	}

	// Find inline mod blocks
	for (const inlineMatch of cleaned.matchAll(INLINE_MOD_RE)) {
		const modName = inlineMatch[1];
		const braceStart = inlineMatch.index! + inlineMatch[0].length - 1;
		const braceEnd = findMatchingBrace(cleaned, braceStart);
		if (braceEnd > braceStart) {
			const modBody = cleaned.slice(braceStart + 1, braceEnd);
			const nextPath = [...modulePath, modName];
			extractCallsFromSource(modBody, nextPath, currentDir, graph, edgeCache, functionIndex, sourceFiles, visitedFiles);
		}
	}

	// Find function definitions and extract calls from their bodies
	for (const fnMatch of cleaned.matchAll(FN_RE)) {
		const fnName = fnMatch[1];

		// Find the function body (opening brace after params + return type)
		const fnIdx = fnMatch.index!;
		const afterFn = cleaned.slice(fnIdx + fnMatch[0].length);
		const bodyStart = findFnBodyStart(afterFn);
		if (bodyStart === -1) continue;

		const absBodyStart = fnIdx + fnMatch[0].length + bodyStart;
		const braceEnd = findMatchingBrace(cleaned, absBodyStart);
		if (braceEnd <= absBodyStart) continue;

		const fnBody = cleaned.slice(absBodyStart + 1, braceEnd);

		// Determine caller context
		const callerContext = detectCallerContext(cleaned, fnIdx);
		let callerId: string | null = null;

		if (callerContext.implType) {
			// Method in impl block
			callerId = resolveMethodCaller(functionIndex, modulePath, callerContext.implType, fnName);
		} else {
			// Free function
			callerId = resolveFreeFnCaller(functionIndex, modulePath, fnName);
		}

		if (!callerId) continue;

		// Extract calls from function body
		const calls = extractCallExprs(fnBody);
		for (const call of calls) {
			const candidates = call.type === 'path'
				? resolveCalleePathCandidates(functionIndex, call.segments!, modulePath)
				: resolveCalleeMethodCandidates(functionIndex, call.name!, modulePath, callerContext.implType);

			for (const [calleeId, confidence] of candidates) {
				if (callerId === calleeId) continue;
				pushEdge(graph, edgeCache, callerId, calleeId, 'CallsStatic', confidence);
			}
		}
	}
}

function stripCommentsAndStrings(source: string): string {
	let result = '';
	let i = 0;
	while (i < source.length) {
		// Line comment
		if (source[i] === '/' && source[i + 1] === '/') {
			const end = source.indexOf('\n', i);
			if (end === -1) break;
			result += ' '.repeat(end - i) + '\n';
			i = end + 1;
			continue;
		}
		// Block comment
		if (source[i] === '/' && source[i + 1] === '*') {
			const end = source.indexOf('*/', i + 2);
			if (end === -1) break;
			const len = end + 2 - i;
			// Preserve newlines to keep line/column info
			for (let j = i; j < i + len; j++) {
				result += source[j] === '\n' ? '\n' : ' ';
			}
			i = end + 2;
			continue;
		}
		// String literal
		if (source[i] === '"') {
			result += '"';
			i++;
			while (i < source.length && source[i] !== '"') {
				if (source[i] === '\\') { result += ' '; i++; }
				result += source[i] === '\n' ? '\n' : ' ';
				i++;
			}
			if (i < source.length) { result += '"'; i++; }
			continue;
		}
		// Raw string literal
		if (source[i] === 'r' && (source[i + 1] === '"' || source[i + 1] === '#')) {
			let hashes = 0;
			let j = i + 1;
			while (j < source.length && source[j] === '#') { hashes++; j++; }
			if (j < source.length && source[j] === '"') {
				j++;
				const endMarker = '"' + '#'.repeat(hashes);
				const endIdx = source.indexOf(endMarker, j);
				if (endIdx !== -1) {
					const len = endIdx + endMarker.length - i;
					for (let k = i; k < i + len; k++) {
						result += source[k] === '\n' ? '\n' : ' ';
					}
					i = endIdx + endMarker.length;
					continue;
				}
			}
		}
		result += source[i];
		i++;
	}
	return result;
}

function findMatchingBrace(source: string, start: number): number {
	if (source[start] !== '{') return start;
	let depth = 1;
	for (let i = start + 1; i < source.length; i++) {
		if (source[i] === '{') depth++;
		else if (source[i] === '}') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return start;
}

function findFnBodyStart(afterFnName: string): number {
	// Skip past parameters, return type, where clause to find opening brace
	let depth = 0;
	let inAngle = 0;
	for (let i = 0; i < afterFnName.length; i++) {
		const ch = afterFnName[i];
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		else if (ch === '<') inAngle++;
		else if (ch === '>') inAngle--;
		else if (ch === '{' && depth === 0 && inAngle === 0) return i;
	}
	return -1;
}

function detectCallerContext(
	source: string,
	fnIndex: number
): { implType: string[] | null } {
	// Look backwards from the fn definition to find enclosing impl/trait block
	const before = source.slice(0, fnIndex);
	let lastImpl: string[] | null = null;

	for (const m of before.matchAll(IMPL_RE)) {
		const braceIdx = m.index! + m[0].length - 1;
		// Check if this brace is still open at fnIndex
		const closeBrace = findMatchingBrace(source, braceIdx);
		if (closeBrace > fnIndex) {
			const typeName = m[2] ?? m[1]; // "for Type" or just "Type" (inherent impl)
			lastImpl = typeName.replace(/<[^>]*>/g, '').split('::');
		}
	}

	return { implType: lastImpl };
}

function extractCallExprs(fnBody: string): CallExpr[] {
	const calls: CallExpr[] = [];

	// Path calls: foo::bar::func( or func(
	for (const m of fnBody.matchAll(PATH_CALL_RE)) {
		const fullPath = m[1];
		if (RUST_KEYWORDS.has(fullPath)) continue;
		const segments = fullPath.split('::');
		if (segments.length > 0) {
			calls.push({ type: 'path', segments });
		}
	}

	// Method calls: .method_name(
	for (const m of fnBody.matchAll(METHOD_CALL_RE)) {
		const name = m[1];
		if (!RUST_KEYWORDS.has(name)) {
			calls.push({ type: 'method', name });
		}
	}

	return calls;
}

function resolveFreeFnCaller(
	index: FunctionIndex,
	modulePath: string[],
	name: string
): string | null {
	const segments = [...modulePath, name];
	return resolveCallableBySuffix(index, segments)
		?? resolveByNameUnique(index.callablesByName, name);
}

function resolveMethodCaller(
	index: FunctionIndex,
	modulePath: string[],
	typeSegments: string[],
	name: string
): string | null {
	const suffix = [...typeSegments, name];
	const matches = resolveAllBySuffix(index.methods, suffix);
	if (matches.length === 1) return matches[0];

	// Try with module path prefix
	const scoped = [...modulePath, ...typeSegments, name];
	const scopedMatches = resolveAllBySuffix(index.methods, scoped);
	if (scopedMatches.length === 1) return scopedMatches[0];

	return resolveByNameUnique(index.methodsByName, name);
}

function resolveCalleePathCandidates(
	index: FunctionIndex,
	segments: string[],
	modulePath: string[]
): [string, Confidence][] {
	const candidates = new Map<string, Confidence>();

	// Direct suffix match
	const direct = resolveAllBySuffix(index.callables, segments);
	addCandidates(candidates, direct);

	// Scoped match
	const scoped = [...modulePath, ...segments];
	const scopedMatches = resolveAllBySuffix(index.callables, scoped);
	addCandidates(candidates, scopedMatches);

	// Name-only fallback for single-segment paths
	if (candidates.size === 0 && segments.length === 1) {
		const byName = index.callablesByName.get(segments[0]) ?? [];
		addCandidates(candidates, byName);
	}

	return Array.from(candidates.entries());
}

function resolveCalleeMethodCandidates(
	index: FunctionIndex,
	name: string,
	modulePath: string[],
	selfType: string[] | null
): [string, Confidence][] {
	const candidates = new Map<string, Confidence>();

	if (selfType) {
		const suffix = [...selfType, name];
		const direct = resolveAllBySuffix(index.methods, suffix);
		addCandidates(candidates, direct);

		const scoped = [...modulePath, ...selfType, name];
		const scopedMatches = resolveAllBySuffix(index.methods, scoped);
		addCandidates(candidates, scopedMatches);
	}

	if (candidates.size === 0) {
		const byName = index.methodsByName.get(name) ?? [];
		addCandidates(candidates, byName);
	}

	return Array.from(candidates.entries());
}

function addCandidates(candidates: Map<string, Confidence>, matches: string[]): void {
	if (matches.length === 0) return;
	const confidence: Confidence = matches.length === 1 ? 'Static' : 'Inferred';
	for (const m of matches) {
		if (!candidates.has(m)) candidates.set(m, confidence);
	}
}
