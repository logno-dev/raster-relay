import { contextBridge, ipcRenderer } from 'electron'
import type { GalleryApi } from '../shared/contracts'

const api: GalleryApi = {
  selectRootDirectory: () => ipcRenderer.invoke('dialog:selectRoot'),
  selectDestinationDirectory: () => ipcRenderer.invoke('dialog:selectDestination'),
  listDirectory: (targetPath: string) => ipcRenderer.invoke('fs:listDirectory', targetPath),
  pathExists: (targetPath: string) => ipcRenderer.invoke('fs:pathExists', targetPath),
  copyFilesToDirectory: (sourcePaths: string[], destinationDirectory: string) =>
    ipcRenderer.invoke('fs:copyFilesToDirectory', sourcePaths, destinationDirectory),
  getImageMetadata: (imagePath: string) => ipcRenderer.invoke('fs:getImageMetadata', imagePath)
}

contextBridge.exposeInMainWorld('galleryApi', api)
