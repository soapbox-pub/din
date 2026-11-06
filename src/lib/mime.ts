/** Media types by file extension, for files read off the disk, which carry none. */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif', heic: 'image/heic', tif: 'image/tiff', tiff: 'image/tiff',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', htm: 'text/html', css: 'text/css',
  js: 'text/javascript', json: 'application/json', xml: 'application/xml', pdf: 'application/pdf',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed',
  epub: 'application/epub+zip', wasm: 'application/wasm',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', stl: 'model/stl', obj: 'model/obj',
};

/** A file's media type from its name, or '' when its extension isn't known. */
export function mimeOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : MIME_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? '';
}
