// The plugin `web` (ADR-0038 §3, docs/specs/plugins/web.md): it declares the extension points of the web workspace and
// contributes its own built-in window apps through the same point as everyone else. `web.window` holds window apps
// (`WindowAppContributionSchema`), `web.hud` the ambient panels (no contributor yet). The workspace document itself stays in
// the core's parietal region (docs/specs/workspace.md), which reads the window apps from this point.
import {
  BUILTIN_WINDOW_APPS,
  WEB_HUD_POINT,
  WEB_WINDOW_POINT,
  type WindowAppContribution,
  WindowAppContributionSchema,
} from '@keith/contracts'
import { defineKeithPlugin, defineOperation, PLUGIN_API_VERSION } from '@keith/host'
import { z } from '@keith/host/schema'

/** An ambient HUD panel (a later phase draws them; the point exists so contributors can be checked now). */
export const HudPanelContributionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,32}$/),
    title: z.string().trim().min(1).max(40),
    entry: z.object({ builtin: z.string().regex(/^[a-z0-9-]{1,32}$/) }).strict(),
  })
  .strict()

const NO_PARAMS = z.object({}).strict()
const HttpsUrl = z
  .string()
  .max(2000)
  .url()
  .refine((u) => u.startsWith('https://'), 'an https URL')

/** The old screens as windows: one window each, no params. */
const SCREENS: WindowAppContribution[] = BUILTIN_WINDOW_APPS.map((a) => ({
  id: a.id.slice('web:'.length),
  title: a.title,
  description: a.about,
  params: NO_PARAMS,
  entry: { builtin: a.id.slice('web:'.length) },
  singleton: true,
}))

/** The built-in apps that take params (ADR-0038 §9 and P40.5). */
const VIEWERS: WindowAppContribution[] = [
  {
    id: 'browser',
    title: 'Browser',
    icon: '◎',
    description:
      'an https web page; many sites refuse to be framed and then show a card to open them in a new tab',
    params: z.object({ url: HttpsUrl }).strict(),
    entry: { builtin: 'browser' },
  },
  {
    id: 'doc',
    title: 'Document',
    icon: '¶',
    description: 'a Markdown document Keith writes for the person to read',
    params: z.object({ title: z.string().max(80).optional(), text: z.string().max(3500) }).strict(),
    entry: { builtin: 'doc' },
  },
  {
    id: 'media',
    title: 'Media',
    icon: '▶',
    description: 'an https image, video or audio file',
    params: z
      .object({
        url: HttpsUrl,
        kind: z.enum(['image', 'video', 'audio']),
        caption: z.string().max(200).optional(),
      })
      .strict(),
    entry: { builtin: 'media' },
  },
  {
    id: 'tui',
    title: 'Plugin view',
    icon: '▤',
    description: 'a plugin terminal view; view is <plugin>.<view> from the Apps menu',
    params: z.object({ view: z.string().regex(/^[a-z0-9-]+\.[a-z0-9_-]+$/) }).strict(),
    entry: { builtin: 'tui' },
  },
]

/** Every built-in app, checked against the point's schema at load. */
export const BUILTIN_APPS: readonly WindowAppContribution[] = [...SCREENS, ...VIEWERS]

/** The window apps as plain data, read through `k.contributions` (the HTTP surface of the point; the agent has its tool). */
export const apps = defineOperation({
  name: 'apps',
  description: 'List the window apps of the web workspace: id, title and what each shows.',
  input: z.object({}),
  output: z.array(
    z.object({
      id: z.string(),
      contributor: z.string(),
      title: z.string(),
      description: z.string(),
    }),
  ),
  permission: { capability: 'authenticated' },
  risk: 'read',
  expose: { ai: false },
  run(_input, k) {
    return k.contributions(WEB_WINDOW_POINT).flatMap((c) => {
      const app = WindowAppContributionSchema.safeParse(c.entry)
      return app.success
        ? [
            {
              id: `${c.contributor}:${app.data.id}`,
              contributor: c.contributor,
              title: app.data.title,
              description: app.data.description ?? '',
            },
          ]
        : []
    })
  },
})

export default defineKeithPlugin({
  id: 'web',
  version: '0.1.0',
  apiVersion: PLUGIN_API_VERSION,
  title: 'Web workspace',
  description:
    'The window apps and HUD panels of the web workspace, as extension points other plugins contribute to.',
  extensionPoints: {
    [WEB_WINDOW_POINT]: WindowAppContributionSchema,
    [WEB_HUD_POINT]: HudPanelContributionSchema,
  },
  contributes: {
    [WEB_WINDOW_POINT]: BUILTIN_APPS as unknown as readonly ({ id: string } & Record<
      string,
      unknown
    >)[],
  },
  operations: [apps],
})
