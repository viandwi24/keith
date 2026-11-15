<script lang="ts">
import type { ViewMenuItem } from '@keith/contracts'
import { onMount } from 'svelte'
import { appBase, getClient } from '../session/index.ts'
import TerminalView from './TerminalView.svelte'

let { viewId }: { viewId: string } = $props()
const back = `${appBase()}/apps`
let items = $state<ViewMenuItem[] | undefined>()

// the label of the menu entry; a view the menu does not list is still opened (the core refuses it with its own words)
onMount(() => {
  getClient()
    .viewMenu()
    .then((menu) => (items = menu.items))
    .catch(() => (items = []))
})
const label = $derived(items?.find((i) => i.viewId === viewId)?.label ?? viewId)
</script>

<svelte:head><title>{label} · Keith</title></svelte:head>

{#key viewId}
  <TerminalView {viewId} {label} {back} />
{/key}
