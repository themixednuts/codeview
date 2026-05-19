import type { PageServerLoad } from './$types';
import { initProvider } from '$lib/server/provider';

const TOP_CRATES_TTL_MS = 5 * 60 * 1000;

type TopCrate = {
	id?: string;
	name: string;
	version: string;
	description?: string;
};

let topCratesCache: { fetchedAt: number; data: TopCrate[] } | null = null;

async function getTopCratesCached(
	provider: Awaited<ReturnType<typeof initProvider>>,
): Promise<TopCrate[]> {
	const now = Date.now();
	if (topCratesCache && now - topCratesCache.fetchedAt < TOP_CRATES_TTL_MS) {
		return topCratesCache.data;
	}

	const next = await provider.getTopCrates(10);
	topCratesCache = {
		fetchedAt: now,
		data: next,
	};
	return next;
}

export const load: PageServerLoad = async (event) => {
	const provider = await initProvider(event);
	const workspace = await provider.loadWorkspace();
	const top = getTopCratesCached(provider).catch(() => [] as TopCrate[]);

	return {
		workspaceCrates: (workspace?.crates ?? []).map((crate) => ({
			id: crate.id,
			name: crate.name,
			version: crate.version,
		})),
		topCrates: top.then((items) =>
			items.map((crate) => ({
				id: crate.id ?? crate.name,
				name: crate.name,
				version: crate.version,
				description: crate.description,
			})),
		),
	};
};
