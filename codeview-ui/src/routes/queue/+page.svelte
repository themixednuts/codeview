<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Icon from '$lib/components/design/Icon.svelte';
	import StablePagination from '$lib/components/StablePagination.svelte';
	import { readPageParam } from '$lib/pagination';
	import { stepLabels } from '$lib/realtime/constants';
	import { onMount } from 'svelte';
	import type { PageProps } from './$types';

	const PAGE_SIZE = 10;
	const REFRESH_INTERVAL_MS = 15_000;
	const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
		dateStyle: 'medium',
		timeStyle: 'short',
		timeZone: 'UTC',
	});

	let { data }: PageProps = $props();

	const snapshot = $derived(data.snapshot);
	const active = $derived(snapshot.active);
	const recent = $derived(snapshot.recent);
	const planned = $derived(snapshot.planned);
	const plannedItems = $derived(planned?.items ?? []);
	const activeCount = $derived(active.length);
	const plannedCount = $derived(planned?.total ?? 0);
	const failedCount = $derived(recent.filter((entry) => entry.status === 'failed').length);
	let refreshPending = $state(false);
	const activePageCount = $derived(Math.max(1, Math.ceil(active.length / PAGE_SIZE)));
	const plannedPageCount = $derived(Math.max(1, Math.ceil(plannedItems.length / PAGE_SIZE)));
	const recentPageCount = $derived(Math.max(1, Math.ceil(recent.length / PAGE_SIZE)));
	const activePage = $derived(readPageParam(page.url, 'activePage', activePageCount));
	const plannedPage = $derived(readPageParam(page.url, 'plannedPage', plannedPageCount));
	const recentPage = $derived(readPageParam(page.url, 'recentPage', recentPageCount));
	const visibleActiveEntries = $derived(
		active.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE),
	);
	const visiblePlannedItems = $derived(
		plannedItems.slice((plannedPage - 1) * PAGE_SIZE, plannedPage * PAGE_SIZE),
	);
	const visibleRecentEntries = $derived(
		recent.slice((recentPage - 1) * PAGE_SIZE, recentPage * PAGE_SIZE),
	);

	function itemHref(name: string, version: string): string {
		return resolve(`/${encodeURIComponent(name)}/${encodeURIComponent(version)}`);
	}

	function statusLabel(status: string, step?: string): string {
		if (step && stepLabels[step]) return stepLabels[step].replace(/\.\.\.$/, '');
		if (step) return step;
		if (status === 'ready') return 'Ready';
		if (status === 'failed') return 'Failed';
		return status;
	}

	function kindLabel(_kind: string): string {
		return 'crate';
	}

	function priorityLabel(priority: string): string {
		switch (priority) {
			case 'forced':
				return 'Requested';
			case 'top-download-stale':
			case 'catalog-stale':
				return 'Refresh';
			case 'newer-version':
			case 'catalog-newer':
				return 'New version';
			case 'never-parsed-backfill':
			case 'long-tail-backfill':
				return 'First parse';
			default:
				return 'Planned';
		}
	}

	function absoluteTime(value: string): string {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value;
		return `${DATE_TIME_FORMAT.format(date)} UTC`;
	}

	function shortId(value: string | undefined): string {
		return value ? value.slice(0, 8) : '';
	}

	function actorLabel(actor: { login: string } | undefined): string {
		return actor ? `@${actor.login}` : '';
	}

	async function refreshQueue() {
		if (refreshPending || document.visibilityState === 'hidden') return;
		refreshPending = true;
		try {
			await invalidate('codeview:parse-queue');
		} finally {
			refreshPending = false;
		}
	}

	onMount(() => {
		const interval = window.setInterval(() => void refreshQueue(), REFRESH_INTERVAL_MS);
		const onVisibilityChange = () => {
			if (document.visibilityState === 'visible') void refreshQueue();
		};
		document.addEventListener('visibilitychange', onVisibilityChange);
		return () => {
			window.clearInterval(interval);
			document.removeEventListener('visibilitychange', onVisibilityChange);
		};
	});
</script>

<div class="flex flex-1 overflow-auto">
	<main class="w-full">
		<div class="border-b border-(--panel-border-soft)">
			<div class="mx-auto flex max-w-[1180px] flex-col gap-3 px-4 py-5 sm:px-6 lg:px-8">
				<div class="flex flex-wrap items-end justify-between gap-4">
					<div class="min-w-0">
						<div
							class="mb-2 flex items-center gap-2 text-[10.5px] font-semibold tracking-[0.22em] text-(--ink-soft) uppercase"
						>
							<Icon name="clock" size={12} />
							<span>Parse Queue</span>
						</div>
						<h1 class="font-display text-2xl font-semibold text-(--ink)">
							Builds and planned parses
						</h1>
					</div>
					<div class="flex items-center gap-2">
						<span class="badge badge-sm text-(--accent)">
							{refreshPending ? 'Refreshing' : 'Live'}
						</span>
						<a
							href={resolve('/')}
							class="corner-squircle inline-flex items-center gap-2 rounded-(--radius-control) border border-(--panel-border) bg-(--panel) px-3 py-2 text-sm text-(--ink) transition-colors hover:border-(--accent-ring) hover:bg-(--panel-strong)"
						>
							<Icon name="search" size={13} />
							Browse
						</a>
					</div>
				</div>
				<div class="grid gap-2 sm:grid-cols-3">
					<div class="rounded-md border border-(--panel-border-soft) bg-(--panel) px-3 py-2">
						<div class="text-[10px] tracking-wider text-(--muted) uppercase">Active</div>
						<div class="mt-1 font-mono text-lg text-(--ink)">{activeCount}</div>
					</div>
					<div class="rounded-md border border-(--panel-border-soft) bg-(--panel) px-3 py-2">
						<div class="text-[10px] tracking-wider text-(--muted) uppercase">Planned</div>
						<div class="mt-1 font-mono text-lg text-(--ink)">{plannedCount}</div>
					</div>
					<div class="rounded-md border border-(--panel-border-soft) bg-(--panel) px-3 py-2">
						<div class="text-[10px] tracking-wider text-(--muted) uppercase">Recent failures</div>
						<div class="mt-1 font-mono text-lg text-(--ink)">{failedCount}</div>
					</div>
				</div>
			</div>
		</div>

		<div class="mx-auto grid w-full max-w-[1180px] gap-8 px-4 py-8 sm:px-6 lg:px-8">
			<section class="min-w-0">
				<div class="mb-3 flex items-center justify-between gap-3">
					<div class="flex min-w-0 items-center gap-2">
						<Icon name="clock" size={13} class="text-(--accent)" />
						<h2 class="font-display text-[18px] font-semibold text-(--ink)">Active queue</h2>
					</div>
					<div class="ml-auto flex flex-wrap items-center justify-end gap-2">
						<span class="font-mono text-[11px] text-(--muted-soft)">{activeCount} running</span>
						{#if active.length > PAGE_SIZE}
							<StablePagination
								currentPage={activePage}
								pageCount={activePageCount}
								total={active.length}
								param="activePage"
								label="Active queue"
							/>
						{/if}
					</div>
				</div>

				{#if visibleActiveEntries.length > 0}
					<div class="overflow-hidden rounded-md border border-(--panel-border-soft)">
						{#each visibleActiveEntries as entry (`${entry.name}@${entry.version}:${entry.requestId}`)}
							<a
								href={itemHref(entry.name, entry.version)}
								data-sveltekit-preload-data="off"
								class="group grid gap-3 border-t border-(--panel-border-soft) bg-(--panel) px-4 py-3 transition-colors first:border-t-0 hover:bg-(--panel-strong) md:grid-cols-[64px_minmax(0,1fr)_220px]"
							>
								<div class="font-mono text-[11px] text-(--muted-soft)">
									#{entry.position ?? '-'}
								</div>
								<div class="min-w-0">
									<div class="flex min-w-0 flex-wrap items-center gap-2">
										<span class="badge badge-sm">{kindLabel(entry.kind)}</span>
										<span class="truncate font-mono text-[13.5px] font-semibold text-(--ink)">
											{entry.name}
										</span>
										<span class="font-mono text-[10.5px] text-(--muted-soft)">
											{entry.version}
										</span>
										{#if entry.requestId}
											<span class="font-mono text-[10px] text-(--muted-soft)">
												{shortId(entry.requestId)}
											</span>
										{/if}
										{#if entry.requestedBy}
											<span class="badge badge-sm">{actorLabel(entry.requestedBy)}</span>
										{/if}
									</div>
									<div class="mt-1 text-[12px] text-(--muted)">
										{statusLabel(entry.status, entry.step)}
									</div>
								</div>
								<div class="flex min-w-0 items-center justify-between gap-3 md:justify-end">
									<span class="truncate font-mono text-[10.5px] text-(--muted-soft)">
										{absoluteTime(entry.updatedAt)}
									</span>
									{#if entry.githubRunUrl}
										<span class="badge badge-sm text-(--accent)">GitHub</span>
									{/if}
								</div>
							</a>
						{/each}
					</div>
				{:else}
					<div
						class="rounded-md border border-(--panel-border-soft) bg-(--panel) px-4 py-10 text-center"
					>
						<p class="text-sm font-medium text-(--ink)">No active parses</p>
					</div>
				{/if}
			</section>

			<section class="min-w-0">
				<div class="mb-3 flex items-center justify-between gap-3">
					<div class="flex min-w-0 items-center gap-2">
						<Icon name="layers" size={13} class="text-(--accent)" />
						<h2 class="font-display text-[18px] font-semibold text-(--ink)">Planned batch</h2>
					</div>
					<div class="ml-auto flex flex-wrap items-center justify-end gap-2">
						{#if planned}
							<span class="truncate font-mono text-[11px] text-(--muted-soft)">
								{planned.total} planned
							</span>
						{/if}
						{#if plannedItems.length > PAGE_SIZE}
							<StablePagination
								currentPage={plannedPage}
								pageCount={plannedPageCount}
								total={plannedItems.length}
								param="plannedPage"
								label="Planned batch"
							/>
						{/if}
					</div>
				</div>

				{#if planned && plannedItems.length > 0}
					<div class="overflow-hidden rounded-md border border-(--panel-border-soft)">
						{#each visiblePlannedItems as item (item.workId)}
							<a
								href={itemHref(item.name, item.version)}
								data-sveltekit-preload-data="off"
								class="group grid gap-3 border-t border-(--panel-border-soft) bg-(--panel) px-4 py-3 transition-colors first:border-t-0 hover:bg-(--panel-strong) md:grid-cols-[minmax(0,1fr)_180px]"
							>
								<div class="min-w-0">
									<div class="flex min-w-0 flex-wrap items-center gap-2">
										<span class="badge badge-sm">{kindLabel(item.kind)}</span>
										<span class="truncate font-mono text-[13.5px] font-semibold text-(--ink)">
											{item.name}
										</span>
										<span class="font-mono text-[10.5px] text-(--muted-soft)">
											{item.version}
										</span>
										<span class="badge badge-sm">{priorityLabel(item.priorityTier)}</span>
									</div>
									<div
										class="mt-1 line-clamp-1 min-h-[18px] text-[12px] text-(--muted)"
										aria-hidden={!item.reason}
									>
										{item.reason ?? ''}
									</div>
								</div>
								<div class="flex items-center justify-between gap-3 md:justify-end">
									{#if item.downloadRank}
										<span class="font-mono text-[10.5px] text-(--muted-soft)">
											rank {item.downloadRank}
										</span>
									{/if}
									<span class="font-mono text-[10.5px] text-(--muted-soft)">
										{item.channel}
									</span>
								</div>
							</a>
						{/each}
					</div>
				{:else}
					<div
						class="rounded-md border border-(--panel-border-soft) bg-(--panel) px-4 py-10 text-center"
					>
						<p class="text-sm font-medium text-(--ink)">No planned batch available</p>
					</div>
				{/if}
			</section>

			<section class="min-w-0">
				<div class="mb-3 flex items-center justify-between gap-3">
					<div class="flex min-w-0 items-center gap-2">
						<Icon name="filter" size={13} class="text-(--accent)" />
						<h2 class="font-display text-[18px] font-semibold text-(--ink)">Recent outcomes</h2>
					</div>
					<div class="ml-auto flex flex-wrap items-center justify-end gap-2">
						<span class="font-mono text-[11px] text-(--muted-soft)">{recent.length} entries</span>
						{#if recent.length > PAGE_SIZE}
							<StablePagination
								currentPage={recentPage}
								pageCount={recentPageCount}
								total={recent.length}
								param="recentPage"
								label="Recent outcomes"
							/>
						{/if}
					</div>
				</div>

				{#if visibleRecentEntries.length > 0}
					<div class="overflow-hidden rounded-md border border-(--panel-border-soft)">
						{#each visibleRecentEntries as item (`${item.name}@${item.version}:${item.updatedAt}`)}
							<a
								href={itemHref(item.name, item.version)}
								data-sveltekit-preload-data="off"
								class="group grid gap-3 border-t border-(--panel-border-soft) bg-(--panel) px-4 py-3 transition-colors first:border-t-0 hover:bg-(--panel-strong) md:grid-cols-[minmax(0,1fr)_220px]"
							>
								<div class="min-w-0">
									<div class="flex min-w-0 flex-wrap items-center gap-2">
										<span class="badge badge-sm">{kindLabel(item.kind)}</span>
										<span class="truncate font-mono text-[13.5px] font-semibold text-(--ink)">
											{item.name}
										</span>
										<span class="font-mono text-[10.5px] text-(--muted-soft)">
											{item.version}
										</span>
										<span
											class="badge badge-sm {item.status === 'failed'
												? 'text-(--danger)'
												: 'text-(--accent)'}"
										>
											{statusLabel(item.status, item.step)}
										</span>
										{#if item.requestedBy}
											<span class="badge badge-sm">{actorLabel(item.requestedBy)}</span>
										{/if}
									</div>
									<div
										class="mt-1 line-clamp-1 min-h-[18px] text-[12px] text-(--muted)"
										aria-hidden={!item.error}
									>
										{item.error ?? ''}
									</div>
								</div>
								<div class="flex min-w-0 items-center justify-between gap-3 md:justify-end">
									<span class="truncate font-mono text-[10.5px] text-(--muted-soft)">
										{absoluteTime(item.updatedAt)}
									</span>
									{#if item.githubRunUrl}
										<span class="badge badge-sm text-(--accent)">GitHub</span>
									{/if}
								</div>
							</a>
						{/each}
					</div>
				{:else}
					<div
						class="rounded-md border border-(--panel-border-soft) bg-(--panel) px-4 py-10 text-center"
					>
						<p class="text-sm font-medium text-(--ink)">No recent outcomes</p>
					</div>
				{/if}
			</section>
		</div>
	</main>
</div>
