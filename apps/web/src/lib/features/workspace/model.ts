// The workspace document and its operations come from `@keith/contracts` (ADR-0037, docs/specs/workspace.md): the core and this
// client apply an operation with the same code. This file only gathers what the feature uses.
export {
  applyWorkspaceOps,
  cascadeRect,
  clampRect,
  type Desktop,
  emptyWorkspace,
  findWindow,
  firstDesktop,
  focusedOf,
  LAYOUTS,
  type LayoutPreset,
  MAX_DESKTOPS,
  MAX_WINDOWS,
  type NormRect,
  type WindowState,
  type WorkspaceDoc,
  type WorkspaceOp,
  type WorkspaceOpError,
  type WorkspaceWindow,
} from '@keith/contracts'
