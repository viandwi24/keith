<script lang="ts">
import { HomeScreen } from '#lib/features/home/index.ts'
import { LEGACY_SCREENS, Stage } from '#lib/features/stage/index.ts'
</script>

{#if LEGACY_SCREENS}
  <HomeScreen />
{:else}
  <Stage />
{/if}
