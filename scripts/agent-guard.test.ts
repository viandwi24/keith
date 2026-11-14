import { describe, expect, test } from 'bun:test'
import { checkCommand, checkEdit } from './agent-guard.ts'

describe('checkCommand', () => {
  test('blocks pushes, remotes, hard resets and skipped hooks', () => {
    expect(checkCommand('git push origin main')).toBeString()
    expect(checkCommand('git push --force')).toBeString()
    expect(checkCommand('git remote add origin x')).toBeString()
    expect(checkCommand('git reset --hard HEAD~1')).toBeString()
    expect(checkCommand('git commit --no-verify -m x')).toBeString()
  })

  test('allows rm -rf only under data/ or a temp directory', () => {
    expect(checkCommand('rm -rf data/workspace')).toBeUndefined()
    expect(checkCommand('rm -rf /tmp/keith-x')).toBeUndefined()
    expect(checkCommand('rm -rf apps')).toBeString()
    expect(checkCommand('cd x && rm -fr ../y')).toBeString()
    expect(checkCommand('rm -f a.txt')).toBeUndefined()
  })

  test('allows ordinary commands', () => {
    expect(checkCommand('git status && bun run check')).toBeUndefined()
    expect(checkCommand('git commit -m "docs: push notes"')).toBeUndefined()
  })
})

describe('checkEdit', () => {
  test('blocks generated files and lockfiles', () => {
    expect(checkEdit('bun.lock')).toBeString()
    expect(checkEdit('packages/db/drizzle/0001_init.sql')).toBeString()
    expect(checkEdit('scripts/exports.snapshot.json')).toBeString()
  })

  test('allows source files', () => {
    expect(checkEdit('apps/core/src/main.ts')).toBeUndefined()
  })
})
