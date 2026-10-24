/** UTF-8 byte paging shared by diff inspection and action artifact reads. */
export interface TextPageOptions {
    offsetBytes?: number;
    maxBytes?: number;
}

export function readTextPage(text: string, options: TextPageOptions = {}) {
    const fullBytes = new TextEncoder().encode(text);
    const offsetBytes = Math.min(options.offsetBytes || 0, fullBytes.byteLength);
    const maxBytes = options.maxBytes || 64 * 1024;
    let start = offsetBytes;
    while (start > 0 && (fullBytes[start] & 0xc0) === 0x80) start -= 1;
    let end = Math.min(fullBytes.byteLength, start + maxBytes);
    while (end > start && end < fullBytes.byteLength && (fullBytes[end] & 0xc0) === 0x80) end -= 1;
    if (end === start && end < fullBytes.byteLength) {
        end = Math.min(fullBytes.byteLength, start + maxBytes);
        while (end < fullBytes.byteLength && (fullBytes[end] & 0xc0) === 0x80) end += 1;
    }
    return {
        content: new TextDecoder().decode(fullBytes.slice(start, end)),
        offsetBytes: start,
        nextOffsetBytes: end,
        truncated: end < fullBytes.byteLength,
        remainingBytes: Math.max(0, fullBytes.byteLength - end),
    };
}
