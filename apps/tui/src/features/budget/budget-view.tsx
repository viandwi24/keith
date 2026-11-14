import type { BudgetStatus } from '@keith/contracts'
import { type Column, ListRow, ScrollView, Txt, useFooter } from '@keith/ui'
import { Box } from 'ink'
import { budgetRows, isOwnView, ownBudgetRows, personCells } from './budget-state.ts'

const BACK = { key: 'esc', action: 'back', priority: 80 } as const
const FOOTER = [BACK] as const

function Rows({ rows }: { rows: ReadonlyArray<[string, string]> }) {
  return (
    <>
      {rows.map(([label, value]) => (
        <Box key={label}>
          <Box width={16} flexShrink={0}>
            <Txt tone="muted">{label}</Txt>
          </Box>
          <Txt>{value}</Txt>
        </Box>
      ))}
    </>
  )
}

/**
 * `/budget`, read only. A member sees their own cap, spend and what is left ("set by the owner");
 * the owner sees the global limit and a row per person (the caps are `keith-core budget`).
 */
export function BudgetView({ budget, width }: { budget: BudgetStatus | undefined; width: number }) {
  const own = budget !== undefined && isOwnView(budget) && budget.scope.startsWith('person:')
  useFooter(FOOTER)
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Txt tone="muted">{own ? 'your spend this month' : 'this month'}</Txt>
      <Box height={1} flexShrink={0} />
      {budget === undefined ? (
        <Txt tone="muted">Loading the budget…</Txt>
      ) : own ? (
        <Rows rows={ownBudgetRows(budget)} />
      ) : (
        <>
          <Rows rows={budgetRows(budget)} />
          {budget.people !== undefined && budget.people.length > 0 && (
            <Box flexDirection="column" flexGrow={1} marginTop={1}>
              <PeopleTable people={budget.people} width={width} />
            </Box>
          )}
        </>
      )}
      <Box flexGrow={1} />
      <Txt tone="muted" wrap="truncate-end">
        {own
          ? 'The cap is set by the owner.'
          : 'Limits are set on the core machine: keith-core budget set <usd|none>'}
      </Txt>
    </Box>
  )
}

function PeopleTable({
  people,
  width,
}: {
  people: NonNullable<BudgetStatus['people']>
  width: number
}) {
  const head: Column[] = [
    { text: 'person', flex: true, tone: 'muted' },
    { text: 'spent', width: 9, tone: 'muted', align: 'right' },
    { text: 'cap', width: 9, tone: 'muted', align: 'right' },
    { text: 'left', width: 9, tone: 'muted', align: 'right' },
  ]
  return (
    <>
      <ListRow plain width={width} columns={head} />
      <ScrollView anchor="top">
        {people.map((p) => {
          const c = personCells(p)
          return (
            <ListRow
              key={p.personId}
              plain
              width={width}
              columns={[
                { text: c.who, flex: true },
                { text: c.spent, width: 9, align: 'right' },
                {
                  text: c.cap,
                  width: 9,
                  align: 'right',
                  tone: p.limitUsd === null ? 'muted' : 'text',
                },
                { text: c.left, width: 9, align: 'right' },
              ]}
            />
          )
        })}
      </ScrollView>
    </>
  )
}
