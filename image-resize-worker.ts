// Deno's compile --bundle relocates Pi's import.meta.url to the bundle root.
// Load the original worker without rebundling it: Photon needs its own
// module directory to locate photon_rs_bg.wasm.
// Construct the path at runtime so Deno does not bundle this target again.
const workerPath = ["node_modules", "@earendil-works", "pi-coding-agent", "dist", "utils", "image-resize-worker.js"];
const workerUrl = new URL(workerPath.join("/"), import.meta.url);
await import(workerUrl.href);
