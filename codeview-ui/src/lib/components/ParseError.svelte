<script lang="ts">
  let { crateName, error, onRetry }: {
    crateName: string | undefined;
    error?: string | null;
    onRetry: () => void;
  } = $props();
</script>

<div class="flex flex-1 items-center justify-center">
  <div class="text-center">
    <div class="mb-2 text-lg font-semibold text-[var(--danger)]">
      Failed to parse {crateName}
    </div>
    {#if error}
      <div class="mb-4 max-w-md text-sm text-[var(--muted)]">
        {error}
      </div>
    {/if}
    <button
      type="button"
      class="rounded-[var(--radius-control)] corner-squircle bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
      onclick={onRetry}
    >
      Retry
    </button>
  </div>
</div>
