import { afterAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchiveError, extractArchive, listArchive, readEntries, writeArchive } from './archive.ts'

// The archive helper (ADR-0006): modes survive a round trip, symlinks are stored as links, and an unsafe entry is
// refused before anything is written.
const dirs: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'keith-archive-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const mode = (path: string): number => statSync(path).mode & 0o777

/** One ustar header block plus its data, built at runtime: `typeflag` '0' a file, '2' a symlink to `linkname`. */
function tarEntry(name: string, content: string, typeflag = '0', linkname = ''): Buffer {
  const header = Buffer.alloc(512)
  const data = Buffer.from(content)
  header.write(name, 0, 100)
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
  header.write('00000000000\0', 136)
  header.write('        ', 148)
  header.write(typeflag, 156)
  header.write(linkname, 157, 100)
  header.write('ustar\0', 257)
  header.write('00', 263)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512)
  data.copy(padded)
  return Buffer.concat([header, padded])
}

const tarOf = (...entries: Buffer[]): Buffer => Buffer.concat([...entries, Buffer.alloc(1024)])

describe('archive helper', () => {
  test('a round trip keeps the modes of files and folders', async () => {
    const src = temp()
    mkdirSync(join(src, 'workspace', 'bin'), { recursive: true })
    writeFileSync(join(src, 'workspace', 'bin', 'run.sh'), 'echo hi')
    writeFileSync(join(src, 'secret.txt'), 'x')
    writeFileSync(join(src, 'manifest.json'), '{}')
    chmodSync(join(src, 'workspace', 'bin', 'run.sh'), 0o755)
    chmodSync(join(src, 'secret.txt'), 0o600)
    const archive = join(temp(), 'out.tar')
    await writeArchive(archive, [{ dir: src, names: ['manifest.json', 'secret.txt', 'workspace'] }])
    expect(mode(archive)).toBe(0o600)

    const dest = temp()
    await extractArchive(archive, dest)
    expect(mode(join(dest, 'workspace', 'bin', 'run.sh'))).toBe(0o755)
    expect(mode(join(dest, 'secret.txt'))).toBe(0o600)
    expect(readFileSync(join(dest, 'workspace', 'bin', 'run.sh'), 'utf8')).toBe('echo hi')
  })

  test('a symlink is stored as a link, never followed into its target', async () => {
    const src = temp()
    const outside = temp()
    writeFileSync(join(outside, 'private.txt'), 'not yours')
    symlinkSync(join(outside, 'private.txt'), join(src, 'peek'))
    const archive = join(temp(), 'links.tar')
    await writeArchive(archive, [{ dir: src, names: ['peek'] }])
    expect(await readEntries(archive)).toEqual([{ name: 'peek', kind: 'symlink' }])
    // the content of the target is not in the archive
    expect(readFileSync(archive).includes('not yours')).toBe(false)
    // extraction makes the link and leaves its target alone
    const dest = temp()
    await extractArchive(archive, dest)
    expect(lstatSync(join(dest, 'peek')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(outside, 'private.txt'), 'utf8')).toBe('not yours')
  })

  test('nothing is written through a symlink: an entry beneath a link is refused before extract', async () => {
    const root = temp()
    const outside = temp()
    const archive = join(root, 'through.tar')
    await Bun.write(
      archive,
      tarOf(tarEntry('peek', '', '2', outside), tarEntry('peek/planted.txt', 'boom')),
    )
    await expect(extractArchive(archive, join(root, 'dest'))).rejects.toThrow(
      /written through a link/,
    )
    expect(await Bun.file(join(outside, 'planted.txt')).exists()).toBe(false)
  })

  test('a path traversal entry is refused on extract, and nothing is written outside', async () => {
    const root = temp()
    const dest = join(root, 'dest')
    const archive = join(root, 'evil.tar')
    await Bun.write(archive, tarOf(tarEntry('../escaped.txt', 'boom')))
    await expect(extractArchive(archive, dest)).rejects.toThrow(/leaves the folder/)
    expect(await Bun.file(join(root, 'escaped.txt')).exists()).toBe(false)
  })

  test('an absolute name is refused, and a hard link is refused', async () => {
    const root = temp()
    const absolute = join(root, 'absolute.tar')
    await Bun.write(absolute, tarOf(tarEntry('/tmp/keith-absolute-probe.txt', 'boom')))
    await expect(listArchive(absolute)).rejects.toThrow(/leaves the folder/)
    const hard = join(root, 'hard.tar')
    await Bun.write(hard, tarOf(tarEntry('ok', '', '1', '/etc/passwd')))
    await expect(listArchive(hard)).rejects.toThrow(/hard link or a special file/)
  })

  test('a file that is not an archive is refused with the tar reason', async () => {
    const path = join(temp(), 'not-a-tar.tar')
    writeFileSync(path, 'this is plain text, not a tar')
    await expect(listArchive(path)).rejects.toThrow(ArchiveError)
  })

  test('an existing file is never overwritten', async () => {
    const src = temp()
    writeFileSync(join(src, 'a.txt'), 'a')
    const archive = join(temp(), 'taken.tar')
    writeFileSync(archive, 'occupied')
    await expect(writeArchive(archive, [{ dir: src, names: ['a.txt'] }])).rejects.toThrow(
      /cannot be created/,
    )
    expect(readFileSync(archive, 'utf8')).toBe('occupied')
  })
})
