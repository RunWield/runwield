// Pi's Bun executable lookup expects this exact entrypoint path. Bundle its real
// worker; the compiler embeds Photon's WASM in both the CLI and worker graphs.
import "../../node_modules/@earendil-works/pi-coding-agent/dist/utils/image-resize-worker.js";
