import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron'
import type { OpenDialogOptions } from 'electron'
import { access, copyFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import exifr from 'exifr'
import type { DirectoryEntry, DirectoryListing, ImageEntry, ImageMetadata } from '../shared/contracts'

const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.jpeg',
  '.jpg',
  '.png',
  '.tif',
  '.tiff',
  '.webp'
])

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let mainWindow: BrowserWindow | null = null

function registerImageProtocol(): void {
  protocol.handle('gallery-image', async (request) => {
    const url = new URL(request.url)
    const encodedPath = url.searchParams.get('path')

    if (!encodedPath) {
      return new Response('Missing image path', { status: 400 })
    }

    try {
      const filePath = decodeURIComponent(encodedPath)
      const fileUrl = pathToFileURL(filePath).toString()
      return net.fetch(fileUrl)
    } catch {
      return new Response('Invalid image path', { status: 400 })
    }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    title: 'Raster Relay',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function toMetadataValue(value: unknown): string | null {
  if (value == null) {
    return null
  }

  if (value instanceof Date) {
    return value.toLocaleString()
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) ? `${value}` : value.toFixed(2)
  }

  if (typeof value === 'object' && 'numerator' in (value as Record<string, unknown>) && 'denominator' in (value as Record<string, unknown>)) {
    const numerator = Number((value as Record<string, unknown>).numerator)
    const denominator = Number((value as Record<string, unknown>).denominator)
    if (!Number.isNaN(numerator) && !Number.isNaN(denominator) && denominator !== 0) {
      const decimal = numerator / denominator
      return `${numerator}/${denominator} (${decimal.toFixed(3)}s)`
    }
  }

  if (typeof value === 'object') {
    return JSON.stringify(value)
  }

  return String(value)
}

function toExifNumber(value: unknown): number | null {
  if (typeof value === 'number' && !Number.isNaN(value)) {
    return value
  }

  if (typeof value === 'object' && value !== null && 'numerator' in value && 'denominator' in value) {
    const numerator = Number((value as Record<string, unknown>).numerator)
    const denominator = Number((value as Record<string, unknown>).denominator)
    if (!Number.isNaN(numerator) && !Number.isNaN(denominator) && denominator !== 0) {
      return numerator / denominator
    }
  }

  return null
}

function toFraction(value: number, maxDenominator = 8000): string {
  if (value <= 0) {
    return `${value}`
  }

  if (value >= 1) {
    if (Number.isInteger(value)) {
      return `${value}/1`
    }

    const denominator = 100
    const numerator = Math.round(value * denominator)
    return `${numerator}/${denominator}`
  }

  const denominator = Math.min(maxDenominator, Math.round(1 / value))
  return `1/${denominator}`
}

function formatAperture(value: unknown): string | null {
  const numeric = toExifNumber(value)
  if (numeric == null) {
    return null
  }

  const trimmed = numeric.toFixed(2).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')
  return `f${trimmed}`
}

function formatExposure(value: unknown): string | null {
  if (typeof value === 'object' && value !== null && 'numerator' in value && 'denominator' in value) {
    const numerator = Number((value as Record<string, unknown>).numerator)
    const denominator = Number((value as Record<string, unknown>).denominator)
    if (!Number.isNaN(numerator) && !Number.isNaN(denominator) && denominator !== 0) {
      return `${numerator}/${denominator}s`
    }
  }

  const numeric = toExifNumber(value)
  if (numeric == null) {
    return null
  }

  if (numeric >= 1) {
    return `${numeric.toFixed(2).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')}s`
  }

  return `${toFraction(numeric)}s`
}

async function getImageMetadata(imagePath: string): Promise<ImageMetadata> {
  const fileStats = await stat(imagePath)
  const parsed = await exifr.parse(imagePath, {
    tiff: true,
    exif: true,
    xmp: false,
    gps: true,
    iptc: false,
    interop: false,
    ifd1: false
  })

  const keyMap: Array<[string, string]> = [
    ['Camera', 'Model'],
    ['Make', 'Make'],
    ['Lens', 'LensModel'],
    ['Shot Time', 'DateTimeOriginal'],
    ['ISO', 'ISO'],
    ['Aperture', 'FNumber'],
    ['Exposure', 'ExposureTime'],
    ['Focal Length', 'FocalLength'],
    ['Width', 'ExifImageWidth'],
    ['Height', 'ExifImageHeight'],
    ['GPS Latitude', 'latitude'],
    ['GPS Longitude', 'longitude']
  ]

  const entries = [
    { label: 'File Name', value: path.basename(imagePath) },
    { label: 'File Size', value: `${(fileStats.size / (1024 * 1024)).toFixed(2)} MB` },
    { label: 'Modified', value: new Date(fileStats.mtimeMs).toLocaleString() }
  ]

  for (const [label, key] of keyMap) {
    const rawValue = (parsed as Record<string, unknown> | undefined)?.[key]
    const value = key === 'FNumber'
      ? formatAperture(rawValue)
      : key === 'ExposureTime'
        ? formatExposure(rawValue)
        : toMetadataValue(rawValue)

    if (!value) {
      continue
    }
    entries.push({ label, value })
  }

  return {
    imagePath,
    entries
  }
}

async function listDirectory(targetPath: string): Promise<DirectoryListing> {
  const stats = await stat(targetPath)
  if (!stats.isDirectory()) {
    throw new Error(`Path is not a directory: ${targetPath}`)
  }

  const dirents = await readdir(targetPath, { withFileTypes: true })

  const directories: DirectoryEntry[] = []
  const imageCandidates: Array<{ name: string; path: string }> = []

  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) {
      continue
    }

    const fullPath = path.join(targetPath, dirent.name)

    if (dirent.isDirectory()) {
      directories.push({
        name: dirent.name,
        path: fullPath
      })
      continue
    }

    if (!dirent.isFile()) {
      continue
    }

    const ext = path.extname(dirent.name).toLowerCase()
    if (!IMAGE_EXTENSIONS.has(ext)) {
      continue
    }

    imageCandidates.push({
      name: dirent.name,
      path: fullPath,
    })
  }

  const images = (
    await Promise.all(
      imageCandidates.map(async (candidate): Promise<ImageEntry | null> => {
        try {
          const fileStats = await stat(candidate.path)
          return {
            name: candidate.name,
            path: candidate.path,
            size: fileStats.size,
            modifiedAtMs: fileStats.mtimeMs
          }
        } catch {
          return null
        }
      })
    )
  ).filter((entry): entry is ImageEntry => Boolean(entry))

  directories.sort((a, b) => a.name.localeCompare(b.name))
  images.sort((a, b) => a.name.localeCompare(b.name))

  return {
    path: targetPath,
    name: path.basename(targetPath),
    directories,
    images
  }
}

ipcMain.handle('dialog:selectRoot', async () => {
  const window = BrowserWindow.getFocusedWindow() ?? mainWindow
  const options: OpenDialogOptions = { properties: ['openDirectory'] }
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  return result.filePaths[0]
})

ipcMain.handle('dialog:selectDestination', async () => {
  const window = BrowserWindow.getFocusedWindow() ?? mainWindow
  const options: OpenDialogOptions = { properties: ['openDirectory'] }
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  return result.filePaths[0]
})

ipcMain.handle('fs:listDirectory', async (_event, targetPath: string) => {
  return listDirectory(targetPath)
})

ipcMain.handle('fs:pathExists', async (_event, targetPath: string) => {
  try {
    const stats = await stat(targetPath)
    return stats.isDirectory()
  } catch {
    return false
  }
})

ipcMain.handle('fs:copyFilesToDirectory', async (_event, sourcePaths: string[], destinationDirectory: string) => {
  const destinationStats = await stat(destinationDirectory)
  if (!destinationStats.isDirectory()) {
    throw new Error(`Destination is not a directory: ${destinationDirectory}`)
  }

  let copied = 0
  let skipped = 0
  const failed: Array<{ path: string; reason: string }> = []

  for (const sourcePath of sourcePaths) {
    const destinationPath = path.join(destinationDirectory, path.basename(sourcePath))

    try {
      await access(destinationPath)
      skipped += 1
      continue
    } catch {
      // destination does not exist, continue copy flow
    }

    try {
      await copyFile(sourcePath, destinationPath)
      copied += 1
    } catch (error) {
      failed.push({
        path: sourcePath,
        reason: error instanceof Error ? error.message : 'Unknown copy error'
      })
    }
  }

  return {
    copied,
    skipped,
    failed
  }
})

ipcMain.handle('fs:getImageMetadata', async (_event, imagePath: string) => {
  return getImageMetadata(imagePath)
})

app.whenReady().then(() => {
  registerImageProtocol()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
