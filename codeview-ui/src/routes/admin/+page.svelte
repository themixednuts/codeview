<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Icon from '$lib/components/design/Icon.svelte';
	import AdminForceParseForm from '$lib/components/AdminForceParseForm.svelte';
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

	let { data, form }: PageProps = $props();
	let refreshPending = $state(false);

	const auth = $derived(data.auth);
	const dashboard = $derived(data.dashboard);
	const queue = $derived(dashboard?.queue ?? null);
	const allowance = $derived(dashboard?.allowance ?? null);
	const activeEntries = $derived(queue?.active ?? []);
	const recent = $derived(queue?.recent ?? []);
	const plannedItems = $derived(queue?.planned?.items ?? []);
	const failedCount = $derived(recent.filter((entry) => entry.status === 'failed').length);
	const activePageCount = $derived(Math.max(1, Math.ceil(activeEntries.length / PAGE_SIZE)));
	const plannedPageCount = $derived(Math.max(1, Math.ceil(plannedItems.length / PAGE_SIZE)));
	const activePage = $derived(readPageParam(page.url, 'activePage', activePageCount));
	const plannedPage = $derived(readPageParam(page.url, 'plannedPage', plannedPageCount));
	const visibleActiveEntries = $derived(
		activeEntries.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE),
	);
	const visiblePlannedItems = $derived(
		plannedItems.slice((plannedPage - 1) * PAGE_SIZE, plannedPage * PAGE_SIZE),
	);
	const actionMessage = $derived(form?.message);
	const actionOk = $derived(form?.ok === true);

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

	function fmtNumber(value: number | null | undefined, digits = 0): string {
		if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
		return value.toLocaleString('en-US', {
			maximumFractionDigits: digits,
			minimumFractionDigits: digits > 0 ? Math.min(1, digits) : 0,
		});
	}

	function fmtMinutes(value: number | null | undefined): string {
		if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
		return `${fmtNumber(value, value >= 10 ? 0 : 1)} min`;
	}

	function fmtPercent(value: number | null | undefined): string {
		if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
		return `${fmtNumber(value, 1)}%`;
	}

	function actorLabel(actor: { login: string } | undefined): string {
		return actor ? `@${actor.login}` : '';
	}

	function meteringLabel(value: boolean | null | undefined): string {
		if (value === true) return 'Metered';
		if (value === false) return 'Public/free';
		return 'Unknown';
	}

	async function refreshAdmin() {
		if (refreshPending || document.visibilityState === 'hidden') return;
		refreshPending = true;
		try {
			await invalidate('codeview:admin-dashboard');
		} finally {
			refreshPending = false;
		}
	}

	onMount(() => {
		const interval = window.setInterval(() => void refreshAdmin(), REFRESH_INTERVAL_MS);
		const onVisibilityChange = () => {
			if (document.visibilityState === 'visible') void refreshAdmin();
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
			<div class="mx-auto flex max-w-[1180px] flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8">
				<div class="flex flex-wrap items-end justify-between gap-4">
					<div class="min-w-0">
						<div
							class="mb-2 flex items-center gap-2 text-[10.5px] font-semibold tracking-[0.22em] text-(--ink-soft) uppercase"
						>
							<Icon name="command" size={12} />
							<span>Admin</span>
						</div>
						<h1 class="font-display text-2xl font-semibold text-(--ink)">Parse operations</h1>
					</div>
					<div class="flex items-center gap-2">
						<span class="badge badge-sm text-(--accent)">
							{refreshPending ? 'Refreshing' : 'Live'}
						</span>
						<a
							href={resolve('/queue')}
							class="corner-squircle inline-flex items-center gap-2 rounded-(--radius-control) border border-(--panel-border) bg-(--panel) px-3 py-2 text-sm text-(--ink) transition-colors hover:border-(--accent-ring) hover:bg-(--panel-strong)"
						>
							<Icon name="clock" size={13} />
							Queue
						</a>
					</div>
				</div>

				{#if !auth.isAdmin}
					<div
						class="rounded-md border border-(--danger) bg-(--panel) px-4 py-3 text-sm text-(--danger)"
					>
						Admin access is required.
					</div>
				{:else if data.loadError}
					<div
						class="rounded-md border border-(--danger) bg-(--panel) px-4 py-3 text-sm text-(--danger)"
					>
						{data.loadError}
					</div>
				{:else if dashboard && allowance}
					<div class="grid gap-2 md:grid-cols-4">
						<div class="rounded-md border border-(--panel-border-soft) bg-(--panel) px-3 py-2">
							<div class="text-[10px] tracking-wider text-(--muted) uppercase">Actions slots</div>
							<div class="mt-1 font-mono text-lg text-(--ink)">
								{allowance.actionsInUse}/{allowance.activeTarget}
							</div>
							<div class="mt-1 text-[11px] text-(--muted-soft)">
								{allowance.availableSlots} open · batch {allowance.batchSize}
							</div>
						</div>
						<div class="rounded-md border border-(--panel-border-soft) bg-(--panel) px-3 py-2">
							<div class="text-[10px] tracking-wider text-(--muted) uppercase">Queue</div>
							<div class="mt-1 font-mono text-lg text-(--ink)">
								{queue?.active.length ?? 0} tracked · {queue?.activeRuns.length ?? 0} GitHub
							</div>
							<div class="mt-1 text-[11px] text-(--muted-soft)">
								{queue?.planned?.total ?? 0} planned
							</div>
						</div>
						<div class="rounded-md border border-(--panel-border-soft) bg-(--panel) px-3 py-2">
							<div class="text-[10px] tracking-wider text-(--muted) uppercase">Billing</div>
							<div class="mt-1 font-mono text-lg text-(--ink)">
								{allowance.standardRunnerMinutesMetered === false
									? 'Free'
									: fmtMinutes(allowance.billing.totalPaidMinutesUsed)}
							</div>
							<div class="mt-1 text-[11px] text-(--muted-soft)">
								{allowance.standardRunnerMinutesMetered === false
									? 'Public standard runners'
									: `${fmtMinutes(allowance.billing.totalMinutesUsed)} gross`}
							</div>
						</div>
						<div class="rounded-md border border-(--panel-border-soft) bg-(--panel) px-3 py-2">
							<div class="text-[10px] tracking-wider text-(--muted) uppercase">Recent failures</div>
							<div class="mt-1 font-mono text-lg text-(--ink)">{failedCount}</div>
							<div class="mt-1 text-[11px] text-(--muted-soft)">
								{meteringLabel(allowance.standardRunnerMinutesMetered)}
							</div>
						</div>
					</div>

					<div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
						<section
							class="min-w-0 rounded-md border border-(--panel-border-soft) bg-(--panel) p-4"
						>
							<div class="mb-3 flex items-center gap-2">
								<Icon name="trending" size={13} class="text-(--accent)" />
								<h2 class="font-display text-[18px] font-semibold text-(--ink)">Allowance</h2>
							</div>
							<div class="grid gap-3 sm:grid-cols-2">
								<div>
									<div class="text-[10px] tracking-wider text-(--muted) uppercase">Repo</div>
									<div class="mt-1 truncate font-mono text-sm text-(--ink)">
										{allowance.repo ?? 'n/a'}
									</div>
								</div>
								<div>
									<div class="text-[10px] tracking-wider text-(--muted) uppercase">Workflow</div>
									<div class="mt-1 truncate font-mono text-sm text-(--ink)">
										{allowance.workflowFile}
									</div>
								</div>
								<div>
									<div class="text-[10px] tracking-wider text-(--muted) uppercase">
										Tracked active
									</div>
									<div class="mt-1 font-mono text-sm text-(--ink)">
										{allowance.trackedActiveCount}
									</div>
								</div>
								<div>
									<div class="text-[10px] tracking-wider text-(--muted) uppercase">
										GitHub active
									</div>
									<div class="mt-1 font-mono text-sm text-(--ink)">
										{allowance.githubActiveRunCount}
									</div>
								</div>
								<div>
									<div class="text-[10px] tracking-wider text-(--muted) uppercase">
										Monthly target
									</div>
									<div class="mt-1 font-mono text-sm text-(--ink)">
										{fmtPercent(allowance.repoUsageTargetPercent)}
									</div>
								</div>
								<div>
									<div class="text-[10px] tracking-wider text-(--muted) uppercase">
										Month starts
									</div>
									<div class="mt-1 font-mono text-sm text-(--ink)">
										{absoluteTime(allowance.monthStartedAt)}
									</div>
								</div>
								<div>
									<div class="text-[10px] tracking-wider text-(--muted) uppercase">
										Gross Actions
									</div>
									<div class="mt-1 font-mono text-sm text-(--ink)">
										{fmtMinutes(allowance.billing.totalMinutesUsed)}
									</div>
								</div>
								<div>
									<div class="text-[10px] tracking-wider text-(--muted) uppercase">
										Billable Actions
									</div>
									<div class="mt-1 font-mono text-sm text-(--ink)">
										{fmtMinutes(allowance.billing.totalPaidMinutesUsed)}
									</div>
								</div>
							</div>
							{#if !allowance.billing.available}
								<div
									class="mt-3 rounded-md border border-(--panel-border-soft) bg-(--panel-solid) px-3 py-2 text-xs text-(--muted)"
								>
									{allowance.billing.error ?? 'GitHub billing is unavailable for this token.'}
								</div>
							{/if}
						</section>

						<section class="rounded-md border border-(--panel-border-soft) bg-(--panel) p-4">
							<div class="mb-3 flex items-center gap-2">
								<Icon name="sparkle" size={13} class="text-(--accent)" />
								<h2 class="font-display text-[18px] font-semibold text-(--ink)">Force parse</h2>
							</div>
							<AdminForceParseForm />
							{#if actionMessage}
								<div
									class="mt-3 rounded-md border px-3 py-2 text-sm {actionOk
										? 'border-(--accent-ring) bg-(--panel-solid) text-(--accent)'
										: 'border-(--danger) bg-(--panel-solid) text-(--danger)'}"
								>
									{actionMessage}
								</div>
							{/if}
						</section>
					</div>
				{/if}
			</div>
		</div>

		{#if auth.isAdmin && dashboard}
			<div class="mx-auto grid w-full max-w-[1180px] gap-8 px-4 py-8 sm:px-6 lg:px-8">
				<section class="min-w-0">
					<div class="mb-3 flex items-center justify-between gap-3">
						<div class="flex min-w-0 items-center gap-2">
							<Icon name="clock" size={13} class="text-(--accent)" />
							<h2 class="font-display text-[18px] font-semibold text-(--ink)">Active</h2>
						</div>
						<div class="ml-auto flex flex-wrap items-center justify-end gap-2">
							<span class="font-mono text-[11px] text-(--muted-soft)">
								{activeEntries.length} rows
							</span>
							{#if activeEntries.length > PAGE_SIZE}
								<StablePagination
									currentPage={activePage}
									pageCount={activePageCount}
									total={activeEntries.length}
									param="activePage"
									label="Admin active queue"
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
											{#if entry.requestedBy}
												<span class="badge badge-sm">{actorLabel(entry.requestedBy)}</span>
											{/if}
										</div>
										<div class="mt-1 text-[12px] text-(--muted)">
											{statusLabel(entry.status, entry.step)}
										</div>
									</div>
									<div class="truncate text-right font-mono text-[10.5px] text-(--muted-soft)">
										{absoluteTime(entry.updatedAt)}
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
							<span class="font-mono text-[11px] text-(--muted-soft)">
								{queue?.planned?.total ?? 0} planned
							</span>
							{#if plannedItems.length > PAGE_SIZE}
								<StablePagination
									currentPage={plannedPage}
									pageCount={plannedPageCount}
									total={plannedItems.length}
									param="plannedPage"
									label="Admin planned batch"
								/>
							{/if}
						</div>
					</div>
					{#if visiblePlannedItems.length > 0}
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
			</div>
		{/if}
	</main>
</div>
