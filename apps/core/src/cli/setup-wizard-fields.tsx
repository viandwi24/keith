// Small building blocks of the setup wizard: a labelled text field and a choice list, drawn
// only with @keith/ui.

import { ListRow, Notice, TextInput, Txt } from '@keith/ui'
import { Box, useInput } from 'ink'
import { useState } from 'react'

export interface FieldProps {
  label: string
  help?: string | undefined
  value: string
  onChange(value: string): void
  /** Called with the text when it passes `validate`. */
  onSubmit(value: string): void
  /** A message to refuse the text with, or undefined when it is fine. */
  validate?: ((value: string) => string | undefined) | undefined
  mask?: boolean
  placeholder?: string
  width: number
  /** An error from the step itself (a PIN that does not match). */
  error?: string | undefined
}

/** A question with one text input and the reason an answer was refused. */
export function Field({
  label,
  help,
  value,
  onChange,
  onSubmit,
  validate,
  mask,
  placeholder,
  width,
  error,
}: FieldProps) {
  const [problem, setProblem] = useState<string | undefined>()
  const shown = problem ?? error
  return (
    <Box flexDirection="column">
      <Txt bold>{label}</Txt>
      {help !== undefined && <Txt tone="muted">{help}</Txt>}
      <Box height={1} />
      <Box>
        <Txt tone="accent">{'› '}</Txt>
        <TextInput
          value={value}
          onChange={(v) => {
            setProblem(undefined)
            onChange(v)
          }}
          onSubmit={(v) => {
            const refused = validate?.(v)
            if (refused !== undefined) return setProblem(refused)
            onSubmit(v)
          }}
          {...(mask === undefined ? {} : { mask })}
          {...(placeholder === undefined ? {} : { placeholder })}
          width={width - 6}
          maxRows={1}
        />
      </Box>
      {shown !== undefined && (
        <Box marginTop={1}>
          <Notice level="error" rows={[shown]} />
        </Box>
      )}
    </Box>
  )
}

export interface Option<T extends string> {
  value: T
  label: string
  hint?: string
}

/** A list of options: up and down move, enter picks. */
export function Choice<T extends string>({
  question,
  options,
  initial,
  onPick,
  width,
}: {
  question: string
  options: readonly Option<T>[]
  initial?: T | undefined
  onPick(value: T): void
  width: number
}) {
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === initial),
    ),
  )
  useInput((_input, key) => {
    if (key.upArrow) setIndex((i) => (i + options.length - 1) % options.length)
    else if (key.downArrow) setIndex((i) => (i + 1) % options.length)
    else if (key.return) {
      const picked = options[index]
      if (picked !== undefined) onPick(picked.value)
    }
  })
  return (
    <Box flexDirection="column">
      <Txt bold>{question}</Txt>
      <Box height={1} />
      {options.map((o, i) => (
        <ListRow
          key={o.value}
          width={width}
          selected={i === index}
          columns={[
            { text: o.label, width: 26 },
            { text: o.hint ?? '', tone: 'muted', flex: true },
          ]}
        />
      ))}
    </Box>
  )
}
