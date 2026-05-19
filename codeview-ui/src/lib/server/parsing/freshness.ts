/**
 * Freshness registry — single source of truth for "have we already parsed
 * this crate at this version with this parser revision?".
 *
 * Backed by R2 keys `rust/_index/{name}.json`. One entry per crate captures
 * the version we parsed, when, with what parser, and a hash of the resulting
 * graph for idempotency. The cron-driven freshness sweep (GHA) reads these
 * entries to decide what's stale; the parse pipeline writes them on success.
 *
 * This file is the portable core — backend implementations live in
 *   `scripts/freshness-backends.ts` (Bun: miniflare SQLite + S3 SDK)
 * and (eventually) in `src/lib/server/cloudflare/freshness-binding.ts` if
 * the Worker ever needs to read freshness for UI display.
 *
 * Adapter discipline: keep the interface small (read/write/list). Anything
 * smarter (staleness predicates, batch operations) belongs in the registry
 * class, not the backend.
 */

/**
 * What we record after every successful parse. Persisted as JSON at
 * `rust/_index/{name}.json` so freshness can be inspected with a single
 * R2 GET per crate.
 *
 * `parserRevision` is the git SHA of `codeview-rustdoc` at parse time —
 * if the parser improves, the same (name, version) becomes stale and gets
 * reparsed. `schemaVersion` is the codeview graph-schema version so we can
 * force a re-parse on schema changes. `graphHash` lets the pipeline skip
 * R2 uploads when a re-parse produces byte-identical output.
 */
export interface FreshnessEntry {
	/**
	 * Canonical Rust crate name (underscored), e.g. `serde_json`. Matches the
	 * `name` used by the Rust parser and the rest of codeview-core.
	 */
	name: string;
	/**
	 * R2 storage form (hyphenated), e.g. `serde-json`. The artifact-key path
	 * is `rust/{storageName}/{version}/...` while the freshness index key is
	 * `rust/_index/{name}.json`. Capturing both here closes the loop — a UI
	 * that reads a freshness entry can directly construct the artifact URL
	 * without needing to know about the name → storageName transformation.
	 *
	 * Optional for backwards-compat: entries written before this field
	 * existed default to `name` (which matches for crates without underscores).
	 */
	storageName?: string;
	version: string;
	parsedAt: string; // ISO 8601
	source: 'docs.rs' | 'sysroot' | 'cargo' | 'unknown';
	parserRevision: string;
	schemaVersion: number;
	/**
	 * sha256 of the canonical graph JSON. Two runs with the same parser
	 * over the same input should produce the same graphHash even when
	 * the parser internally uses HashMap (insertion order varies) — the
	 * canonicaliser in `parse-one.ts` makes this stable.
	 *
	 * Used to skip R2 uploads when re-parsing produces byte-identical
	 * artifacts (parser revision changed but output didn't).
	 */
	graphHash: string;
	/**
	 * sha256 of the raw rustdoc JSON bytes from the upstream source
	 * (docs.rs gz-decompressed, or the local sysroot JSON file).
	 *
	 * Recorded for diagnostics — lets a future run notice if docs.rs
	 * served different bytes for the same crate+version (which would
	 * indicate a docs.rs rebuild against a newer toolchain). Not used
	 * as a control-flow short-circuit because every case where it
	 * could fire is already caught by the registry-level idempotency
	 * check on (version, parserRevision, schemaVersion).
	 *
	 * Optional for backwards-compat: entries written before this field
	 * existed won't have it; treat undefined as "unknown".
	 */
	rustdocHash?: string;
}

/**
 * Backend contract — anything that can read/write JSON objects under the
 * `rust/_index/` prefix qualifies. Implementations: miniflare SQLite (local
 * dev), R2 via S3 SDK (GHA + CI), R2 binding (Worker, read-only). The
 * registry never touches the backend's transport — only this interface.
 */
export interface FreshnessBackend {
	read(name: string): Promise<FreshnessEntry | null>;
	write(entry: FreshnessEntry): Promise<void>;
	list(): Promise<FreshnessEntry[]>;
}

/**
 * The R2 key shape. Exported so backends agree on the path without
 * duplicating string literals. Crate names are normalised to lowercase
 * underscored to match the rest of the artifact layout (matches
 * `normalizeCrateName` in `static-artifacts.ts`).
 */
export function freshnessKey(name: string): string {
	return `rust/_index/${name}.json`;
}

/**
 * The staleness check is its own type so callers can branch on the reason
 * (useful for cron logs: "parsing tokio because parser revision changed"
 * reads better than "parsing tokio because isStale returned true").
 */
export type StalenessReason =
	| { stale: false }
	| { stale: true; reason: 'never_parsed' }
	| { stale: true; reason: 'newer_version'; observed: string; recorded: string }
	| { stale: true; reason: 'parser_revision_changed'; recorded: string; current: string }
	| { stale: true; reason: 'schema_version_changed'; recorded: number; current: number };

/**
 * Top-level operations over the registry. Stateless wrapper around a
 * `FreshnessBackend` — the backend handles transport, the registry handles
 * predicates and book-keeping.
 *
 * Construction is just `new FreshnessRegistry(backend)`. No async setup;
 * backends are responsible for their own connection lifetimes.
 */
export class FreshnessRegistry {
	constructor(private readonly backend: FreshnessBackend) {}

	/**
	 * Decide whether a (name, observedNewestVersion) pair needs re-parsing.
	 * Stale when: never parsed | crates.io has a newer version | parser SHA
	 * differs | schema version differs.
	 *
	 * `currentParserRevision` is the git SHA the *caller* would parse with —
	 * usually `git rev-parse HEAD` on the codeview repo. Passing this in
	 * (rather than reading from disk inside) keeps the registry pure and
	 * testable without git available.
	 */
	async check(
		name: string,
		observedNewestVersion: string,
		currentParserRevision: string,
		currentSchemaVersion: number,
	): Promise<StalenessReason> {
		const entry = await this.backend.read(name);
		if (!entry) return { stale: true, reason: 'never_parsed' };
		if (entry.version !== observedNewestVersion) {
			return {
				stale: true,
				reason: 'newer_version',
				observed: observedNewestVersion,
				recorded: entry.version,
			};
		}
		if (entry.parserRevision !== currentParserRevision) {
			return {
				stale: true,
				reason: 'parser_revision_changed',
				recorded: entry.parserRevision,
				current: currentParserRevision,
			};
		}
		if (entry.schemaVersion !== currentSchemaVersion) {
			return {
				stale: true,
				reason: 'schema_version_changed',
				recorded: entry.schemaVersion,
				current: currentSchemaVersion,
			};
		}
		return { stale: false };
	}

	async record(entry: FreshnessEntry): Promise<void> {
		await this.backend.write(entry);
	}

	async latestParsed(name: string): Promise<FreshnessEntry | null> {
		return this.backend.read(name);
	}

	async listAll(): Promise<FreshnessEntry[]> {
		return this.backend.list();
	}
}
