# Raster Relay - Implementation Plan

## Objective
Build a desktop Electron application that allows browsing local image directories and viewing images in a focused gallery experience.

## Product Scope

### In Scope (MVP)
- Select a local root directory from the filesystem.
- Navigate nested subdirectories from a collapsible file tree on the left panel.
- Show image thumbnails for the active directory in a horizontal strip at the bottom.
- Display one active image in the main viewing area.
- Support previous/next image traversal within the active directory.
- Preload nearby images (3-5 on each side of the active image) to improve navigation smoothness.
- Show loading indicators only when the active image is not already ready (for example, rapid navigation or random jumps).
- Support fullscreen mode.

### Deferred (Post-MVP)
- Slideshow mode with configurable timing and transitions.

## Functional Requirements
- Directory picker must support selecting an existing local folder.
- Directory navigation must support expanding and collapsing nested folders.
- Active directory selection updates both thumbnail strip and active image context.
- Thumbnail selection updates active image.
- Keyboard or button controls should support sequential navigation.
- Preloading window should target 3-5 images to the left and right of current index.

## Technical Approach
- Use Electron with a local build setup managed by `pnpm`.
- Use a preload script with `contextBridge` and IPC for filesystem-safe operations.
- Keep filesystem access in the Electron main process.
- Build renderer UI with a component-based frontend and local tooling only.

## Quality Expectations
- Smooth sequential image navigation in normal use.
- Clear loading feedback only when image decode/load latency is visible.
- Responsive layout for desktop and smaller window sizes.
- No dependency on third-party build services.

## Milestones
1. Scaffold Electron project with local build scripts and `pnpm`.
2. Implement secure filesystem APIs (directory selection and listing).
3. Implement UI shell (left tree panel, main image stage, thumbnail rail).
4. Add image preloading and loading-state behavior.
5. Add fullscreen support.
6. Prepare slideshow hooks (UI placeholder only) for future implementation.
