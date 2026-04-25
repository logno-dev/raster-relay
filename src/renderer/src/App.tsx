import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { ChevronLeft, ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import type { DirectoryEntry, DirectoryListing, ImageMetadata } from '../../shared/contracts'

const PRELOAD_RADIUS = 4
const SAVED_ROOTS_KEY = 'gallery.savedRoots'
const ACTIVE_ROOT_KEY = 'gallery.activeRoot'

type TransitionType = 'none' | 'fade'

type SlideshowSettings = {
  imageDurationMs: number
  transitionType: TransitionType
  transitionDurationMs: number
  shuffle: boolean
  loop: boolean
  enterFullscreen: boolean
}

type NodeState = {
  loading: boolean
  children: DirectoryEntry[]
}

const EMPTY_IMAGES: ReadonlyArray<DirectoryListing['images'][number]> = []

function toFileUrl(filePath: string): string {
  if (window.location.protocol === 'file:') {
    const normalizedPath = filePath.replace(/\\/g, '/')
    return encodeURI(`file://${normalizedPath.startsWith('/') ? '' : '/'}${normalizedPath}`)
  }

  return `gallery-image://image?path=${encodeURIComponent(filePath)}`
}

function getFolderName(targetPath: string): string {
  const parts = targetPath.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? targetPath
}

function parseSavedRoots(rawValue: string | null): string[] {
  if (!rawValue) {
    return []
  }

  try {
    const parsed = JSON.parse(rawValue)
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  } catch {
    return []
  }
}

function buildSlideshowOrder(total: number, startIndex: number, shuffle: boolean): number[] {
  const base = Array.from({ length: total }, (_, index) => index)
  if (!shuffle) {
    return base
  }

  for (let index = base.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    const temp = base[index]
    base[index] = base[swapIndex]
    base[swapIndex] = temp
  }

  const startPosition = Math.max(0, base.indexOf(startIndex))
  return [...base.slice(startPosition), ...base.slice(0, startPosition)]
}

function App() {
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false)
  const [savedRoots, setSavedRoots] = useState<string[]>([])
  const [activeRootPath, setActiveRootPath] = useState<string | null>(null)
  const [selectedDirectory, setSelectedDirectory] = useState<string | null>(null)
  const [activeListing, setActiveListing] = useState<DirectoryListing | null>(null)
  const [nodes, setNodes] = useState<Record<string, NodeState>>({})
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({})
  const [activeIndex, setActiveIndex] = useState(0)
  const [imageReady, setImageReady] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [hideCursor, setHideCursor] = useState(false)
  const [isExifPanelOpen, setIsExifPanelOpen] = useState(false)
  const [metadataLoading, setMetadataLoading] = useState(false)
  const [activeMetadata, setActiveMetadata] = useState<ImageMetadata | null>(null)
  const [markedImagePaths, setMarkedImagePaths] = useState<string[]>([])
  const [isActionTrayOpen, setIsActionTrayOpen] = useState(false)
  const [isCopyingMarked, setIsCopyingMarked] = useState(false)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [isSlideshowSettingsOpen, setIsSlideshowSettingsOpen] = useState(false)
  const [isSlideshowActive, setIsSlideshowActive] = useState(false)
  const [slideshowOrder, setSlideshowOrder] = useState<number[]>([])
  const [slideshowCursor, setSlideshowCursor] = useState(0)
  const [slideshowRequestedFullscreen, setSlideshowRequestedFullscreen] = useState(false)
  const [slideshowWasFullscreen, setSlideshowWasFullscreen] = useState(false)
  const [showSlideshowStopButton, setShowSlideshowStopButton] = useState(true)
  const [slideshowTransition, setSlideshowTransition] = useState<{
    fromPath: string
    toPath: string
    phase: 'idle' | 'running'
  } | null>(null)
  const [slideshowSettings, setSlideshowSettings] = useState<SlideshowSettings>({
    imageDurationMs: 3500,
    transitionType: 'fade',
    transitionDurationMs: 1000,
    shuffle: false,
    loop: true,
    enterFullscreen: true
  })
  const [zoomLevel, setZoomLevel] = useState(1)
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 })
  const [isPanningImage, setIsPanningImage] = useState(false)
  const preloadCache = useRef<Set<string>>(new Set())
  const metadataCache = useRef<Map<string, ImageMetadata>>(new Map())
  const thumbStripRef = useRef<HTMLElement | null>(null)
  const imageWrapRef = useRef<HTMLDivElement | null>(null)
  const lastPointerRef = useRef<{ x: number; y: number; id: number } | null>(null)
  const slideshowTransitionTimerRef = useRef<number | null>(null)
  const slideshowTransitionFrameRef = useRef<number | null>(null)

  const images = activeListing?.images ?? EMPTY_IMAGES
  const hasImages = images.length > 0
  const activeImage = hasImages ? images[activeIndex] : null
  const markedPathSet = useMemo(() => new Set(markedImagePaths), [markedImagePaths])
  const markedCount = markedImagePaths.length
  const activeImageMarked = activeImage ? markedPathSet.has(activeImage.path) : false
  const isZoomed = zoomLevel > 1.001
  const isPresentationMode = isFullscreen || isSlideshowActive
  const transitionMs = slideshowSettings.transitionType === 'none' ? 0 : slideshowSettings.transitionDurationMs
  const activeImageStyle: CSSProperties = {
    transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomLevel})`
  }
  const transitionImageStyle: CSSProperties & Record<'--rr-transition-ms', string> = {
    '--rr-transition-ms': `${transitionMs}ms`
  }
  const fullscreenMetadataEntries = useMemo(() => {
    if (!activeMetadata) {
      return []
    }

    const priority = new Set([
      'File Name',
      'Camera',
      'Lens',
      'Shot Time',
      'Exposure',
      'Aperture',
      'ISO',
      'Focal Length',
      'Width',
      'Height'
    ])

    const prioritized = activeMetadata.entries.filter((entry) => priority.has(entry.label))
    return prioritized.slice(0, 10)
  }, [activeMetadata])

  function scheduleSlideshowTransition(fromPath: string, toPath: string): void {
    if (slideshowSettings.transitionType === 'none' || transitionMs <= 0 || fromPath === toPath) {
      setSlideshowTransition(null)
      return
    }

    if (slideshowTransitionTimerRef.current) {
      window.clearTimeout(slideshowTransitionTimerRef.current)
      slideshowTransitionTimerRef.current = null
    }
    if (slideshowTransitionFrameRef.current) {
      window.cancelAnimationFrame(slideshowTransitionFrameRef.current)
      slideshowTransitionFrameRef.current = null
    }

    setSlideshowTransition({ fromPath, toPath, phase: 'idle' })

    slideshowTransitionFrameRef.current = window.requestAnimationFrame(() => {
      setSlideshowTransition((previous) => {
        if (!previous || previous.toPath !== toPath) {
          return previous
        }
        return { ...previous, phase: 'running' }
      })
    })

    slideshowTransitionTimerRef.current = window.setTimeout(() => {
      setSlideshowTransition((previous) => {
        if (!previous || previous.toPath !== toPath) {
          return previous
        }
        return null
      })
      slideshowTransitionTimerRef.current = null
    }, transitionMs)
  }

  const currentPathLabel = useMemo(() => {
    if (!activeListing) {
      return 'No folder selected'
    }
    return activeListing.path
  }, [activeListing])

  function persistRoots(nextRoots: string[]): void {
    setSavedRoots(nextRoots)
    localStorage.setItem(SAVED_ROOTS_KEY, JSON.stringify(nextRoots))
  }

  function persistActiveRoot(nextRoot: string | null): void {
    setActiveRootPath(nextRoot)
    if (nextRoot) {
      localStorage.setItem(ACTIVE_ROOT_KEY, nextRoot)
    } else {
      localStorage.removeItem(ACTIVE_ROOT_KEY)
    }
  }

  function resetActiveSelection(): void {
    setActiveListing(null)
    setSelectedDirectory(null)
    setActiveIndex(0)
    setImageReady(false)
  }

  useEffect(() => {
    const onFullscreenChanged = () => {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }
    document.addEventListener('fullscreenchange', onFullscreenChanged)
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChanged)
    }
  }, [])

  useEffect(() => {
    if (!isPresentationMode) {
      setHideCursor(false)
      return
    }

    let timeoutId: number | null = null

    const bumpCursor = () => {
      setHideCursor(false)
      if (timeoutId) {
        window.clearTimeout(timeoutId)
      }
      timeoutId = window.setTimeout(() => {
        setHideCursor(true)
      }, 1200)
    }

    bumpCursor()
    window.addEventListener('pointermove', bumpCursor)
    window.addEventListener('mousedown', bumpCursor)
    window.addEventListener('touchstart', bumpCursor)

    return () => {
      if (timeoutId) {
        window.clearTimeout(timeoutId)
      }
      window.removeEventListener('pointermove', bumpCursor)
      window.removeEventListener('mousedown', bumpCursor)
      window.removeEventListener('touchstart', bumpCursor)
    }
  }, [isPresentationMode])

  useEffect(() => {
    const activePaths = new Set(images.map((image) => image.path))
    setMarkedImagePaths((prev) => {
      const next = prev.filter((path) => activePaths.has(path))
      if (next.length === prev.length && next.every((value, index) => value === prev[index])) {
        return prev
      }
      return next
    })
  }, [images])

  useEffect(() => {
    setZoomLevel(1)
    setPanOffset({ x: 0, y: 0 })
    setIsPanningImage(false)
    lastPointerRef.current = null
  }, [activeImage?.path])

  useEffect(() => {
    return () => {
      if (slideshowTransitionTimerRef.current) {
        window.clearTimeout(slideshowTransitionTimerRef.current)
        slideshowTransitionTimerRef.current = null
      }
      if (slideshowTransitionFrameRef.current) {
        window.cancelAnimationFrame(slideshowTransitionFrameRef.current)
        slideshowTransitionFrameRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    void (async () => {
      const saved = parseSavedRoots(localStorage.getItem(SAVED_ROOTS_KEY))

      const checks = await Promise.all(saved.map((entry) => window.galleryApi.pathExists(entry)))
      const validRoots = saved.filter((entry, index) => checks[index])
      persistRoots(validRoots)

      if (validRoots.length === 0) {
        persistActiveRoot(null)
        return
      }

      const storedActiveRoot = localStorage.getItem(ACTIVE_ROOT_KEY)
      const initialRoot = storedActiveRoot && validRoots.includes(storedActiveRoot) ? storedActiveRoot : validRoots[0]
      persistActiveRoot(initialRoot)
      setExpandedPaths((prev) => ({ ...prev, [initialRoot]: true }))

      try {
        await loadDirectory(initialRoot)
      } catch {
        const fallbackRoots = validRoots.filter((entry) => entry !== initialRoot)
        persistRoots(fallbackRoots)
        const fallback = fallbackRoots[0] ?? null
        persistActiveRoot(fallback)
        if (fallback) {
          setExpandedPaths((prev) => ({ ...prev, [fallback]: true }))
          await loadDirectory(fallback)
        } else {
          resetActiveSelection()
        }
      }
    })()
  }, [])

  useEffect(() => {
    if (!activeImage) {
      setActiveMetadata(null)
      return
    }

    const indices: number[] = []
    for (let offset = -PRELOAD_RADIUS; offset <= PRELOAD_RADIUS; offset += 1) {
      const candidate = activeIndex + offset
      if (candidate < 0 || candidate >= images.length || candidate === activeIndex) {
        continue
      }
      indices.push(candidate)
    }

    for (const index of indices) {
      const path = images[index].path
      if (preloadCache.current.has(path)) {
        continue
      }

      const img = new Image()
      img.src = toFileUrl(path)
      preloadCache.current.add(path)
    }
  }, [activeImage, activeIndex, images])

  useEffect(() => {
    if (!activeImage) {
      setActiveMetadata(null)
      setMetadataLoading(false)
      return
    }

    if (!isExifPanelOpen) {
      setMetadataLoading(false)
      return
    }

    const cached = metadataCache.current.get(activeImage.path)
    if (cached) {
      setActiveMetadata(cached)
      setMetadataLoading(false)
      return
    }

    let cancelled = false
    setMetadataLoading(true)

    void window.galleryApi.getImageMetadata(activeImage.path)
      .then((metadata) => {
        if (!cancelled) {
          metadataCache.current.set(activeImage.path, metadata)
          setActiveMetadata(metadata)
        }
      })
      .catch(() => {
        if (!cancelled) {
          const fallback = {
            imagePath: activeImage.path,
            entries: []
          }
          metadataCache.current.set(activeImage.path, fallback)
          setActiveMetadata(fallback)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setMetadataLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [activeImage?.path, isExifPanelOpen])

  useEffect(() => {
    if (!isSlideshowActive || slideshowOrder.length === 0) {
      return
    }

    const timer = window.setTimeout(() => {
      setSlideshowCursor((previousCursor) => {
        const nextCursor = previousCursor + 1

        if (nextCursor >= slideshowOrder.length) {
          if (!slideshowSettings.loop) {
            setIsSlideshowActive(false)
            return previousCursor
          }
          return 0
        }

        return nextCursor
      })
    }, Math.max(500, slideshowSettings.imageDurationMs))

    return () => {
      window.clearTimeout(timer)
    }
  }, [isSlideshowActive, slideshowOrder, slideshowCursor, slideshowSettings.imageDurationMs, slideshowSettings.loop])

  useEffect(() => {
    if (!isSlideshowActive || slideshowOrder.length === 0) {
      return
    }

    const targetIndex = slideshowOrder[Math.min(slideshowCursor, slideshowOrder.length - 1)]
    if (typeof targetIndex !== 'number' || targetIndex === activeIndex) {
      return
    }

    const fromPath = images[activeIndex]?.path
    const toPath = images[targetIndex]?.path
    if (fromPath && toPath) {
      scheduleSlideshowTransition(fromPath, toPath)
    }

    setActiveIndex(targetIndex)
    setImageReady(true)
  }, [isSlideshowActive, slideshowCursor, slideshowOrder, activeIndex, images])

  useEffect(() => {
    if (!isSlideshowActive) {
      return
    }

    if (images.length === 0) {
      setIsSlideshowActive(false)
      return
    }

    const order = buildSlideshowOrder(images.length, activeIndex, slideshowSettings.shuffle)
    setSlideshowOrder(order)
    setSlideshowCursor(0)
  }, [images.length, isSlideshowActive, slideshowSettings.shuffle])

  useEffect(() => {
    if (isSlideshowActive || !slideshowRequestedFullscreen) {
      return
    }

    if (!document.fullscreenElement) {
      setSlideshowRequestedFullscreen(false)
      return
    }

    void document.exitFullscreen().finally(() => {
      setSlideshowRequestedFullscreen(false)
    })
  }, [isSlideshowActive, slideshowRequestedFullscreen])

  useEffect(() => {
    if (!isSlideshowActive) {
      setShowSlideshowStopButton(false)
      return
    }

    setShowSlideshowStopButton(true)

    let timeoutId: number | null = window.setTimeout(() => {
      setShowSlideshowStopButton(false)
    }, 1700)

    const bumpOverlayControls = () => {
      setShowSlideshowStopButton(true)
      if (timeoutId) {
        window.clearTimeout(timeoutId)
      }
      timeoutId = window.setTimeout(() => {
        setShowSlideshowStopButton(false)
      }, 1700)
    }

    window.addEventListener('pointermove', bumpOverlayControls)

    return () => {
      if (timeoutId) {
        window.clearTimeout(timeoutId)
      }
      window.removeEventListener('pointermove', bumpOverlayControls)
    }
  }, [isSlideshowActive])

  useEffect(() => {
    if (!isSlideshowActive || !slideshowRequestedFullscreen) {
      return
    }

    if (isFullscreen) {
      if (!slideshowWasFullscreen) {
        setSlideshowWasFullscreen(true)
      }
      return
    }

    if (!slideshowWasFullscreen) {
      return
    }

    setIsSlideshowActive(false)
    setSlideshowRequestedFullscreen(false)
    setSlideshowWasFullscreen(false)
  }, [isSlideshowActive, slideshowRequestedFullscreen, slideshowWasFullscreen, isFullscreen])

  useEffect(() => {
    if (isPresentationMode) {
      return
    }

    const thumbStrip = thumbStripRef.current
    if (!thumbStrip) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      const activeThumb = thumbStrip.querySelector<HTMLButtonElement>(`button[data-thumb-index="${activeIndex}"]`)
      activeThumb?.scrollIntoView({
        behavior: 'auto',
        inline: 'center',
        block: 'nearest'
      })
    })

    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [activeIndex, images.length, isPresentationMode])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null
      const key = event.key.toLowerCase()

      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }

      if (event.key === 'ArrowLeft' || key === 'h') {
        event.preventDefault()
        moveImage(-1)
        return
      }

      if (event.key === 'ArrowRight' || key === 'l') {
        event.preventDefault()
        moveImage(1)
        return
      }

      if (event.key === 'Home' && images.length > 0) {
        event.preventDefault()
        setActiveIndex(0)
        setImageReady(false)
        return
      }

      if (event.key === 'End' && images.length > 0) {
        event.preventDefault()
        setActiveIndex(images.length - 1)
        setImageReady(false)
        return
      }

      if (key === 'f') {
        event.preventDefault()
        void toggleFullscreen()
        return
      }

      if (key === 'e') {
        event.preventDefault()
        setIsExifPanelOpen((prev) => !prev)
        return
      }

      if (key === 'm') {
        event.preventDefault()
        toggleMarkOnActiveImage()
        return
      }

      if (key === 'r') {
        event.preventDefault()
        void refreshCurrentDirectory()
        return
      }

      if (key === '0') {
        event.preventDefault()
        resetZoomPan()
        return
      }

      if (key === 's') {
        event.preventDefault()
        void toggleSlideshow()
        return
      }

      if (key === ' ' && isSlideshowActive) {
        event.preventDefault()
        void toggleSlideshow()
        return
      }

      if (key === 'escape' && isSlideshowActive) {
        event.preventDefault()
        void stopSlideshow()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [images.length, activeImage?.path, isSlideshowActive, slideshowSettings])

  useEffect(() => {
    function onWindowFocus(): void {
      const targetPath = selectedDirectory ?? activeRootPath
      if (!targetPath) {
        return
      }

      void loadDirectory(targetPath, { preserveSelection: true })
    }

    window.addEventListener('focus', onWindowFocus)
    return () => {
      window.removeEventListener('focus', onWindowFocus)
    }
  }, [selectedDirectory, activeRootPath, activeImage?.path, activeIndex])

  async function loadDirectory(targetPath: string, options?: { preserveSelection?: boolean }): Promise<void> {
    const previousActivePath = options?.preserveSelection ? activeImage?.path ?? null : null
    const listing = await window.galleryApi.listDirectory(targetPath)

    let nextActiveIndex = 0
    if (options?.preserveSelection && listing.images.length > 0) {
      const matchedIndex = previousActivePath
        ? listing.images.findIndex((image) => image.path === previousActivePath)
        : -1

      if (matchedIndex >= 0) {
        nextActiveIndex = matchedIndex
      } else {
        nextActiveIndex = Math.min(activeIndex, listing.images.length - 1)
      }
    }

    setActiveListing(listing)
    setSelectedDirectory(targetPath)
    setActiveIndex(nextActiveIndex)
    setImageReady(false)

    setNodes((prev) => ({
      ...prev,
      [targetPath]: {
        loading: false,
        children: listing.directories
      }
    }))
  }

  async function refreshCurrentDirectory(): Promise<void> {
    const targetPath = selectedDirectory ?? activeRootPath
    if (!targetPath) {
      return
    }

    await loadDirectory(targetPath, { preserveSelection: true })
  }

  async function selectRoot(path: string): Promise<void> {
    const exists = await window.galleryApi.pathExists(path)
    if (!exists) {
      const nextRoots = savedRoots.filter((entry) => entry !== path)
      persistRoots(nextRoots)

      if (activeRootPath === path) {
        const fallback = nextRoots[0] ?? null
        persistActiveRoot(fallback)
        if (fallback) {
          setExpandedPaths((prev) => ({ ...prev, [fallback]: true }))
          await loadDirectory(fallback)
        } else {
          resetActiveSelection()
        }
      }

      return
    }

    persistActiveRoot(path)
    setExpandedPaths((prev) => ({ ...prev, [path]: true }))
    await loadDirectory(path)
  }

  async function chooseRootDirectory(): Promise<void> {
    const selectedPath = await window.galleryApi.selectRootDirectory()
    if (!selectedPath) {
      return
    }

    const nextRoots = savedRoots.includes(selectedPath) ? savedRoots : [...savedRoots, selectedPath]
    persistRoots(nextRoots)
    await selectRoot(selectedPath)
  }

  async function removeRoot(path: string): Promise<void> {
    const nextRoots = savedRoots.filter((entry) => entry !== path)
    persistRoots(nextRoots)

    setExpandedPaths((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })
    setNodes((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })

    if (activeRootPath !== path) {
      return
    }

    const fallback = nextRoots[0] ?? null
    persistActiveRoot(fallback)

    if (!fallback) {
      resetActiveSelection()
      return
    }

    setExpandedPaths((prev) => ({ ...prev, [fallback]: true }))
    await loadDirectory(fallback)
  }

  async function toggleExpand(path: string): Promise<void> {
    const currentlyExpanded = Boolean(expandedPaths[path])
    setExpandedPaths((prev) => ({
      ...prev,
      [path]: !currentlyExpanded
    }))

    if (currentlyExpanded || nodes[path]) {
      return
    }

    setNodes((prev) => ({
      ...prev,
      [path]: {
        loading: true,
        children: []
      }
    }))

    try {
      const listing = await window.galleryApi.listDirectory(path)
      setNodes((prev) => ({
        ...prev,
        [path]: {
          loading: false,
          children: listing.directories
        }
      }))
    } catch {
      setNodes((prev) => ({
        ...prev,
        [path]: {
          loading: false,
          children: []
        }
      }))
    }
  }

  async function selectDirectory(path: string): Promise<void> {
    await loadDirectory(path)
  }

  function toggleMarkedPath(path: string): void {
    setMarkedImagePaths((prev) => {
      if (prev.includes(path)) {
        return prev.filter((entry) => entry !== path)
      }
      return [...prev, path]
    })
    setActionMessage(null)
  }

  function toggleMarkOnActiveImage(): void {
    if (!activeImage) {
      return
    }

    toggleMarkedPath(activeImage.path)
  }

  function clearMarkedFiles(): void {
    setMarkedImagePaths([])
    setActionMessage(null)
    setIsActionTrayOpen(false)
  }

  async function copyMarkedFiles(): Promise<void> {
    if (markedCount === 0 || isCopyingMarked) {
      return
    }

    setIsCopyingMarked(true)
    setActionMessage(null)

    try {
      const destinationDirectory = await window.galleryApi.selectDestinationDirectory()
      if (!destinationDirectory) {
        setActionMessage('Copy cancelled.')
        return
      }

      const result = await window.galleryApi.copyFilesToDirectory(markedImagePaths, destinationDirectory)
      const parts = [`Copied ${result.copied}.`, `Skipped ${result.skipped} (already exists).`]
      if (result.failed.length > 0) {
        parts.push(`Failed ${result.failed.length}.`)
      }
      setActionMessage(parts.join(' '))
    } catch {
      setActionMessage('Copy failed. Please try again.')
    } finally {
      setIsCopyingMarked(false)
    }
  }

  function moveImage(step: number): void {
    if (!hasImages) {
      return
    }
    setActiveIndex((prev) => {
      const next = prev + step
      if (next < 0 || next >= images.length) {
        return prev
      }
      return next
    })
    setImageReady(false)
  }

  async function startSlideshow(): Promise<void> {
    if (images.length === 0) {
      return
    }

    const order = buildSlideshowOrder(images.length, activeIndex, slideshowSettings.shuffle)
    setSlideshowOrder(order)
    setSlideshowCursor(0)
    setIsSlideshowActive(true)
    setImageReady(true)
    setSlideshowWasFullscreen(false)
    setIsSlideshowSettingsOpen(false)

    if (slideshowSettings.enterFullscreen && !document.fullscreenElement) {
      try {
        await document.documentElement.requestFullscreen()
        setSlideshowRequestedFullscreen(true)
      } catch {
        setSlideshowRequestedFullscreen(false)
      }
    }
  }

  async function stopSlideshow(): Promise<void> {
    setIsSlideshowActive(false)
    setSlideshowWasFullscreen(false)
    setSlideshowTransition(null)
    if (slideshowTransitionTimerRef.current) {
      window.clearTimeout(slideshowTransitionTimerRef.current)
      slideshowTransitionTimerRef.current = null
    }
    if (slideshowTransitionFrameRef.current) {
      window.cancelAnimationFrame(slideshowTransitionFrameRef.current)
      slideshowTransitionFrameRef.current = null
    }
    if (slideshowRequestedFullscreen && document.fullscreenElement) {
      try {
        await document.exitFullscreen()
      } catch {
        // ignore fullscreen exit errors
      }
    }
    setSlideshowRequestedFullscreen(false)
  }

  async function toggleSlideshow(): Promise<void> {
    if (isSlideshowActive) {
      await stopSlideshow()
      return
    }

    await startSlideshow()
  }

  function markImageReady(): void {
    window.requestAnimationFrame(() => {
      setImageReady(true)
    })
  }

  function resetZoomPan(): void {
    setZoomLevel(1)
    setPanOffset({ x: 0, y: 0 })
    setIsPanningImage(false)
    lastPointerRef.current = null
  }

  function handleImageWheel(event: ReactWheelEvent<HTMLDivElement>): void {
    if (!activeImage) {
      return
    }

    event.preventDefault()

    const wrap = imageWrapRef.current
    if (!wrap) {
      return
    }

    const rect = wrap.getBoundingClientRect()
    const cursorX = event.clientX - rect.left - rect.width / 2
    const cursorY = event.clientY - rect.top - rect.height / 2
    const delta = -event.deltaY * 0.0015

    setZoomLevel((previousZoom) => {
      const nextZoom = Math.max(1, Math.min(6, previousZoom * (1 + delta)))

      setPanOffset((previousPan) => {
        if (nextZoom <= 1.001) {
          return { x: 0, y: 0 }
        }
        return {
          x: previousPan.x + cursorX * (1 / nextZoom - 1 / previousZoom),
          y: previousPan.y + cursorY * (1 / nextZoom - 1 / previousZoom)
        }
      })

      return nextZoom
    })
  }

  function handleImagePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!isZoomed || event.button !== 0) {
      return
    }

    event.preventDefault()
    setIsPanningImage(true)
    lastPointerRef.current = { x: event.clientX, y: event.clientY, id: event.pointerId }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handleImagePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!isPanningImage || !lastPointerRef.current || event.pointerId !== lastPointerRef.current.id) {
      return
    }

    const deltaX = event.clientX - lastPointerRef.current.x
    const deltaY = event.clientY - lastPointerRef.current.y
    lastPointerRef.current = { x: event.clientX, y: event.clientY, id: event.pointerId }

    setPanOffset((previousPan) => ({
      x: previousPan.x + deltaX / zoomLevel,
      y: previousPan.y + deltaY / zoomLevel
    }))
  }

  function handleImagePointerEnd(event: ReactPointerEvent<HTMLDivElement>): void {
    if (lastPointerRef.current?.id !== event.pointerId) {
      return
    }

    setIsPanningImage(false)
    lastPointerRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function handleImageDoubleClick(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    if (zoomLevel > 1.001) {
      resetZoomPan()
      return
    }

    const wrap = imageWrapRef.current
    if (!wrap) {
      setZoomLevel(2)
      setPanOffset({ x: 0, y: 0 })
      return
    }

    const rect = wrap.getBoundingClientRect()
    const cursorX = event.clientX - rect.left - rect.width / 2
    const cursorY = event.clientY - rect.top - rect.height / 2
    const nextZoom = 2

    setZoomLevel((previousZoom) => {
      setPanOffset((previousPan) => ({
        x: previousPan.x + cursorX * (1 / nextZoom - 1 / previousZoom),
        y: previousPan.y + cursorY * (1 / nextZoom - 1 / previousZoom)
      }))
      return nextZoom
    })
  }

  async function toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) {
      await document.exitFullscreen()
    } else {
      await document.documentElement.requestFullscreen()
    }
  }

  function renderTree(path: string, depth: number): JSX.Element {
    const node = nodes[path]
    const children = node?.children ?? []

    return (
      <div className="tree-children">
        {children.map((child) => {
          const isExpanded = Boolean(expandedPaths[child.path])
          const isSelected = selectedDirectory === child.path
          const childNode = nodes[child.path]
          const hasKnownChildren = (childNode?.children?.length ?? 0) > 0

          return (
            <div key={child.path}>
              <div className={`tree-row ${isSelected ? 'selected' : ''}`} style={{ paddingLeft: `${depth * 12 + 16}px` }}>
                <button className="tree-toggle" onClick={() => void toggleExpand(child.path)}>
                  {isExpanded ? '▾' : '▸'}
                </button>
                <button className="tree-label" onClick={() => void selectDirectory(child.path)} title={child.path}>
                  {child.name}
                </button>
              </div>

              {isExpanded && childNode?.loading && <div className="tree-loading">Loading folders...</div>}

              {isExpanded && (hasKnownChildren || childNode?.loading) && renderTree(child.path, depth + 1)}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className={`app-shell ${leftPanelCollapsed ? 'panel-hidden' : ''} ${isExifPanelOpen ? 'exif-open' : ''} ${isPresentationMode ? 'fullscreen' : ''}`}>
      {!isPresentationMode && !leftPanelCollapsed && (
        <aside className="left-panel">
          <div className="panel-header">
            <button className="primary-button" onClick={() => void chooseRootDirectory()}>
              Add Folder
            </button>
          </div>

          <div className="saved-roots">
            <div className="section-title">Saved Folders</div>
            {savedRoots.length === 0 && <p className="hint-text">No saved folders yet.</p>}

            {savedRoots.map((root) => (
              <div key={root} className="saved-root-row">
                <button
                  className={`saved-root-label ${activeRootPath === root ? 'active' : ''}`}
                  title={root}
                  onClick={() => void selectRoot(root)}
                >
                  {getFolderName(root)}
                </button>
                <button className="remove-root-button" title="Remove folder" onClick={() => void removeRoot(root)}>
                  ✕
                </button>
              </div>
            ))}
          </div>

          {activeRootPath && (
            <div className="tree-wrapper">
              <div className={`tree-row ${selectedDirectory === activeRootPath ? 'selected' : ''}`}>
                <button className="tree-toggle" onClick={() => void toggleExpand(activeRootPath)}>
                  {expandedPaths[activeRootPath] ? '▾' : '▸'}
                </button>
                <button className="tree-label" onClick={() => void selectDirectory(activeRootPath)} title={activeRootPath}>
                  {getFolderName(activeRootPath)}
                </button>
              </div>
              {expandedPaths[activeRootPath] && renderTree(activeRootPath, 1)}
            </div>
          )}
        </aside>
      )}

      {!isPresentationMode && (
        <div className={`side-tab-rail ${leftPanelCollapsed ? 'collapsed' : 'open'}`}>
          <button
            className={`side-tab-button ${leftPanelCollapsed ? 'collapsed' : 'open'}`}
            aria-label={leftPanelCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setLeftPanelCollapsed((prev) => !prev)}
          >
            {leftPanelCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>
      )}

      <main className={`main-stage ${isPresentationMode ? 'fullscreen' : ''}`}>
        {!isPresentationMode && (
          <header className="toolbar">
            <div className="path-chip" title={currentPathLabel}>
              {currentPathLabel}
            </div>
            <div className="toolbar-actions">
              <button className="ghost-button" onClick={() => void refreshCurrentDirectory()}>
                Refresh (R)
              </button>
              <button className="ghost-button" onClick={toggleMarkOnActiveImage} disabled={!activeImage}>
                {activeImageMarked ? 'Unmark (M)' : 'Mark (M)'}
              </button>
              <button className="ghost-button" onClick={() => void toggleFullscreen()}>
                {isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
              </button>
              <button className="ghost-button" onClick={() => setIsSlideshowSettingsOpen((prev) => !prev)}>
                Slideshow
              </button>
            </div>
          </header>
        )}

        {!isPresentationMode && isSlideshowSettingsOpen && (
          <div className="slideshow-popover">
            <div className="slideshow-title">Slideshow Settings</div>
            <label className="slideshow-field">
              <span>Image Duration (seconds)</span>
              <input
                type="number"
                min={0.5}
                max={60}
                step={0.1}
                value={(slideshowSettings.imageDurationMs / 1000).toFixed(1)}
                onChange={(event) => {
                  const seconds = Math.max(0.5, Math.min(60, Number(event.target.value) || 0.5))
                  setSlideshowSettings((prev) => ({ ...prev, imageDurationMs: Math.round(seconds * 1000) }))
                }}
              />
            </label>
            <label className="slideshow-field">
              <span>Transition Type</span>
              <select
                value={slideshowSettings.transitionType}
                onChange={(event) => {
                  setSlideshowSettings((prev) => ({ ...prev, transitionType: event.target.value as TransitionType }))
                }}
              >
                <option value="fade">Fade</option>
                <option value="none">None</option>
              </select>
            </label>
            <label className="slideshow-field">
              <span>Transition Duration (seconds)</span>
              <input
                type="number"
                min={0}
                max={3}
                step={0.05}
                value={(slideshowSettings.transitionDurationMs / 1000).toFixed(2)}
                onChange={(event) => {
                  const seconds = Math.max(0, Math.min(3, Number(event.target.value) || 0))
                  setSlideshowSettings((prev) => ({ ...prev, transitionDurationMs: Math.round(seconds * 1000) }))
                }}
              />
            </label>
            <label className="slideshow-check">
              <input
                type="checkbox"
                checked={slideshowSettings.shuffle}
                onChange={(event) => {
                  setSlideshowSettings((prev) => ({ ...prev, shuffle: event.target.checked }))
                }}
              />
              <span>Shuffle</span>
            </label>
            <label className="slideshow-check">
              <input
                type="checkbox"
                checked={slideshowSettings.loop}
                onChange={(event) => {
                  setSlideshowSettings((prev) => ({ ...prev, loop: event.target.checked }))
                }}
              />
              <span>Loop</span>
            </label>
            <label className="slideshow-check">
              <input
                type="checkbox"
                checked={slideshowSettings.enterFullscreen}
                onChange={(event) => {
                  setSlideshowSettings((prev) => ({ ...prev, enterFullscreen: event.target.checked }))
                }}
              />
              <span>Enter native fullscreen</span>
            </label>
            <div className="slideshow-actions">
              <button className="ghost-button" onClick={() => setIsSlideshowSettingsOpen(false)}>
                Close
              </button>
              <button className="primary-button" onClick={() => void startSlideshow()}>
                Start (S)
              </button>
            </div>
          </div>
        )}

        <section className={`viewer-stage ${isPresentationMode ? 'fullscreen' : ''} ${isPresentationMode && hideCursor ? 'cursor-hidden' : ''}`}>
          {!hasImages && <div className="empty-state">No images in this folder yet. Pick another directory.</div>}

          {hasImages && activeImage && (
            <>
              {isPresentationMode ? (
                <button className="fullscreen-nav-zone left" onClick={() => moveImage(-1)} disabled={activeIndex === 0}>
                  <span className="fullscreen-nav-icon">
                    <ChevronLeft size={66} strokeWidth={1.8} />
                  </span>
                </button>
              ) : (
                <button className="nav-button left" onClick={() => moveImage(-1)} disabled={activeIndex === 0}>
                  <ChevronLeft size={26} strokeWidth={2.25} />
                </button>
              )}

              <div
                ref={imageWrapRef}
                className={`image-wrap ${isZoomed ? 'zoomed' : ''} ${isPanningImage ? 'panning' : ''}`}
                onWheel={handleImageWheel}
                onPointerDown={handleImagePointerDown}
                onPointerMove={handleImagePointerMove}
                onPointerUp={handleImagePointerEnd}
                onPointerCancel={handleImagePointerEnd}
                onDoubleClick={handleImageDoubleClick}
              >
                {!imageReady && !isSlideshowActive && <div className="spinner">Loading image...</div>}
                {isSlideshowActive && slideshowTransition && slideshowTransition.toPath === activeImage.path ? (
                  <>
                <img
                      className={`transition-image from ${slideshowSettings.transitionType} ${slideshowTransition.phase}`}
                      src={toFileUrl(slideshowTransition.fromPath)}
                      alt="Previous slide"
                      draggable={false}
                      style={transitionImageStyle}
                    />
                    <img
                      className={`transition-image to ${slideshowSettings.transitionType} ${slideshowTransition.phase}`}
                      src={toFileUrl(slideshowTransition.toPath)}
                      alt={activeImage.name}
                      draggable={false}
                      style={transitionImageStyle}
                    />
                  </>
                ) : (
                  <img
                    key={activeImage.path}
                    className={`active-image ${imageReady ? 'visible' : ''}`}
                    src={toFileUrl(activeImage.path)}
                    alt={activeImage.name}
                  draggable={false}
                  decoding="async"
                  style={activeImageStyle}
                  onLoad={markImageReady}
                  onError={markImageReady}
                />
                )}
                {activeImageMarked && isPresentationMode && <div className="marked-badge-fullscreen" aria-label="Marked image" />}
                {activeImageMarked && !isPresentationMode && <div className="marked-badge">Marked</div>}
                {!isPresentationMode && (
                  <div className="image-caption">
                    {activeImage.name} ({activeIndex + 1}/{images.length})
                  </div>
                )}
              </div>

              {isPresentationMode ? (
                <button className="fullscreen-nav-zone right" onClick={() => moveImage(1)} disabled={activeIndex >= images.length - 1}>
                  <span className="fullscreen-nav-icon">
                    <ChevronRight size={66} strokeWidth={1.8} />
                  </span>
                </button>
              ) : (
                <button className="nav-button right" onClick={() => moveImage(1)} disabled={activeIndex >= images.length - 1}>
                  <ChevronRight size={26} strokeWidth={2.25} />
                </button>
              )}
            </>
          )}
        </section>

        {!isPresentationMode && (
          <footer className="thumb-strip" ref={thumbStripRef}>
            {images.map((image, index) => (
              <button
                key={image.path}
                data-thumb-index={index}
                className={`thumb-button ${index === activeIndex ? 'active' : ''} ${markedPathSet.has(image.path) ? 'marked' : ''}`}
                onClick={() => {
                  setActiveIndex(index)
                  setImageReady(false)
                }}
                title={image.name}
              >
                <img src={toFileUrl(image.path)} alt={image.name} loading="lazy" decoding="async" />
              </button>
            ))}
          </footer>
        )}

        {!isPresentationMode && markedCount > 0 && (
          <div className="marked-actions-anchor">
            <button className="marked-fab" onClick={() => setIsActionTrayOpen((prev) => !prev)}>
              Actions ({markedCount})
            </button>

            {isActionTrayOpen && (
              <div className="marked-tray">
                <div className="marked-tray-title">Marked Files</div>
                <div className="marked-tray-count">{markedCount} selected in this folder.</div>
                <button className="primary-button" onClick={() => void copyMarkedFiles()} disabled={isCopyingMarked}>
                  {isCopyingMarked ? 'Copying...' : 'Copy Marked Files'}
                </button>
                <button className="ghost-button" onClick={clearMarkedFiles}>
                  Clear Marks
                </button>
                {actionMessage && <div className="marked-tray-message">{actionMessage}</div>}
              </div>
            )}
          </div>
        )}

        {isPresentationMode && isExifPanelOpen && (
          <aside className="fullscreen-exif-overlay">
            <div className="right-panel-title">EXIF Data</div>
            {!activeImage && <div className="right-panel-empty">No active image.</div>}
            {activeImage && metadataLoading && <div className="right-panel-empty">Loading metadata...</div>}
            {activeImage && !metadataLoading && fullscreenMetadataEntries.length === 0 && (
              <div className="right-panel-empty">No EXIF metadata available for this image.</div>
            )}
            {fullscreenMetadataEntries.length > 0 && (
              <div className="metadata-list">
                {fullscreenMetadataEntries.map((entry) => (
                  <div key={entry.label} className="metadata-row">
                    <div className="metadata-label">{entry.label}</div>
                    <div className="metadata-value" title={entry.value}>{entry.value}</div>
                  </div>
                ))}
              </div>
            )}
            {isSlideshowActive && <div className="slideshow-overlay-badge">Slideshow</div>}
          </aside>
        )}

        {isSlideshowActive && (
          <button className={`slideshow-stop-overlay ${showSlideshowStopButton ? 'visible' : ''}`} onClick={() => void stopSlideshow()}>
            Stop Slideshow (S)
          </button>
        )}
      </main>

      {!isPresentationMode && (
        <div className="side-tab-rail right">
          <button
            className={`side-tab-button right ${isExifPanelOpen ? 'open' : 'collapsed'}`}
            aria-label={isExifPanelOpen ? 'Collapse EXIF panel' : 'Expand EXIF panel'}
            onClick={() => setIsExifPanelOpen((prev) => !prev)}
          >
            {isExifPanelOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          </button>
        </div>
      )}

      {!isPresentationMode && isExifPanelOpen && (
        <aside className="right-panel">
          <div className="right-panel-title">EXIF Data</div>
          {!activeImage && <div className="right-panel-empty">No active image.</div>}
          {activeImage && metadataLoading && <div className="right-panel-empty">Loading metadata...</div>}
          {activeImage && !metadataLoading && activeMetadata && activeMetadata.entries.length === 0 && (
            <div className="right-panel-empty">No EXIF metadata available for this image.</div>
          )}
          {activeMetadata && activeMetadata.entries.length > 0 && (
            <div className="metadata-list">
              {activeMetadata.entries.map((entry) => (
                <div key={entry.label} className="metadata-row">
                  <div className="metadata-label">{entry.label}</div>
                  <div className="metadata-value" title={entry.value}>{entry.value}</div>
                </div>
              ))}
            </div>
          )}
        </aside>
      )}
    </div>
  )
}

export default App
