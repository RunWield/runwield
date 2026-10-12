// Vite worker-constructor shim for Plannotator's optional Pierre worker-pool import.
// The Workspace surface still uses the real @pierre/diffs and @pierre/diffs/react
// rendering stack; this prevents Astro's Rollup worker build from failing on
// @pierre/diffs/worker/worker.js?worker&inline when no worker pool provider is mounted.

export default class PierreDiffsWorkerShim extends Worker {
    constructor() {
        const source = "self.onmessage = () => {};";
        super(URL.createObjectURL(new Blob([source], { type: "text/javascript" })), { type: "module" });
    }
}
