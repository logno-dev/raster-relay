/// <reference types="vite/client" />

import type { GalleryApi } from '../../shared/contracts'

declare global {
  interface Window {
    galleryApi: GalleryApi
  }
}

export {}
