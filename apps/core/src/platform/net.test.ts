import { describe, expect, test } from 'bun:test'
import { baseUrl, bindWarning, isLoopbackHost, reachableUrl } from './net.ts'

describe('bind host', () => {
  test('loopback hosts are recognised', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', '::1', '[::1]', 'localhost', 'LOCALHOST']) {
      expect(isLoopbackHost(h)).toBe(true)
    }
    for (const h of ['0.0.0.0', '::', '192.168.1.5', '100.64.0.1', 'example.com']) {
      expect(isLoopbackHost(h)).toBe(false)
    }
  })

  test('only a non-loopback bind warns about TLS', () => {
    expect(bindWarning('127.0.0.1')).toBeUndefined()
    expect(bindWarning('0.0.0.0')).toMatch(/without TLS.*Tailscale/)
  })

  test('baseUrl shows the real bound address', () => {
    expect(baseUrl('127.0.0.1', 7420)).toBe('http://127.0.0.1:7420')
    expect(baseUrl('100.64.0.1', 1)).toBe('http://100.64.0.1:1')
    expect(baseUrl('::1', 1)).toBe('http://[::1]:1')
    expect(baseUrl('0.0.0.0', 7420)).toBe('http://0.0.0.0:7420')
  })

  test('the default public URL is localhost for loopback and wildcard binds', () => {
    expect(reachableUrl('127.0.0.1', 7420)).toBe('http://localhost:7420')
    expect(reachableUrl('0.0.0.0', 7420)).toBe('http://localhost:7420')
    expect(reachableUrl('100.64.0.1', 7420)).toBe('http://100.64.0.1:7420')
  })
})
