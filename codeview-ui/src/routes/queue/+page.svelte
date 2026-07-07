<script lang="ts">
	import { resolve } from '$app/paths';
	import { Icon } from '$lib/components/design';
	import { stepLabels } from '$lib/realtime/constants';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const snapshot = $derived(data.snapshot);
	const active = $derived(snapshot.active);
	const recent = $derived(snapshot.recent);
	const planned = $derived(snapshot.planned);
	const activeCount = $derived(active.length);
	const plannedCount = $derived(planned?.total ?? 0);
	const failedCount = $derived(recent.filter((entry) => entry.status === 'failed').length);

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

	function kindLabel(kind: string): string {
		return kind === 'sysroot' ? 'sysroot' : 'crate';
	}

	function absoluteTime(value: string): string {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value;
		return date.toLocaleString();
	}

	function shortId(value: string | undefined): string {
		return value ? value.slice(0, 8) : '';
	}
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
						<h1 class="font-display text-2xl font-semibold text-(--ink)">Builds and planned parses</h1>
					</div>
					<a
						href={resolve('/')}
						class="corner-squircle inline-flex items-center gap-2 rounded-(--radius-control) border border-(--panel-border) bg-(--panel) px-3 py-2 text-sm text-(--ink) transition-colors hover:border-(--accent-ring) hover:bg-(--panel-strong)"
					>
						<Icon name="search" size={13} />
						Browse
					</a>
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
					<span class="font-mono text-[11px] text-(--muted-soft)">{activeCount} running</span>
				</div>

				{#if active.length > 0}
					<div class="overflow-hidden rounded-md border border-(--panel-border-soft)">
						{#each active as item (`${item.name}@${item.version}:${item.requestId}`)}
							<a
								href={itemHref(item.name, item.version)}
								data-sveltekit-preload-data="off"
								class="group grid gap-3 border-t border-(--panel-border-soft) bg-(--panel) px-4 py-3 transition-colors first:border-t-0 hover:bg-(--panel-strong) md:grid-cols-[64px_minmax(0,1fr)_220px]"
							>
								<div class="font-mono text-[11px] text-(--muted-soft)">
									#{item.position ?? '-'}
								</div>
								<div class="min-w-0">
									<div class="flex min-w-0 flex-wrap items-center gap-2">
										<span class="badge badge-sm">{kindLabel(item.kind)}</span>
										<span class="truncate font-mono text-[13.5px] font-semibold text-(--ink)">
											{item.name}
										</span>
										<span class="font-mono text-[10.5px] text-(--muted-soft)">
											{item.version}
										</span>
										{#if item.requestId}
											<span class="font-mono text-[10px] text-(--muted-soft)">
												{shortId(item.requestId)}
											</span>
										{/if}
									</div>
									<div class="mt-1 text-[12px] text-(--muted)">
										{statusLabel(item.status, item.step)}
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
					{#if planned}
						<span class="truncate font-mono text-[11px] text-(--muted-soft)">
							{planned.runId} · {planned.shardCount} shards
						</span>
					{/if}
				</div>

				{#if planned && planned.items.length > 0}
					<div class="overflow-hidden rounded-md border border-(--panel-border-soft)">
						{#each planned.items as item (item.workId)}
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
										<span class="badge badge-sm">{item.priorityTier}</span>
									</div>
									{#if item.reason}
										<div class="mt-1 line-clamp-1 text-[12px] text-(--muted)">{item.reason}</div>
									{/if}
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
					{#if planned.total > planned.items.length}
						<div class="mt-2 font-mono text-[11px] text-(--muted-soft)">
							Showing {planned.items.length} of {planned.total}
						</div>
					{/if}
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
					<span class="font-mono text-[11px] text-(--muted-soft)">{recent.length} entries</span>
				</div>

				{#if recent.length > 0}
					<div class="overflow-hidden rounded-md border border-(--panel-border-soft)">
						{#each recent as item (`${item.name}@${item.version}:${item.updatedAt}`)}
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
									</div>
									{#if item.error}
										<div class="mt-1 line-clamp-1 text-[12px] text-(--muted)">{item.error}</div>
									{/if}
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
