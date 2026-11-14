import { describe, expect, test } from 'bun:test'
import { insideShot, pixelToPoint } from './scale.ts'

const retina = { id: 0, width: 1440, height: 900, scale: 2 }
const shot = { width: 1280, height: 800 }

describe('pixelToPoint', () => {
  test('maps a 2x screenshot resized to 1280 wide onto points', () => {
    expect(pixelToPoint({ x: 640, y: 400 }, shot, retina)).toEqual({ x: 720, y: 450 })
    expect(pixelToPoint({ x: 0, y: 0 }, shot, retina)).toEqual({ x: 0, y: 0 })
  })

  test('an unscaled 1x screenshot at full size is the identity', () => {
    const display = { id: 0, width: 1920, height: 1080, scale: 1 }
    expect(pixelToPoint({ x: 1234, y: 567 }, { width: 1920, height: 1080 }, display)).toEqual({
      x: 1234,
      y: 567,
    })
  })

  test('a 1x screenshot resized down maps by the display points', () => {
    const display = { id: 0, width: 1920, height: 1080, scale: 1 }
    expect(pixelToPoint({ x: 640, y: 360 }, { width: 1280, height: 720 }, display)).toEqual({
      x: 960,
      y: 540,
    })
  })

  test('rounds to whole points', () => {
    // 1 px of a 1280 image is 2.25 physical px, 1.125 points.
    expect(pixelToPoint({ x: 1, y: 1 }, shot, retina)).toEqual({ x: 1, y: 1 })
    expect(pixelToPoint({ x: 3, y: 3 }, shot, retina)).toEqual({ x: 3, y: 3 })
  })
})

describe('insideShot', () => {
  test('the right and bottom edges are outside', () => {
    expect(insideShot({ x: 1279, y: 799 }, shot)).toBe(true)
    expect(insideShot({ x: 1280, y: 0 }, shot)).toBe(false)
    expect(insideShot({ x: 0, y: 800 }, shot)).toBe(false)
  })

  test('negative and fractional points are outside', () => {
    expect(insideShot({ x: -1, y: 0 }, shot)).toBe(false)
    expect(insideShot({ x: 1.5, y: 0 }, shot)).toBe(false)
  })
})
