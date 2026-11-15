<script lang="ts">
import { SectionScreen } from '#lib/features/manage/index.ts'
import { page } from '$app/state'

const id = $derived(page.params.section ?? '')
</script>

{#key id}<SectionScreen {id} />{/key}
