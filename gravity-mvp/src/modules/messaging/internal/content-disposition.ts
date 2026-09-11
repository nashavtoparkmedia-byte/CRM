/**
 * RFC 6266 / RFC 5987 `Content-Disposition` construction for attachment names.
 *
 * Header values are ByteStrings: any code point above 255 makes `new Headers()`
 * throw `Cannot convert argument to a ByteString`, and `ServerResponse.setHeader`
 * throw `ERR_INVALID_CHAR`. Interpolating a stored file name directly therefore
 * turns every attachment with a non-Latin-1 name — which in this CRM means most
 * Russian file names — into a 500 rather than a download.
 *
 * The header carries both forms, as RFC 6266 §4.3 prescribes: a sanitised ASCII
 * `filename` that any client can read, and `filename*` with the exact UTF-8 name
 * for clients that understand RFC 5987.
 */

/** Latin-1-safe fallback: quotes/backslashes removed, non-printable-ASCII folded to `_`. */
export function asciiFileNameFallback(fileName: string): string {
    const fallback = fileName
        .replace(/["\\]/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[^\x20-\x7E]/g, '_')
        .trim()
    return fallback || 'file'
}

/** RFC 5987 `ext-value` encoding — percent-encoding plus the characters RFC 5987 reserves. */
export function encodeRFC5987Value(value: string): string {
    return encodeURIComponent(value)
        .replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** Build a header-safe `Content-Disposition` for inline delivery of `fileName`. */
export function inlineContentDisposition(fileName: string): string {
    return `inline; filename="${asciiFileNameFallback(fileName)}"; filename*=UTF-8''${encodeRFC5987Value(fileName)}`
}
