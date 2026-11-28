const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export function encodeBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array {
    if (typeof value !== "string") throw new Error("base64url value must be a string");
    if (!BASE64URL_PATTERN.test(value)) throw new Error("base64url value contains invalid characters");
    const remainder = value.length % 4;
    if (remainder === 1) throw new Error("base64url value has invalid length");
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - remainder) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

export function encodeUtf8Base64Url(value: string): string {
    return encodeBase64Url(TEXT_ENCODER.encode(value));
}

export function decodeUtf8Base64Url(value: string): string {
    return TEXT_DECODER.decode(decodeBase64Url(value));
}
