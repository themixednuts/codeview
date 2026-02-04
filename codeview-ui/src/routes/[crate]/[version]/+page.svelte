<script lang="ts">
  import { page } from '$app/state';
  import { nodeIdFromPath } from '$lib/url';
  import DetailView from '$lib/components/DetailView.svelte';

  const nodeId = $derived(page.params.crate ? nodeIdFromPath(page.params.crate) : '');
</script>

<DetailView {nodeId} />
