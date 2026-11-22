export const MAX_PASSWORD_BYTES = 72;

export function isWithinPasswordByteLimit(value) {
    return typeof value === "string" &&
        new TextEncoder().encode(value).length <= MAX_PASSWORD_BYTES;
}
