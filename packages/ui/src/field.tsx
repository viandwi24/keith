import { Box } from 'ink'
import { G } from './glyphs.ts'
import { stripControl } from './safe-text.ts'
import { Txt } from './text.tsx'
import { TextInput } from './text-input.tsx'

export interface FieldProps {
  label: string
  value: string
  /** The field has the keys: its input is live (a text field) or its choice is highlighted (a select). */
  focused: boolean
  width: number
  /** A secret: the value is never drawn, only `•` (the focused input masks while typing). */
  secret?: boolean
  /** A choice list: `‹ value ›`, the caller changes the value (arrows or space). */
  options?: readonly string[]
  placeholder?: string
  /** Width of the label column (default 14). */
  labelWidth?: number
  onChange?(value: string): void
  onSubmit?(value: string): void
}

/** One labelled row of a form: a text input, a hidden input or a choice. */
export function Field({
  label,
  value: rawValue,
  focused,
  width,
  secret = false,
  options,
  placeholder,
  labelWidth = 14,
  onChange,
  onSubmit,
}: FieldProps) {
  const value = stripControl(rawValue)
  const body = (() => {
    if (options !== undefined)
      return <Txt tone={focused ? 'accent' : 'text'}>{`‹ ${value === '' ? '-' : value} ›`}</Txt>
    if (focused)
      return (
        <TextInput
          mask={secret}
          focus
          value={rawValue}
          width={Math.max(8, width - labelWidth - 3)}
          {...(placeholder === undefined ? {} : { placeholder })}
          onChange={onChange ?? (() => {})}
          onSubmit={onSubmit ?? (() => {})}
        />
      )
    if (value === '') return <Txt tone="muted">{placeholder ?? '-'}</Txt>
    return <Txt wrap="truncate-end">{secret ? G.mask.repeat(8) : value}</Txt>
  })()
  return (
    <Box width={width}>
      <Txt bold tone={focused ? 'accent' : 'muted'}>
        {focused ? `${G.pointer} ` : '  '}
      </Txt>
      <Box width={labelWidth} flexShrink={0}>
        <Txt tone="muted" wrap="truncate-end">
          {stripControl(label)}
        </Txt>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        {body}
      </Box>
    </Box>
  )
}
