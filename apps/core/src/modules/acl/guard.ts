import { definePlugin, type HarnessPlugin } from 'eharness'

/**
 * Tools that change who can reach a resource. A plugin that adds one names it `acl_<verb>` or lists it here;
 * the guard asks the person before each call, whatever the risk table says (ADR-0015, decision 8).
 */
export const ACL_CHANGING_TOOLS: ReadonlySet<string> = new Set([
  'acl_share',
  'acl_unshare',
  'acl_chmod',
  'acl_chgrp',
  'acl_chown',
])

/** True for a tool that changes access: a static table and a name prefix, never live state. */
export const changesAccess = (toolName: string): boolean =>
  ACL_CHANGING_TOOLS.has(toolName) || toolName.startsWith('acl_')

export const ACL_ASK_REASON = 'this changes who can access a resource'

/**
 * Always-ask for ACL-changing tools. Decides from the tool name only (`tool.approve` is re-run on
 * re-validation, so it must not read live state), and only ever asks: it cannot approve. A call that
 * widens to everyone still needs the step-up on top (`acl.md`, "Changing access").
 */
export function aclGuard(): HarnessPlugin {
  return definePlugin({
    name: 'keith-acl-guard',
    setup: () => ({
      hooks: {
        'tool.approve': (_ctx, e) => {
          if (!changesAccess(e.toolName)) return
          return { type: 'user-approval', reason: ACL_ASK_REASON }
        },
      },
    }),
  })
}
