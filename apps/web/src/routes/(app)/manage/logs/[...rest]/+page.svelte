<script lang="ts">
import { LogsScreen } from '#lib/features/manage/index.ts'
import { page } from '$app/state'
</script>

<LogsScreen rest={page.params.rest} />
