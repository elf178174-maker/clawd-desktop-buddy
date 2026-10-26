import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // sherpa-onnx-node (a native module) is a runtime dependency and stays external.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          brain: resolve('src/brain/index.ts'),
          voice: resolve('src/voice/index.ts'),
        },
        external: ['bufferutil', 'utf-8-validate'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts') } } },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    build: {
      chunkSizeWarningLimit: 4000,
      rollupOptions: {
        input: {
          overlay: resolve('src/renderer/overlay/index.html'),
          panel: resolve('src/renderer/panel/index.html'),
          settings: resolve('src/renderer/settings/index.html'),
          audio: resolve('src/renderer/audio/index.html'),
        },
      },
    },
  },
})
