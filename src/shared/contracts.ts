export interface DirectoryEntry {
  name: string
  path: string
}

export interface ImageEntry {
  name: string
  path: string
  size: number
  modifiedAtMs: number
}

export interface DirectoryListing {
  path: string
  name: string
  directories: DirectoryEntry[]
  images: ImageEntry[]
}

export interface CopyMarkedFilesResult {
  copied: number
  skipped: number
  failed: Array<{
    path: string
    reason: string
  }>
}

export interface ImageMetadataEntry {
  label: string
  value: string
}

export interface ImageMetadata {
  imagePath: string
  entries: ImageMetadataEntry[]
}

export interface GalleryApi {
  selectRootDirectory: () => Promise<string | null>
  selectDestinationDirectory: () => Promise<string | null>
  listDirectory: (targetPath: string) => Promise<DirectoryListing>
  pathExists: (targetPath: string) => Promise<boolean>
  copyFilesToDirectory: (sourcePaths: string[], destinationDirectory: string) => Promise<CopyMarkedFilesResult>
  getImageMetadata: (imagePath: string) => Promise<ImageMetadata>
}
