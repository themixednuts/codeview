<script lang="ts">
	import { resolve } from '$app/paths';
	import { authClient } from '$lib/auth-client';
	import { Icon } from '$lib/components/design';
	import { stepLabels } from '$lib/realtime/constants';
	import type { PageProps } from './$types';

	const PAGE_SIZE = 10;

	let { data, form }: PageProps = $props();

	type ActiveQueueRow =
		| { type: 'run'; run: PageProps['data']['snapshot']['activeRuns'][number] }
		| { type: 'entry'; entry: PageProps['data']['snapshot']['active'][number] };

	const snapshot = $derived(data.snapshot);
	const auth = $derived(data.auth);
	const active = $derived(snapshot.active);
	const activeRuns = $derived(snapshot.activeRuns);
	const recent = $derived(snapshot.recent);
	const planned = $derived(snapshot.planned);
	const activeRows = $derived<ActiveQueueRow[]>([
		...activeRuns.map((run) => ({ type: 'run' as const, run })),
		...active.map((entry) => ({ type: 'entry' as const, entry })),
	]);
	const plannedItems = $derived(planned?.items ?? []);
	const activeCount = $derived(active.length);
	const activeRunCount = $derived(activeRuns.length);
	const totalActiveCount = $derived(activeCount + activeRunCount);
	const plannedCount = $derived(planned?.total ?? 0);
	const failedCount = $derived(recent.filter((entry) => entry.status === 'failed').length);
	const actionMessage = $derived(form?.message);
	const actionOk = $derived(form?.ok === true);
	let authPending = $state(false);
	let authError = $state<string | null>(null);
	let activePage = $state(1);
	let plannedPage = $state(1);
	const activePageCount = $derived(Math.max(1, Math.ceil(activeRows.length / PAGE_SIZE)));
	const plannedPageCount = $derived(Math.max(1, Math.ceil(plannedItems.length / PAGE_SIZE)));
	const visibleActiveRows = $derived(
		activeRows.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE),
	);
	const visiblePlannedItems = $derived(
		plannedItems.slice((plannedPage - 1) * PAGE_SIZE, plannedPage * PAGE_SIZE),
	);

	$effect(() => {
		if (activePage > activePageCount) activePage = activePageCount;
		if (activePage < 1) activePage = 1;
		if (plannedPage > plannedPageCount) plannedPage = plannedPageCount;
		if (plannedPage < 1) plannedPage = 1;
	});

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

	function pageStart(page: number, total: number): number {
		return total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
	}

	function pageEnd(page: number, total: number): number {
		return Math.min(page * PAGE_SIZE, total);
	}

	function runStatusLabel(status: string): string {
		if (status === 'in_progress') return 'Running';
		if (status === 'queued') return 'Queued';
		if (status === 'waiting') return 'Waiting';
		if (status === 'requested') return 'Requested';
		return status;
	}

	function userLabel(): string {
		if (!auth.user) return 'not signed in';
		return auth.user.githubLogin ? `@${auth.user.githubLogin}` : auth.user.email;
	}

	function actorLabel(actor: { login: string } | undefined): string {
		return actor ? `@${actor.login}` : '';
	}

	async function signInGithub() {
		authPending = true;
		authError = null;
		try {
			await authClient.signIn.social({
				provider: 'github',
				callbackURL: resolve('/queue'),
			});
		} catch (err) {
			authError = err instanceof Error ? err.message : String(err);
			authPending = false;
		}
	}

	async function signOut() {
		authPending = true;
		authError = null;
		try {
			await authClient.signOut();
			location.href = resolve('/queue');
		} catch (err) {
			authError = err instanceof Error ? err.message : String(err);
			authPending = false;
		}
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
						<div class="mt-1 font-mono text-lg text-(--ink)">{totalActiveCount}</div>
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

				{#if auth.isAdmin}
					<div class="rounded-md border border-(--accent-ring) bg-(--panel) p-3">
						<div class="mb-3 flex flex-wrap items-center justify-between gap-3">
							<div class="min-w-0">
								<div class="flex items-center gap-2 text-[10px] font-semibold tracking-wider text-(--accent) uppercase">
									<Icon name="sparkle" size={12} />
									<span>Admin</span>
								</div>
								<div class="mt-1 truncate text-sm text-(--muted)">
									Signed in with GitHub as {userLabel()}
								</div>
							</div>
							<button
								type="button"
								onclick={signOut}
								disabled={authPending}
								class="corner-squircle inline-flex items-center rounded-(--radius-control) border border-(--panel-border) bg-(--panel) px-3 py-2 text-xs text-(--muted) transition-colors hover:border-(--accent-ring) hover:text-(--ink) disabled:opacity-60"
							>
								Sign out
							</button>
						</div>
						<form method="POST" action="?/forceParse" class="grid gap-2 md:grid-cols-[minmax(0,1fr)_160px_auto]">
							<label class="sr-only" for="force-name">Crate name</label>
							<input
								id="force-name"
								name="name"
								autocomplete="off"
								placeholder="crate name"
								required
								class="corner-squircle min-w-0 rounded-(--radius-control) border border-(--panel-border) bg-(--panel-solid) px-3 py-2 font-mono text-sm text-(--ink) outline-none transition-colors placeholder:text-(--muted-soft) focus:border-(--accent-ring)"
							/>
							<label class="sr-only" for="force-version">Version</label>
							<input
								id="force-version"
								name="version"
								autocomplete="off"
								placeholder="latest"
								value="latest"
								class="corner-squircle rounded-(--radius-control) border border-(--panel-border) bg-(--panel-solid) px-3 py-2 font-mono text-sm text-(--ink) outline-none transition-colors placeholder:text-(--muted-soft) focus:border-(--accent-ring)"
							/>
							<button
								type="submit"
								class="corner-squircle inline-flex items-center justify-center gap-2 rounded-(--radius-control) border border-(--accent-ring) bg-(--accent) px-3 py-2 text-sm font-semibold text-(--on-accent) transition-colors hover:bg-(--accent-strong)"
							>
								<Icon name="sparkle" size={13} />
								Force parse
							</button>
						</form>
					</div>
				{:else if auth.authConfigured}
					<div class="rounded-md border border-(--panel-border-soft) bg-(--panel) p-3">
						<div class="flex flex-wrap items-center justify-between gap-3">
							<div class="min-w-0">
								<div class="flex items-center gap-2 text-[10px] font-semibold tracking-wider text-(--muted) uppercase">
									<Icon name="github" size={12} />
									<span>GitHub</span>
								</div>
								<div class="mt-1 text-sm text-(--muted)">
									{#if auth.user}
										Signed in as {userLabel()}. Admin force parse is not enabled for this account.
									{:else}
										Sign in for higher parse request limits.
									{/if}
								</div>
							</div>
							{#if auth.user}
								<button
									type="button"
									onclick={signOut}
									disabled={authPending}
									class="corner-squircle inline-flex items-center justify-center rounded-(--radius-control) border border-(--panel-border) bg-(--panel-strong) px-3 py-2 text-sm font-semibold text-(--ink) transition-colors hover:border-(--accent-ring) disabled:opacity-60"
								>
									Sign out
								</button>
							{:else}
								<button
									type="button"
									onclick={signInGithub}
									disabled={authPending}
									class="corner-squircle inline-flex items-center justify-center gap-2 rounded-(--radius-control) border border-(--panel-border) bg-(--panel-strong) px-3 py-2 text-sm font-semibold text-(--ink) transition-colors hover:border-(--accent-ring) disabled:opacity-60"
								>
									<Icon name="github" size={13} />
									{authPending ? 'Opening...' : 'Sign in'}
								</button>
							{/if}
						</div>
					</div>
				{:else}
					<div class="rounded-md border border-(--panel-border-soft) bg-(--panel) p-3">
						<div class="flex flex-wrap items-center justify-between gap-3">
							<div class="min-w-0">
								<div class="flex items-center gap-2 text-[10px] font-semibold tracking-wider text-(--muted) uppercase">
									<Icon name="github" size={12} />
									<span>GitHub</span>
								</div>
								<div class="mt-1 text-sm text-(--muted)">
									GitHub sign-in is not configured for this deployment.
								</div>
							</div>
							<button
								type="button"
								disabled
								class="corner-squircle inline-flex items-center justify-center gap-2 rounded-(--radius-control) border border-(--panel-border) bg-(--panel-strong) px-3 py-2 text-sm font-semibold text-(--muted) opacity-70"
							>
								<Icon name="github" size={13} />
								Sign in
							</button>
						</div>
					</div>
				{/if}

				{#if authError}
					<div class="rounded-md border border-(--danger) bg-(--panel) px-3 py-2 text-sm text-(--danger)">
						{authError}
					</div>
				{/if}

				{#if actionMessage}
					<div
						class="rounded-md border px-3 py-2 text-sm {actionOk
							? 'border-(--accent-ring) bg-(--panel) text-(--accent)'
							: 'border-(--danger) bg-(--panel) text-(--danger)'}"
					>
						{actionMessage}
					</div>
				{/if}
			</div>
		</div>

		<div class="mx-auto grid w-full max-w-[1180px] gap-8 px-4 py-8 sm:px-6 lg:px-8">
			<section class="min-w-0">
				<div class="mb-3 flex items-center justify-between gap-3">
					<div class="flex min-w-0 items-center gap-2">
						<Icon name="clock" size={13} class="text-(--accent)" />
						<h2 class="font-display text-[18px] font-semibold text-(--ink)">Active queue</h2>
					</div>
					<span class="font-mono text-[11px] text-(--muted-soft)">{totalActiveCount} running</span>
				</div>

				{#if visibleActiveRows.length > 0}
					<div class="overflow-hidden rounded-md border border-(--panel-border-soft)">
						{#each visibleActiveRows as row (`${row.type}:${row.type === 'run' ? row.run.id : `${row.entry.name}@${row.entry.version}:${row.entry.requestId}`}`)}
							{#if row.type === 'run'}
								<a
									href={row.run.url}
									target="_blank"
									rel="noreferrer"
									class="group grid gap-3 border-t border-(--panel-border-soft) bg-(--panel) px-4 py-3 transition-colors first:border-t-0 hover:bg-(--panel-strong) md:grid-cols-[96px_minmax(0,1fr)_220px]"
								>
									<div class="font-mono text-[11px] text-(--muted-soft)">#{row.run.id}</div>
									<div class="min-w-0">
										<div class="flex min-w-0 flex-wrap items-center gap-2">
											<span class="badge badge-sm">batch</span>
											<span class="truncate font-mono text-[13.5px] font-semibold text-(--ink)">
												{row.run.title}
											</span>
											<span class="badge badge-sm text-(--accent)">{runStatusLabel(row.run.status)}</span>
											{#if row.run.branch}
												<span class="font-mono text-[10.5px] text-(--muted-soft)">{row.run.branch}</span>
											{/if}
										</div>
										<div class="mt-1 text-[12px] text-(--muted)">{row.run.event}</div>
									</div>
									<div class="flex min-w-0 items-center justify-between gap-3 md:justify-end">
										<span class="truncate font-mono text-[10.5px] text-(--muted-soft)">
											{absoluteTime(row.run.updatedAt)}
										</span>
										<span class="badge badge-sm text-(--accent)">GitHub</span>
									</div>
								</a>
							{:else}
								<a
									href={itemHref(row.entry.name, row.entry.version)}
									data-sveltekit-preload-data="off"
									class="group grid gap-3 border-t border-(--panel-border-soft) bg-(--panel) px-4 py-3 transition-colors first:border-t-0 hover:bg-(--panel-strong) md:grid-cols-[64px_minmax(0,1fr)_220px]"
								>
									<div class="font-mono text-[11px] text-(--muted-soft)">
										#{row.entry.position ?? '-'}
									</div>
									<div class="min-w-0">
										<div class="flex min-w-0 flex-wrap items-center gap-2">
											<span class="badge badge-sm">{kindLabel(row.entry.kind)}</span>
											<span class="truncate font-mono text-[13.5px] font-semibold text-(--ink)">
												{row.entry.name}
											</span>
											<span class="font-mono text-[10.5px] text-(--muted-soft)">
												{row.entry.version}
											</span>
											{#if row.entry.requestId}
												<span class="font-mono text-[10px] text-(--muted-soft)">
													{shortId(row.entry.requestId)}
												</span>
											{/if}
											{#if row.entry.requestedBy}
												<span class="badge badge-sm">{actorLabel(row.entry.requestedBy)}</span>
											{/if}
										</div>
										<div class="mt-1 text-[12px] text-(--muted)">
											{statusLabel(row.entry.status, row.entry.step)}
										</div>
									</div>
									<div class="flex min-w-0 items-center justify-between gap-3 md:justify-end">
										<span class="truncate font-mono text-[10.5px] text-(--muted-soft)">
											{absoluteTime(row.entry.updatedAt)}
										</span>
										{#if row.entry.githubRunUrl}
											<span class="badge badge-sm text-(--accent)">GitHub</span>
										{/if}
									</div>
								</a>
							{/if}
						{/each}
					</div>
					{#if activeRows.length > PAGE_SIZE}
						<div class="mt-2 flex flex-wrap items-center justify-between gap-2">
							<div class="font-mono text-[11px] text-(--muted-soft)">
								Showing {pageStart(activePage, activeRows.length)}-{pageEnd(activePage, activeRows.length)}
								of {activeRows.length}
							</div>
							<div class="flex items-center gap-2">
								<button
									type="button"
									disabled={activePage <= 1}
									onclick={() => (activePage -= 1)}
									class="corner-squircle inline-flex items-center gap-1 rounded-(--radius-control) border border-(--panel-border) bg-(--panel) px-2 py-1 text-xs text-(--ink) transition-colors hover:border-(--accent-ring) disabled:cursor-not-allowed disabled:text-(--muted-soft)"
								>
									<Icon name="chevron-left" size={12} />
									Prev
								</button>
								<span class="font-mono text-[11px] text-(--muted-soft)">
									{activePage}/{activePageCount}
								</span>
								<button
									type="button"
									disabled={activePage >= activePageCount}
									onclick={() => (activePage += 1)}
									class="corner-squircle inline-flex items-center gap-1 rounded-(--radius-control) border border-(--panel-border) bg-(--panel) px-2 py-1 text-xs text-(--ink) transition-colors hover:border-(--accent-ring) disabled:cursor-not-allowed disabled:text-(--muted-soft)"
								>
									Next
									<Icon name="chevron-right" size={12} />
								</button>
							</div>
						</div>
					{/if}
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
					<div class="mt-2 flex flex-wrap items-center justify-between gap-2">
						<div class="font-mono text-[11px] text-(--muted-soft)">
							Showing {pageStart(plannedPage, plannedItems.length)}-{pageEnd(plannedPage, plannedItems.length)}
							of {plannedItems.length}{planned.total > plannedItems.length
								? ` loaded (${planned.total} planned)`
								: ''}
						</div>
						{#if plannedItems.length > PAGE_SIZE}
							<div class="flex items-center gap-2">
								<button
									type="button"
									disabled={plannedPage <= 1}
									onclick={() => (plannedPage -= 1)}
									class="corner-squircle inline-flex items-center gap-1 rounded-(--radius-control) border border-(--panel-border) bg-(--panel) px-2 py-1 text-xs text-(--ink) transition-colors hover:border-(--accent-ring) disabled:cursor-not-allowed disabled:text-(--muted-soft)"
								>
									<Icon name="chevron-left" size={12} />
									Prev
								</button>
								<span class="font-mono text-[11px] text-(--muted-soft)">
									{plannedPage}/{plannedPageCount}
								</span>
								<button
									type="button"
									disabled={plannedPage >= plannedPageCount}
									onclick={() => (plannedPage += 1)}
									class="corner-squircle inline-flex items-center gap-1 rounded-(--radius-control) border border-(--panel-border) bg-(--panel) px-2 py-1 text-xs text-(--ink) transition-colors hover:border-(--accent-ring) disabled:cursor-not-allowed disabled:text-(--muted-soft)"
								>
									Next
									<Icon name="chevron-right" size={12} />
								</button>
							</div>
						{/if}
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
										{#if item.requestedBy}
											<span class="badge badge-sm">{actorLabel(item.requestedBy)}</span>
										{/if}
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
