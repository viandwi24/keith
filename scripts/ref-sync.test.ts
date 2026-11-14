import { describe, expect, test } from 'bun:test'
import {
  catalogVersion,
  commitOfTag,
  ignoresRef,
  lsRemoteArgs,
  nextPin,
  parsePin,
  syncCommands,
} from './ref-sync.ts'

// Full 40-character commit ids for the tests (not real objects): built from a short stem, so no key-like literal is written.
const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const TAG = 'eharness@0.9.0'

describe('ref-sync', () => {
  test('reads an exact eharness version from the catalog', () => {
    expect(catalogVersion({ workspaces: { catalog: { eharness: '0.9.0' } } })).toBe('0.9.0')
    expect(() => catalogVersion({ workspaces: { catalog: { eharness: '^0.9.0' } } })).toThrow()
    expect(() => catalogVersion({})).toThrow()
  })

  test('requires .ref/ in .gitignore', () => {
    expect(ignoresRef('node_modules/\n.ref/\n')).toBe(true)
    expect(ignoresRef('/.ref\n')).toBe(true)
    expect(ignoresRef('node_modules/\n')).toBe(false)
  })

  test('clones when missing and fetches the tag from the repo itself when present', () => {
    expect(syncCommands('0.9.0', false)).toEqual([
      [
        'git',
        'clone',
        '--depth',
        '1',
        '--branch',
        TAG,
        'https://github.com/viandwi24/eharness',
        '.ref/eharness',
      ],
    ])
    const [fetch, checkout] = syncCommands('0.9.0', true)
    expect(fetch).toEqual([
      'git',
      '-C',
      '.ref/eharness',
      'fetch',
      '--depth',
      '1',
      '--force',
      'https://github.com/viandwi24/eharness',
      `+refs/tags/${TAG}:refs/tags/${TAG}`,
    ])
    expect(checkout).toEqual(['git', '-C', '.ref/eharness', 'checkout', '--quiet', TAG])
  })

  test('resolves the tag with ls-remote, asking for the peeled commit too', () => {
    expect(lsRemoteArgs('0.9.0').slice(0, 2)).toEqual(['git', 'ls-remote'])
    expect(lsRemoteArgs('0.9.0').at(-1)).toBe(`refs/tags/${TAG}^{}`)
  })

  test('the commit of a lightweight tag is its own line; of an annotated tag, the peeled line', () => {
    expect(commitOfTag(`${OLD}\trefs/tags/${TAG}\n`, TAG)).toBe(OLD)
    const annotated = `${NEW}\trefs/tags/${TAG}\n${OLD}\trefs/tags/${TAG}^{}\n`
    expect(commitOfTag(annotated, TAG)).toBe(OLD)
    expect(() => commitOfTag('', TAG)).toThrow('was not found upstream')
    expect(() => commitOfTag(`abc\trefs/tags/${TAG}\n`, TAG)).toThrow('was not found upstream')
  })

  test('the pin file must hold a tag and a full commit', () => {
    expect(parsePin(JSON.stringify({ tag: TAG, commit: OLD }))).toEqual({ tag: TAG, commit: OLD })
    expect(() => parsePin(JSON.stringify({ tag: TAG, commit: 'abc' }))).toThrow('40-character')
    expect(() => parsePin(JSON.stringify({ commit: OLD }))).toThrow('"tag"')
  })

  test('a first sync records the commit; the same commit keeps the pin', () => {
    expect(nextPin(TAG, undefined, OLD, OLD, false)).toEqual({ tag: TAG, commit: OLD })
    expect(nextPin(TAG, { tag: TAG, commit: OLD }, OLD, OLD, false)).toEqual({
      tag: TAG,
      commit: OLD,
    })
  })

  test('a tag that moved upstream fails loudly and names both commits and --update', () => {
    const pin = { tag: TAG, commit: OLD }
    expect(() => nextPin(TAG, pin, NEW, NEW, false)).toThrow(
      `${TAG} moved upstream: scripts/ref-pin.json records ${OLD}, the tag now names ${NEW}`,
    )
    expect(() => nextPin(TAG, pin, NEW, NEW, false)).toThrow('ref:sync -- --update')
  })

  test('--update accepts the move and rewrites the pin to the checkout', () => {
    expect(nextPin(TAG, { tag: TAG, commit: OLD }, NEW, NEW, true)).toEqual({
      tag: TAG,
      commit: NEW,
    })
  })

  test('a checkout that is not the commit the tag names is refused', () => {
    expect(() => nextPin(TAG, undefined, NEW, OLD, false)).toThrow('run ref:sync again')
  })

  test('a pin for another version is replaced, not refused (a catalog bump)', () => {
    const old = { tag: 'eharness@0.8.0', commit: OLD }
    expect(nextPin(TAG, old, NEW, NEW, false)).toEqual({ tag: TAG, commit: NEW })
  })
})
