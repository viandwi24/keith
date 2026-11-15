<script lang="ts">
import { ManageShell } from '#lib/features/manage/index.ts'
import type { LayoutProps } from './$types'

let { children }: LayoutProps = $props()
</script>

<ManageShell>{@render children()}</ManageShell>
