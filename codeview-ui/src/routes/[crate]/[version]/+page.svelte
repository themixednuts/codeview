<script lang="ts">
  import { page } from '$app/state';
  import DetailView from '$lib/components/DetailView.svelte';

  const nodeId = $derived(page.params.crate ?? '');
</script>

<DetailView {nodeId} />
