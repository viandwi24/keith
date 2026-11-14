// `@keith/host/tui`: what a plugin's terminal view imports (docs/specs/plugin-views.md). Ink, React and the
// shared look come from here so a plugin imports only `@keith/host` and `@keith/contracts`.
//
// Deliberately absent: `render`, `Static` (its output piles up in every frame), `useStdout`, `useStderr` and
// `useStdin` (a write through them reaches the frame sink raw).

export {
  Badge,
  Block,
  type Column,
  cells,
  clip,
  Field,
  G,
  type Hint,
  KeyHints,
  ListRow,
  Markdown,
  type NavItem,
  NavList,
  Notice,
  type NoticeLevel,
  Panel,
  Rule,
  ScrollView,
  Surface,
  TextInput,
  type Theme,
  type Tone,
  Txt,
  useTheme,
  windowOf,
  wrapRows,
} from '@keith/ui'
export {
  Box,
  type BoxProps,
  type Key,
  measureElement,
  Newline,
  Spacer,
  Text,
  type TextProps,
  Transform,
  useApp,
  useFocus,
  useFocusManager,
  useInput,
  usePaste,
  useWindowSize,
} from 'ink'
export {
  type ComponentType,
  createContext,
  Fragment,
  memo,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
export type { ViewProps } from '../types.ts'
export { type Keith, type TerminalInfo, useKeith, useTerminal } from './context.tsx'
