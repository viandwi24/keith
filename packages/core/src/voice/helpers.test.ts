import { describe, expect, test } from 'bun:test'
import { pcm16FromBytes, pcm16ToBytes, resampleLinear } from './pcm.ts'
import { createSentenceSplitter } from './sentences.ts'

describe('sentence splitter', () => {
  test('cuts at . ! ? followed by whitespace, and at newlines; pieces partition the text', () => {
    const s = createSentenceSplitter()
    const text = 'Pi is 3.14, right? Yes! "Quoted." Then\nnext line'
    const pieces = [...s.push(text.slice(0, 10)), ...s.push(text.slice(10)), ...s.flush()]
    expect(pieces).toEqual(['Pi is 3.14, right? ', 'Yes! ', '"Quoted." ', 'Then\n', 'next line'])
    expect(pieces.join('')).toBe(text)
  })

  test('waits for the whitespace after a terminator before cutting', () => {
    const s = createSentenceSplitter()
    expect(s.push('Version 2.')).toEqual([])
    expect(s.push('5 is out. ')).toEqual(['Version 2.5 is out. '])
  })

  test('caps long pieces at the last space, or hard without one', () => {
    const s = createSentenceSplitter(20)
    expect(s.push('aaaa bbbb cccc dddd eeee')).toEqual(['aaaa bbbb cccc dddd '])
    expect(s.flush()).toEqual(['eeee'])
    const hard = createSentenceSplitter(10)
    expect(hard.push('x'.repeat(25))).toEqual(['x'.repeat(10), 'x'.repeat(10)])
    expect(hard.flush()).toEqual(['x'.repeat(5)])
  })
})

describe('pcm', () => {
  test('bytes round-trip as little-endian samples, odd trailing byte dropped', () => {
    const samples = Int16Array.from([0, 1, -1, 32_767, -32_768])
    const bytes = pcm16ToBytes(samples)
    expect(bytes[2]).toBe(1)
    expect(Array.from(pcm16FromBytes(bytes))).toEqual(Array.from(samples))
    const odd = new Uint8Array([...bytes, 9])
    expect(pcm16FromBytes(odd).length).toBe(5)
    // An unaligned view works.
    expect(Array.from(pcm16FromBytes(odd.subarray(1, 5)))).toHaveLength(2)
  })

  test('linear resampling changes the length by the rate ratio and interpolates', () => {
    expect(resampleLinear(new Int16Array(960), 48_000, 16_000).length).toBe(320)
    expect(resampleLinear(new Int16Array(160), 8_000, 16_000).length).toBe(320)
    expect(Array.from(resampleLinear(Int16Array.from([0, 100]), 8_000, 16_000))).toEqual([0, 50, 100, 100])
  })
})
