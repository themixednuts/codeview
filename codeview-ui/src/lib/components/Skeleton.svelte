<script lang="ts">
  /**
   * Skeleton loading component with shimmer animation.
   * Uses CSS custom properties for theming consistency.
   */
  let {
    class: className = '',
    width = '100%',
    height = '1rem',
    rounded = 'md'
  } = $props<{
    class?: string;
    width?: string;
    height?: string;
    rounded?: 'sm' | 'md' | 'lg' | 'full';
  }>();

  const radiusMap = {
    sm: '0.125rem',
    md: '0.25rem',
    lg: '0.5rem',
    full: '9999px'
  };
</script>

<div
  class="skeleton {className}"
  style:width
  style:height
  style:border-radius={radiusMap[rounded as keyof typeof radiusMap]}
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
