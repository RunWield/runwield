/** The caller's incoming and outgoing ACP byte streams. */
export interface AcpTransport {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
}
