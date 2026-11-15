<script lang="ts">
import { TaskDetail } from '#lib/features/tasks/index.ts'
import { page } from '$app/state'
</script>

<TaskDetail id={page.params.id ?? ''} />
