<script lang="ts">
import { RoomScreen } from '#lib/features/rooms/index.ts'
import { page } from '$app/state'
</script>

{#key page.params.id}
  <RoomScreen id={page.params.id ?? ''} />
{/key}
