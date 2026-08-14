<script lang="ts">
	/**
	 * Skeleton loading component with shimmer animation.
	 * Uses CSS custom properties for theming consistency.
	 */
	type SkeletonProps = {
		class?: string;
		width?: string;
		height?: string;
		rounded?: 'sm' | 'md' | 'lg' | 'full';
	};

	let {
		class: className = '',
		width = '100%',
		height = '1rem',
		rounded = 'md',
	}: SkeletonProps = $props();

	const radiusMap = {
		sm: 'var(--radius-chip)',
		md: 'var(--radius-control)',
		lg: 'var(--radius-card)',
		full: '9999px',
	};
</script>

<div
	class="skeleton {className}"
	style:width
	style:height
	style:border-radius={radiusMap[rounded]}
></div>

<style>
	.skeleton {
		background: linear-gradient(
			90deg,
			var(--panel-strong) 0%,
			var(--panel) 50%,
			var(--panel-strong) 100%
		);
		background-size: 200% 100%;
		animation: shimmer 1.5s ease-in-out infinite;
	}

	@keyframes shimmer {
		0% {
			background-position: 200% 0;
		}
		100% {
			background-position: -200% 0;
		}
	}
</style>
