import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import type { UiBlockEntry } from '@keith/client'
import { type UiBlock, uiBlockToText } from '@keith/protocol'
import { useDom } from '../../test/dom.ts'
import type { BlockAction, BlockEnv } from './block-context.tsx'

useDom()
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react')
const { BlockEnvContext } = await import('./block-context.tsx')
const { HTML_SANDBOX, UiBlockView } = await import('./ui-block.tsx')
afterEach(cleanup)

const MESSAGE_ID = 'msg_01J8ZQ3K4M0000000000000001'

function entry(block: UiBlock, fallbackText = uiBlockToText(block)): UiBlockEntry {
  return { block, fallbackText }
}

function renderBlock(block: UiBlock, opts: { env?: Partial<BlockEnv>; messageId?: string | null } = {}) {
  const env: BlockEnv = { sendAction: () => null, files: null, ...opts.env }
  const messageId = opts.messageId === null ? undefined : (opts.messageId ?? MESSAGE_ID)
  return render(
    <BlockEnvContext.Provider value={env}>
      <UiBlockView entry={entry(block)} messageId={messageId} />
    </BlockEnvContext.Provider>,
  )
}

describe('standard blocks', () => {
  test('markdown renders CommonMark and skips raw HTML', () => {
    const { container } = renderBlock({
      type: 'markdown',
      id: 'md',
      text: '**bold** and [a link](https://example.com)\n\n<script>alert(1)</script><b>raw</b>',
    })
    expect(container.querySelector('strong')?.textContent).toBe('bold')
    const link = container.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://example.com')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
  })

  test('markdown drops unsafe links and does not load markdown images', () => {
    const { container } = renderBlock({
      type: 'markdown',
      id: 'md',
      text: '[click](javascript:alert(1)) ![a cat](https://example.com/cat.png)',
    })
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('click')
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('[image: a cat]')
  })

  test('card renders title, subtitle, markdown body, image, children and footer', () => {
    const { container, getByText } = renderBlock({
      type: 'card',
      id: 'weather',
      title: 'Surabaya',
      subtitle: 'Now',
      body: '**31°C**, humid.',
      image: { url: 'https://example.com/sky.png', alt: 'sky' },
      footer: 'Source: BMKG',
      children: [{ type: 'keyValue', id: 'details', pairs: [{ key: 'Humidity', value: '78%' }] }],
    })
    expect(container.querySelector('[data-slot="card"]')).not.toBeNull()
    expect(getByText('Surabaya')).toBeTruthy()
    expect(getByText('Now')).toBeTruthy()
    expect(container.querySelector('strong')?.textContent).toBe('31°C')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/sky.png')
    expect(getByText('Humidity')).toBeTruthy()
    expect(getByText('78%')).toBeTruthy()
    expect(getByText('Source: BMKG')).toBeTruthy()
  })

  test('list renders items with subtitle and meta, numbered when ordered', () => {
    const { container, getByText } = renderBlock({
      type: 'list',
      id: 'venues',
      ordered: true,
      items: [{ title: 'Riverside Hall', subtitle: 'Downtown', meta: '4000' }, { title: 'Harbor Center' }],
    })
    expect(container.querySelector('ol')).not.toBeNull()
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(getByText('Downtown')).toBeTruthy()
    expect(getByText('4000')).toBeTruthy()
    expect(getByText('2.')).toBeTruthy()

    cleanup()
    const unordered = renderBlock({ type: 'list', id: 'l', items: [{ title: 'one' }] })
    expect(unordered.container.querySelector('ul')).not.toBeNull()
  })

  test('table renders columns, rows and alignment', () => {
    const { container } = renderBlock({
      type: 'table',
      id: 'venues',
      columns: [
        { key: 'name', label: 'Venue' },
        { key: 'capacity', label: 'Capacity', align: 'right' },
      ],
      rows: [
        { name: 'Riverside Hall', capacity: 4000 },
        { name: 'Harbor Center', capacity: 6500 },
      ],
    })
    const headers = [...container.querySelectorAll('th')].map((th) => th.textContent)
    expect(headers).toEqual(['Venue', 'Capacity'])
    const rows = [...container.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent),
    )
    expect(rows).toEqual([
      ['Riverside Hall', '4000'],
      ['Harbor Center', '6500'],
    ])
    expect(container.querySelector('tbody td:last-child')?.className).toContain('text-right')
  })

  test('keyValue renders pairs as a description list', () => {
    const { container } = renderBlock({
      type: 'keyValue',
      id: 'kv',
      pairs: [
        { key: 'Humidity', value: '78%' },
        { key: 'Wind', value: '12 km/h' },
      ],
    })
    expect([...container.querySelectorAll('dt')].map((e) => e.textContent)).toEqual(['Humidity', 'Wind'])
    expect([...container.querySelectorAll('dd')].map((e) => e.textContent)).toEqual(['78%', '12 km/h'])
  })

  test('stack renders children in the given direction', () => {
    const { container, getByText } = renderBlock({
      type: 'stack',
      id: 's',
      direction: 'horizontal',
      children: [
        { type: 'markdown', id: 'a', text: 'left' },
        {
          type: 'stack',
          id: 'inner',
          direction: 'vertical',
          children: [{ type: 'markdown', id: 'b', text: 'right' }],
        },
      ],
    })
    expect(getByText('left')).toBeTruthy()
    expect(getByText('right')).toBeTruthy()
    const outer = container.querySelector('[data-slot="ui-block"] > div')
    expect(outer?.className).toContain('flex-row')
    expect(outer?.querySelector('.flex-col')).not.toBeNull()
  })
})

describe('image block', () => {
  test('https and data:image URLs are used directly', () => {
    const https = renderBlock({
      type: 'image',
      id: 'i',
      url: 'https://example.com/a.png',
      alt: 'a',
      width: 120,
      height: 80,
    })
    const img = https.container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://example.com/a.png')
    expect(img?.getAttribute('alt')).toBe('a')
    expect(img?.getAttribute('width')).toBe('120')
    cleanup()
    const data = renderBlock({ type: 'image', id: 'i', url: 'data:image/png;base64,AAAA', alt: 'dot' })
    expect(data.container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
  })

  test('core files are fetched with the bearer token and shown from an object URL', async () => {
    const calls: { url: string; auth: string | null }[] = []
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get('authorization') })
      return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))
    }
    const { container } = renderBlock(
      { type: 'image', id: 'i', url: '/v1/files/fil_01J8ZQ3K4M0000000000000001', alt: 'photo' },
      { env: { files: { baseUrl: 'http://core.test', token: 'tok-1', fetch: fakeFetch } } },
    )
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
    expect(calls).toEqual([
      { url: 'http://core.test/v1/files/fil_01J8ZQ3K4M0000000000000001', auth: 'Bearer tok-1' },
    ])
    expect(container.querySelector('img')?.getAttribute('src')).toStartWith('blob:')
  })

  test('a core file that fails to load shows the alt text', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const fakeFetch = async () => new Response('nope', { status: 404 })
    const { container } = renderBlock(
      { type: 'image', id: 'i', url: '/v1/files/fil_01J8ZQ3K4M0000000000000001', alt: 'photo' },
      { env: { files: { baseUrl: 'http://core.test', token: 't', fetch: fakeFetch } } },
    )
    await waitFor(() => expect(container.textContent).toContain('[image: photo]'))
    expect(container.querySelector('img')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  test('a URL outside the allowed schemes is never loaded', () => {
    const { container } = renderBlock({ type: 'image', id: 'i', url: 'http://example.com/a.png', alt: 'x' })
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('[image: x]')
  })
})

describe('actions block', () => {
  const block: UiBlock = {
    type: 'actions',
    id: 'confirm',
    actions: [
      { id: 'book', label: 'Book Riverside', style: 'primary', value: { venue: 'riverside' } },
      { id: 'more', label: 'Show more' },
      { id: 'drop', label: 'Drop it', style: 'danger' },
    ],
  }

  test('a click sends ui.action with the message, block, action and value', () => {
    const sent: BlockAction[] = []
    const { getByText } = renderBlock(block, {
      env: {
        sendAction: (a) => {
          sent.push(a)
          return null
        },
      },
    })
    act(() => {
      fireEvent.click(getByText('Book Riverside'))
      fireEvent.click(getByText('Show more'))
    })
    expect(sent).toEqual([
      { messageId: MESSAGE_ID, blockId: 'confirm', actionId: 'book', value: { venue: 'riverside' } },
      { messageId: MESSAGE_ID, blockId: 'confirm', actionId: 'more' },
    ])
  })

  test('a refused click shows why', () => {
    const { getByText } = renderBlock(block, { env: { sendAction: () => 'Not connected' } })
    act(() => {
      fireEvent.click(getByText('Show more'))
    })
    expect(getByText('Not connected')).toBeTruthy()
  })

  test('buttons of a block without a message are disabled', () => {
    const sent: BlockAction[] = []
    const { container } = renderBlock(block, {
      messageId: null,
      env: {
        sendAction: (a) => {
          sent.push(a)
          return null
        },
      },
    })
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons).toHaveLength(3)
    for (const button of buttons) expect(button.hasAttribute('disabled')).toBe(true)
    for (const button of buttons) fireEvent.click(button)
    expect(sent).toEqual([])
  })
})

describe('html block and fallback', () => {
  test('html renders in an iframe with exactly sandbox="allow-scripts"', () => {
    const html = '<!doctype html><p id="x">hi</p><script>document.body.append("!")</script>'
    const { container } = renderBlock({ type: 'html', id: 'chart', html, height: 300 })
    const frame = container.querySelector('iframe')
    expect(frame).not.toBeNull()
    expect(HTML_SANDBOX).toBe('allow-scripts')
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(frame?.getAttribute('srcdoc')).toBe(html)
    expect(frame?.getAttribute('src')).toBeNull()
    expect(frame?.style.height).toBe('300px')
    // The document is never inlined into the app's own DOM.
    expect(container.querySelector('#x')).toBeNull()
  })

  test('an unknown block type shows its fallback text', () => {
    const unknown = { type: 'x-weather-radar', id: 'radar' } as unknown as UiBlock
    const { container } = render(
      <UiBlockView
        entry={{ block: unknown, fallbackText: 'Rain radar: heavy rain at 16:00' }}
        messageId={MESSAGE_ID}
      />,
    )
    expect(container.querySelector('[data-slot="ui-fallback"]')?.textContent).toBe(
      'Rain radar: heavy rain at 16:00',
    )
  })
})
