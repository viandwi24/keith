<script lang="ts">
let { title }: { title: string } = $props()
</script>



<section class="placeholder">
  <h1>{title}</h1>
  <p>This screen is coming in a later phase.</p>
</section>

<style>
  .placeholder { padding: 2rem 1.5rem; max-width: 40rem; }
  h1 { margin: 0 0 0.5rem; font-size: 1.4rem; font-weight: 600; }
  p { margin: 0; color: var(--k-text-muted); }
</style>
