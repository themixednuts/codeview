<script lang="ts">
  import { probeAvailableDocsVersion } from '$lib/rpc/crate.remote';
  import { Loader2Icon } from '@lucide/svelte';

  let { crateName, version, crateVersionOptions, onRetry }: {
    crateName: string | undefined;
    version: string | undefined;
    crateVersionOptions: string[];
    onRetry: () => void;
  } = $props();

  let suggestedVersion = $derived(
    crateName && version && crateVersionOptions.length > 1
      ? await probeAvailableDocsVersion({ name: crateName, currentVersion: version, candidates: crateVersionOptions })
      : null
  );
</script>

<div class="flex flex-1 items-center justify-center">
  <div class="text-center max-w-md">
    <div class="mb-2 text-lg font-semibold text-[var(--ink)]">
      Documentation not available yet
    </div>
    <div class="mb-4 text-sm text-[var(--muted)]">
      docs.rs hasn't published rustdoc JSON for
      <code class="rounded bg-[var(--panel-strong)] px-1 py-0.5 text-xs"
        >{crateName} {version}</code
      >. This usually takes a few minutes after a new release.
    </div>

    <svelte:boundary>
      {#snippet pending()}
        <div class="mb-4 flex items-center justify-center gap-2 text-sm text-[var(--muted)]">
          <Loader2Icon class="h-3.5 w-3.5 animate-spin" />
          <span>Checking other versions...</span>
        </div>
      {/snippet}

      {#if suggestedVersion && crateName}
        <a
          href="/{crateName}/{suggestedVersion}"
          class="mb-4 inline-block rounded-[var(--radius-control)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel)] px-4 py-2 text-sm text-[var(--accent)] hover:bg-[var(--panel-strong)] transition-colors"
        >
          Try version {suggestedVersion} instead
        </a>
      {/if}
    </svelte:boundary>

    <div class="flex items-center justify-center gap-3 mt-2">
      {#if crateName && version}
        <a
          href="https://docs.rs/crate/{crateName}/{version}"
          target="_blank"
          rel="noopener noreferrer"
          class="rounded-[var(--radius-control)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel)] px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--ink)] transition-colors"
        >
          View on docs.rs
        </a>
      {/if}
      <button
        type="button"
        class="rounded-[var(--radius-control)] corner-squircle bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
        onclick={onRetry}
      >
        Retry
      </button>
      <button
        type="button"
        class="rounded-[var(--radius-control)] corner-squircle border border-[var(--panel-border)] bg-[var(--panel)] px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--ink)] transition-colors"
        onclick={() => history.back()}
      >
        Go back
      </button>
    </div>
  </div>
</div>
