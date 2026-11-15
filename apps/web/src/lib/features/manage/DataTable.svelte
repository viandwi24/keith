<script lang="ts">
import type { Row } from '@keith/app-model/manage'
import { facetsOf, filterRows, nextSort, type Sort, sortRows } from './table.ts'

let {
  header,
  rows,
  empty = 'Nothing here.',
  label,
  onopen,
  href,
  search = true,
}: {
  header: readonly string[]
  rows: readonly Row[]
  empty?: string
  /** The table's accessible name. */
  label: string
  /** A row opens in a drawer (a button in its first cell). */
  onopen?: (row: Row) => void
  /** A row is a link instead (the Logs levels). */
  href?: (row: Row) => string
  search?: boolean
} = $props()

let query = $state('')
let sort = $state<Sort | undefined>(undefined)
let facetValues = $state<Record<number, string>>({})

const facets = $derived(facetsOf(header, rows))
const shown = $derived(sortRows(filterRows(rows, query, facetValues), sort))
const filtered = $derived(query.trim() !== '' || Object.values(facetValues).some((v) => v !== ''))
const columns = $derived(header.length > 0 ? header : (rows[0]?.cells.map(() => '') ?? []))
const ariaSort = (col: number): 'ascending' | 'descending' | 'none' =>
  sort?.col !== col ? 'none' : sort.dir === 'asc' ? 'ascending' : 'descending'
</script>

{#if rows.length === 0}
  <p class="empty">{empty}</p>
{:else}
  <div class="tools">
    {#if search}
      <input
        class="k-input find"
        type="search"
        placeholder="Search"
        aria-label="Search {label}"
        bind:value={query}
      />
    {/if}
    {#each facets as facet (facet.col)}
      <select
        class="k-input facet"
        aria-label="Filter by {facet.label.toLowerCase()}"
        value={facetValues[facet.col] ?? ''}
        onchange={(e) => (facetValues = { ...facetValues, [facet.col]: e.currentTarget.value })}
      >
        <option value="">{facet.label.toLowerCase()}: all</option>
        {#each facet.values as value (value)}<option {value}>{value}</option>{/each}
      </select>
    {/each}
    {#if filtered}<span class="count" aria-live="polite">{shown.length} of {rows.length}</span>{/if}
  </div>
  <div class="k-tablewrap">
    <table class="k-table" aria-label={label}>
      <thead>
        <tr>
          {#each columns as col, at (at)}
            <th scope="col" aria-sort={ariaSort(at)}>
              {#if col !== ''}
                <button type="button" class="sort" onclick={() => (sort = nextSort(sort, at))}>
                  {col}<span aria-hidden="true" class="arrow">{sort?.col === at ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
                </button>
              {/if}
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each shown as row (row.id)}
          <tr class={row.tone ?? ''}>
            {#each row.cells as cell, at (at)}
              <td data-label={columns[at]}>
                {#if at === 0 && href !== undefined}
                  <a class="open" href={href(row)}>{cell}</a>
                {:else if at === 0 && onopen !== undefined}
                  <button type="button" class="open" onclick={() => onopen(row)}>{cell}</button>
                {:else}{cell}{/if}
              </td>
            {/each}
          </tr>
        {:else}
          <tr><td class="none" colspan={columns.length || 1}>No row matches.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .empty { color: var(--k-text-muted); margin: 1rem 0; }
  .tools { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin: 0 0 0.75rem; }
  .find { max-width: 16rem; }
  .facet { width: auto; max-width: 14rem; }
  .count { color: var(--k-text-muted); font-size: 0.85rem; }
  .sort {
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    color: inherit;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }
  .sort:hover { color: var(--k-text); }
  .arrow { font-size: 0.65rem; }
  .open {
    font: inherit;
    padding: 0;
    color: var(--k-accent);
    background: none;
    border: none;
    text-align: left;
    cursor: pointer;
    text-decoration: none;
  }
  .open:hover { text-decoration: underline; }
  tr.muted td { color: var(--k-text-muted); }
  tr.warning td { color: var(--k-warning); }
  tr.danger td { color: var(--k-danger); }
  td { overflow-wrap: anywhere; }
  .none { color: var(--k-text-muted); }

  /* a phone: a row is a card, each cell labelled by its column */
  @media (max-width: 639px) {
    thead { display: none; }
    table, tbody, tr, td { display: block; width: 100%; }
    tr { padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
    tr:last-child { border-bottom: none; }
    td { display: flex; gap: 0.75rem; padding: 0.15rem 0.75rem; border: none; }
    td::before {
      content: attr(data-label);
      flex: 0 0 6.5rem;
      font-size: 0.72rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--k-text-muted);
    }
    td:first-child::before { content: ''; flex: none; }
  }
</style>
