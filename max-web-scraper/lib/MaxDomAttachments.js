'use strict'

const FILE_NAME_RE = /([^\n\r<>:"/\\|?*]+\.(?:ogg|opus|mp3|m4a|aac|wav|mp4|mov|jpe?g|png|webp|gif|pdf|zip))\b/i

function extractDomAttachmentFileName(value) {
  const match = String(value || '').match(FILE_NAME_RE)
  return match?.[1]?.trim() || null
}

function preferredDomImageName(input = {}) {
  for (const value of [input.alt, input.title, input.download]) {
    const fileName = extractDomAttachmentFileName(value)
    if (fileName && /\.(jpe?g|png|webp|gif)$/i.test(fileName)) return fileName
  }
  try {
    const pathname = new URL(String(input.url || '')).pathname
    const fileName = decodeURIComponent(pathname.split('/').pop() || '')
    if (/\.(jpe?g|png|webp|gif)$/i.test(fileName)) return fileName
  } catch {}
  return input.fallback || 'max-image.jpg'
}

module.exports = {
  extractDomAttachmentFileName,
  preferredDomImageName,
}
