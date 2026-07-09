import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const iconDir = join(root, 'public', 'icons')
mkdirSync(iconDir, { recursive: true })

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(iconDir, `message-bot-${size}.png`), renderIcon(size))
}

function renderIcon(size) {
  const pixels = new Uint8Array(size * size * 4)
  fill(pixels, size, [0, 0, 0, 0])
  roundedRect(pixels, size, 0, 0, size, size, size * 0.22, [36, 91, 95, 255])
  roundedRect(
    pixels,
    size,
    size * 0.11,
    size * 0.23,
    size * 0.78,
    size * 0.51,
    size * 0.13,
    [248, 251, 248, 255],
  )
  triangle(
    pixels,
    size,
    size * 0.34,
    size * 0.7,
    size * 0.34,
    size * 0.88,
    size * 0.55,
    size * 0.7,
    [248, 251, 248, 255],
  )
  roundedRect(
    pixels,
    size,
    size * 0.25,
    size * 0.42,
    size * 0.5,
    size * 0.22,
    size * 0.08,
    [220, 236, 238, 255],
  )
  line(pixels, size, size * 0.5, size * 0.34, size * 0.5, size * 0.24, size * 0.045, [248, 251, 248, 255])
  circle(pixels, size, size * 0.5, size * 0.21, size * 0.055, [248, 251, 248, 255])
  circle(pixels, size, size * 0.39, size * 0.52, size * 0.045, [36, 91, 95, 255])
  circle(pixels, size, size * 0.61, size * 0.52, size * 0.045, [36, 91, 95, 255])
  line(pixels, size, size * 0.45, size * 0.61, size * 0.55, size * 0.61, size * 0.03, [36, 91, 95, 255])
  return encodePng(size, size, pixels)
}

function fill(pixels, size, color) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      setPixel(pixels, size, x, y, color)
    }
  }
}

function roundedRect(pixels, size, x, y, width, height, radius, color) {
  const left = Math.floor(x)
  const top = Math.floor(y)
  const right = Math.ceil(x + width)
  const bottom = Math.ceil(y + height)
  for (let py = top; py < bottom; py += 1) {
    for (let px = left; px < right; px += 1) {
      const cx = clamp(px, x + radius, x + width - radius)
      const cy = clamp(py, y + radius, y + height - radius)
      if ((px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2) {
        setPixel(pixels, size, px, py, color)
      }
    }
  }
}

function triangle(pixels, size, ax, ay, bx, by, cx, cy, color) {
  const minX = Math.floor(Math.min(ax, bx, cx))
  const maxX = Math.ceil(Math.max(ax, bx, cx))
  const minY = Math.floor(Math.min(ay, by, cy))
  const maxY = Math.ceil(Math.max(ay, by, cy))
  const area = edge(ax, ay, bx, by, cx, cy)
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const w1 = edge(bx, by, cx, cy, x, y) / area
      const w2 = edge(cx, cy, ax, ay, x, y) / area
      const w3 = edge(ax, ay, bx, by, x, y) / area
      if (w1 >= 0 && w2 >= 0 && w3 >= 0) {
        setPixel(pixels, size, x, y, color)
      }
    }
  }
}

function circle(pixels, size, cx, cy, radius, color) {
  const left = Math.floor(cx - radius)
  const right = Math.ceil(cx + radius)
  const top = Math.floor(cy - radius)
  const bottom = Math.ceil(cy + radius)
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) {
        setPixel(pixels, size, x, y, color)
      }
    }
  }
}

function line(pixels, size, x1, y1, x2, y2, width, color) {
  const minX = Math.floor(Math.min(x1, x2) - width)
  const maxX = Math.ceil(Math.max(x1, x2) + width)
  const minY = Math.floor(Math.min(y1, y2) - width)
  const maxY = Math.ceil(Math.max(y1, y2) + width)
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSquared = dx * dx + dy * dy
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = clamp(((x - x1) * dx + (y - y1) * dy) / lengthSquared, 0, 1)
      const px = x1 + t * dx
      const py = y1 + t * dy
      if ((x - px) ** 2 + (y - py) ** 2 <= width ** 2) {
        setPixel(pixels, size, x, y, color)
      }
    }
  }
}

function setPixel(pixels, size, x, y, color) {
  const px = Math.round(x)
  const py = Math.round(y)
  if (px < 0 || py < 0 || px >= size || py >= size) return
  const offset = (py * size + px) * 4
  pixels[offset] = color[0]
  pixels[offset + 1] = color[1]
  pixels[offset + 2] = color[2]
  pixels[offset + 3] = color[3]
}

function encodePng(width, height, pixels) {
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride
    raw[rowStart] = 0
    Buffer.from(pixels.buffer, y * width * 4, width * 4).copy(raw, rowStart + 1)
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', bufferFromChunks(u32be(width), u32be(height), Buffer.from([8, 6, 0, 0, 0]))),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type)
  return bufferFromChunks(u32be(data.length), typeBuffer, data, u32be(crc32(bufferFromChunks(typeBuffer, data))))
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function u32be(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value >>> 0)
  return buffer
}

function bufferFromChunks(...chunks) {
  return Buffer.concat(chunks)
}

function edge(ax, ay, bx, by, cx, cy) {
  return (cx - ax) * (by - ay) - (cy - ay) * (bx - ax)
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

