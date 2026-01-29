export type Ecosystem = 'rust';

export interface PackageMetadata {
	ecosystem: Ecosystem;
	name: string;
	version: string;
	description?: string;
	/** GitHub repository in "owner/repo" format */
	repository?: string;
	/** Repository URL as provided by the registry */
	repositoryUrl?: string;
	/** URL to fetch the pre-built artifact (e.g. rustdoc JSON from docs.rs) */
	artifactUrl?: string;
	/** URL to download source archive (e.g. crates.io .crate tarball) */
	sourceArchiveUrl?: string;
}

export interface RegistryAdapter {
	/** Resolve a specific package version from the registry. */
	resolve(name: string, version: string): Promise<PackageMetadata | null>;
	/** Search the registry for packages matching a query. */
	search(query: string, limit?: number): Promise<PackageMetadata[]>;
	/** List top crates (e.g. downloads) from the registry. */
	listTop(limit?: number): Promise<PackageMetadata[]>;
	/** List available versions (newest-first when possible). */
	listVersions(name: string, limit?: number): Promise<string[]>;
	/** Get the latest version for a crate, if available. */
	getLatestVersion(name: string): Promise<string | null>;
}
