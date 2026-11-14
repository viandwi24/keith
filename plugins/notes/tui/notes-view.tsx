import { Box, useState, useTerminal } from '@keith/host/tui'
import { Browse } from './browse.tsx'
import { Reader } from './reader.tsx'
import { SharePanel } from './share.tsx'

type Route =
  | { kind: 'browse' }
  | { kind: 'read'; id: string }
  | { kind: 'share'; id: string; from: 'browse' | 'read' }

/**
 * The Notes browser (docs/specs/plugins/notes.md): list, search, read and, for the viewer's own notes, share. A full Ink view
 * that reads and writes only through `useKeith().call` as the viewer, so what is on screen is what the viewer may see: another
 * person's private note never reaches it (the leak kit runs through this view in `notes-view.test.tsx`). `esc` and `ctrl+g` belong
 * to the host; going back inside the view is `b`, `←` or backspace.
 */
export default function NotesView() {
  const { cols, rows } = useTerminal()
  const [route, setRoute] = useState<Route>({ kind: 'browse' })
  const width = Math.max(10, cols)
  return (
    <Box flexDirection="column" width={width} height={rows}>
      {/* the browser stays mounted under the others: its search and its place survive a read */}
      <Box flexDirection="column" display={route.kind === 'browse' ? 'flex' : 'none'}>
        <Browse
          active={route.kind === 'browse'}
          width={width}
          height={rows}
          onRead={(n) => setRoute({ kind: 'read', id: n.id })}
          onShare={(id) => setRoute({ kind: 'share', id, from: 'browse' })}
        />
      </Box>
      {route.kind === 'read' && (
        <Reader
          id={route.id}
          width={width}
          height={rows}
          onBack={() => setRoute({ kind: 'browse' })}
          onShare={(id) => setRoute({ kind: 'share', id, from: 'read' })}
        />
      )}
      {route.kind === 'share' && (
        <SharePanel
          id={route.id}
          width={width}
          height={rows}
          onBack={() =>
            setRoute(route.from === 'read' ? { kind: 'read', id: route.id } : { kind: 'browse' })
          }
        />
      )}
    </Box>
  )
}
