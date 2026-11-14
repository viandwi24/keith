import { describe, expect, test } from 'bun:test'
import type { LanguageModel } from 'ai'
import { scriptedModel } from 'eharness/testing'
import type { ProviderService } from '../providers/index.ts'
import { createSearch, WEB_SEARCH_AUX_PERSON } from './web-search.ts'

// audit F16: the web search call is a model call like any other, so the worker hands its search model to `observeAux`, and the
// call is recorded as `aux:web-search:<person>` (docs/specs/activity-logs.md "Aux calls"), the person who asked (eharness 0.13.0
// passes the session context to `search`), or `unknown` without a principal. The search is not run against the network.

const providersWith = (model: LanguageModel): ProviderService =>
  ({
    manager: {
      listProfiles: async () => [{ id: 'or', enabled: true, definitionId: 'openrouter' }],
      resolve: () => model,
    },
  }) as unknown as ProviderService

describe('web search: the search model is observed', () => {
  test('the observe hook wraps the model of each search, under the web-search name and the unknown person', async () => {
    const seen: Array<[string, string]> = []
    const model = scriptedModel([{ text: 'The sources say yes.' }]) as never as LanguageModel
    const search = createSearch(providersWith(model), (wrapped, personId) => {
      seen.push(['web-search', personId])
      return wrapped
    })
    const result = await search('is it raining', {})
    expect(result).toMatchObject({ text: 'The sources say yes.' })
    expect(seen).toEqual([['web-search', WEB_SEARCH_AUX_PERSON]])
  })

  test('the search is recorded under the person who asked, from the session context of the call', async () => {
    const seen: string[] = []
    const model = scriptedModel([
      { text: 'Ana asked.' },
      { text: 'Ben asked.' },
    ]) as never as LanguageModel
    const search = createSearch(providersWith(model), (wrapped, personId) => {
      seen.push(personId)
      return wrapped
    })
    const ctxOf = (id: string) =>
      ({ principal: { id }, session: { id: `front:${id}:agent:cortex.research` } }) as never
    await search('first', { ctx: ctxOf('ana') })
    await search('second', { ctx: ctxOf('ben') })
    expect(seen).toEqual(['ana', 'ben'])
  })

  test('without a principal in the context the row names the unknown person', async () => {
    const seen: string[] = []
    const model = scriptedModel([{ text: 'a' }, { text: 'b' }]) as never as LanguageModel
    const search = createSearch(providersWith(model), (wrapped, personId) => {
      seen.push(personId)
      return wrapped
    })
    await search('no principal', { ctx: { session: { id: 's' } } as never })
    await search('empty principal', { ctx: { principal: { id: '' } } as never })
    expect(seen).toEqual([WEB_SEARCH_AUX_PERSON, WEB_SEARCH_AUX_PERSON])
  })

  test('without an observe hook the search still answers', async () => {
    const model = scriptedModel([{ text: 'Plain answer.' }]) as never as LanguageModel
    const search = createSearch(providersWith(model))
    expect(await search('anything', {})).toMatchObject({ text: 'Plain answer.' })
  })
})
