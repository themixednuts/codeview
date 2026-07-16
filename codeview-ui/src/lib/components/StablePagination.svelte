<script lang="ts">
	import { page } from '$app/state';
	import { paginationHref } from '$lib/pagination';
	import { Button } from '$lib/shadcn/ui/button';
	import * as Pagination from '$lib/shadcn/ui/pagination';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';

	let {
		currentPage,
		pageCount,
		total,
		pageSize = 10,
		param,
		label,
	}: {
		currentPage: number;
		pageCount: number;
		total: number;
		pageSize?: number;
		param: string;
		label: string;
	} = $props();

	const start = $derived(total === 0 ? 0 : (currentPage - 1) * pageSize + 1);
	const end = $derived(Math.min(currentPage * pageSize, total));
</script>

<div class="flex min-h-8 flex-wrap items-center justify-end gap-2">
	<span class="font-mono text-[11px] text-(--muted-soft)">{start}-{end} of {total}</span>
	<Pagination.Root
		count={total}
		perPage={pageSize}
		page={currentPage}
		class="mx-0 w-auto"
		aria-label={label}
	>
		<Pagination.Content>
			<Pagination.Item>
				<Button
					href={paginationHref(page.url, param, currentPage - 1)}
					variant="outline"
					size="sm"
					disabled={currentPage <= 1}
					aria-label={`Previous ${label.toLowerCase()} page`}
				>
					<ChevronLeftIcon />
					<span class="hidden sm:inline">Prev</span>
				</Button>
			</Pagination.Item>
			<Pagination.Item>
				<span
					class="inline-grid h-7 min-w-12 place-items-center font-mono text-[11px] text-(--muted-soft)"
				>
					{currentPage}/{pageCount}
				</span>
			</Pagination.Item>
			<Pagination.Item>
				<Button
					href={paginationHref(page.url, param, currentPage + 1)}
					variant="outline"
					size="sm"
					disabled={currentPage >= pageCount}
					aria-label={`Next ${label.toLowerCase()} page`}
				>
					<span class="hidden sm:inline">Next</span>
					<ChevronRightIcon />
				</Button>
			</Pagination.Item>
		</Pagination.Content>
	</Pagination.Root>
</div>
