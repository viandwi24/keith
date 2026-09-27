import { expect, test } from 'bun:test'
import { fetchCoreFile, imageSource } from './images.ts'

test.each([
  ['https URL', 'https://example.com/a.png', { kind: 'direct', src: 'https://example.com/a.png' }],
  ['data image', 'data:image/png;base64,AAAA', { kind: 'direct', src: 'data:image/png;base64,AAAA' }],
  ['core file', '/v1/files/fil_1', { kind: 'core-file', path: '/v1/files/fil_1' }],
  ['http URL', 'http://example.com/a.png', { kind: 'refused' }],
  ['javascript URL', 'javascript:alert(1)', { kind: 'refused' }],
  ['data html', 'data:text/html,<b>x</b>', { kind: 'refused' }],
  ['path traversal', '/v1/files/../me', { kind: 'refused' }],
  ['other core path', '/v1/me', { kind: 'refused' }],
])('imageSource: %s', (_name, url, expected) => {
  expect(imageSource(url)).toEqual(expected as ReturnType<typeof imageSource>)
})

test('fetchCoreFile sends the bearer token and fails on HTTP errors', async () => {
  const seen: string[] = []
  const ok = await fetchCoreFile(
    {
      baseUrl: 'http://core.test',
      token: 'abc',
      fetch: async (url, init) => {
        seen.push(`${url} ${new Headers(init.headers).get('authorization')}`)
        return new Response('png')
      },
    },
    '/v1/files/fil_1',
  )
  expect(await ok.text()).toBe('png')
  expect(seen).toEqual(['http://core.test/v1/files/fil_1 Bearer abc'])
  let failed: unknown = null
  try {
    await fetchCoreFile(
      { baseUrl: 'http://core.test', token: 'abc', fetch: async () => new Response('', { status: 401 }) },
      '/v1/files/fil_1',
    )
  } catch (error) {
    failed = error
  }
  expect(String(failed)).toContain('HTTP 401')
})
