// Maps coordinates from the pixel space of the latest screenshot to points, the space input events use.
import type { DisplayInfo } from './backend.ts'

export interface ShotSize {
  readonly width: number
  readonly height: number
}

export interface Point {
  readonly x: number
  readonly y: number
}

/**
 * A point in the screenshot (`shot` pixels) to points on the display. The display is `width` x `height`
 * points at `scale` physical pixels per point, so the image pixel becomes a physical pixel
 * (x * physical width / image width) and that becomes points (physical / scale).
 */
export function pixelToPoint(point: Point, shot: ShotSize, display: DisplayInfo): Point {
  const physicalWidth = display.width * display.scale
  const physicalHeight = display.height * display.scale
  return {
    x: Math.round((point.x * physicalWidth) / shot.width / display.scale),
    y: Math.round((point.y * physicalHeight) / shot.height / display.scale),
  }
}

/** Whether a point lies inside the screenshot (right and bottom edges excluded). */
export function insideShot(point: Point, shot: ShotSize): boolean {
  return (
    Number.isInteger(point.x) &&
    Number.isInteger(point.y) &&
    point.x >= 0 &&
    point.y >= 0 &&
    point.x < shot.width &&
    point.y < shot.height
  )
}
