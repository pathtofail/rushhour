// Vite config — single-file game (`index.html` carries all JS inline).
// We just need a dev server with sane defaults.
export default {
  server: {
    port: 5173,
    strictPort: false,   // pick a free port if 5173 is taken
    open: false,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
};
