/** Check that source CLI supervision preserves Bun runtime options. */
import process from "node:process";
console.error("supervisor preload:", process.pid);
