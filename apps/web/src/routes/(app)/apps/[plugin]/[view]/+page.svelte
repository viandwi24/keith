<script lang="ts">
import { TerminalScreen } from '#lib/features/apps/index.ts'
import { page } from '$app/state'
</script>

<!-- a view id is `<plugin>.<view>`; the route has the two parts, because a dot in the last segment reads as a file name to the core -->
<TerminalScreen viewId={`${page.params.plugin ?? ''}.${page.params.view ?? ''}`} />
