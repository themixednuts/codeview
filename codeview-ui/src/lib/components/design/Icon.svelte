<script lang="ts">
	import { cn } from '$lib/shadcn/utils.js';

	type IconName =
		| 'arrow-right'
		| 'chevron-left'
		| 'chevron-down'
		| 'chevron-right'
		| 'chevrons-down-up'
		| 'chevrons-up-down'
		| 'clock'
		| 'command'
		| 'copy'
		| 'download'
		| 'file-code'
		| 'filter'
		| 'github'
		| 'hash'
		| 'layers'
		| 'link'
		| 'search'
		| 'sparkle'
		| 'star'
		| 'trending';

	let {
		name,
		size = 16,
		strokeWidth = 2,
		class: className,
	} = $props<{
		name: IconName;
		size?: number;
		strokeWidth?: number;
		class?: string;
	}>();

	function iconName(): IconName | null {
		const value = name as unknown;
		return typeof value === 'string' ? (value as IconName) : null;
	}

</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width={strokeWidth}
	stroke-linecap="round"
	stroke-linejoin="round"
	class={cn('inline-icon', className)}
	aria-hidden="true"
>
	{#if iconName() === 'arrow-right'}
		<path d="M5 12h14" />
		<path d="m12 5 7 7-7 7" />
	{:else if iconName() === 'chevron-left'}
		<path d="m15 18-6-6 6-6" />
	{:else if iconName() === 'chevron-down'}
		<path d="m6 9 6 6 6-6" />
	{:else if iconName() === 'chevron-right'}
		<path d="m9 18 6-6-6-6" />
	{:else if iconName() === 'chevrons-down-up'}
		<path d="m7 20 5-5 5 5" />
		<path d="m7 4 5 5 5-5" />
	{:else if iconName() === 'chevrons-up-down'}
		<path d="m7 15 5 5 5-5" />
		<path d="m7 9 5-5 5 5" />
	{:else if iconName() === 'clock'}
		<circle cx="12" cy="12" r="10" />
		<polyline points="12 6 12 12 16 14" />
	{:else if iconName() === 'command'}
		<path
			d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"
		/>
	{:else if iconName() === 'copy'}
		<rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
		<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
	{:else if iconName() === 'download'}
		<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
		<polyline points="7 10 12 15 17 10" />
		<line x1="12" x2="12" y1="15" y2="3" />
	{:else if iconName() === 'file-code'}
		<path d="M10 12H8" />
		<path d="M14 12h2" />
		<path d="M12 10v4" />
		<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
		<polyline points="14 2 14 8 20 8" />
	{:else if iconName() === 'filter'}
		<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
	{:else if iconName() === 'github'}
		<path
			fill="currentColor"
			stroke="none"
			d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.34-1.27-1.69-1.27-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.69 1.25 3.34.96.1-.74.4-1.25.72-1.54-2.56-.29-5.25-1.28-5.25-5.71 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.21-1.5 3.17-1.18 3.17-1.18.63 1.59.24 2.76.12 3.05.74.81 1.18 1.84 1.18 3.1 0 4.44-2.69 5.42-5.25 5.71.41.36.78 1.06.78 2.13v3.16c0 .31.21.67.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z"
		/>
	{:else if iconName() === 'hash'}
		<line x1="4" x2="20" y1="9" y2="9" />
		<line x1="4" x2="20" y1="15" y2="15" />
		<line x1="10" x2="8" y1="3" y2="21" />
		<line x1="16" x2="14" y1="3" y2="21" />
	{:else if iconName() === 'layers'}
		<path d="m12 2 9 4.5-9 4.5L3 6.5 12 2z" />
		<path d="m3 11.5 9 4.5 9-4.5" />
		<path d="m3 16.5 9 4.5 9-4.5" />
	{:else if iconName() === 'link'}
		<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
		<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
	{:else if iconName() === 'search'}
		<circle cx="11" cy="11" r="7" />
		<path d="m21 21-4.3-4.3" />
	{:else if iconName() === 'sparkle'}
		<path d="M12 3v18M3 12h18M5.5 5.5l13 13M18.5 5.5l-13 13" />
	{:else if iconName() === 'star'}
		<polygon
			points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
		/>
	{:else if iconName() === 'trending'}
		<polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
		<polyline points="16 7 22 7 22 13" />
	{/if}
</svg>
