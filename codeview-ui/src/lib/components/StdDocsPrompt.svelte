<script lang="ts">
  let { crateName, version, installedVersion, onInstall }: {
    crateName: string | undefined;
    version: string | undefined;
    installedVersion?: string;
    onInstall: () => Promise<void>;
  } = $props();
</script>

<div class="flex flex-1 items-center justify-center">
  <div class="text-center max-w-md">
    <div class="mb-2 text-lg font-semibold text-[var(--ink)]">
      Install std docs for {crateName}?
    </div>
    <div class="mb-4 text-sm text-[var(--muted)]">
      The rustdoc JSON for <code
        class="rounded bg-[var(--panel-strong)] px-1 py-0.5 text-xs"
        >{crateName} {version}</code
      >
      is not installed locally.
      {#if installedVersion}
        Your current toolchain has version <code
          class="rounded bg-[var(--panel-strong)] px-1 py-0.5 text-xs"
          >{installedVersion}</code
        >.
      {/if}
      This will run
      <code class="rounded bg-[var(--panel-strong)] px-1 py-0.5 text-xs"
        >rustup component add rust-docs-json</code
      >.
    </div>
    <div class="flex items-center justify-center gap-3">
      <button
        type="button"
        class="rounded-[var(--radius-control)] corner-squircle bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
        onclick={onInstall}
      >
        Install
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
