import path from 'path';

export function shouldIgnoreFile(filePath) {
  const basename = path.basename(filePath);
  return /(^[.#]|(?:__|~)$|compressed_video)/.test(basename);
}
