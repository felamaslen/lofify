export const AUDIO_EXTENSIONS = [
  'mp3',
  'flac',
  'ogg',
  'oga',
  'opus',
  'm4a',
  'aac',
  'wav',
  'wma',
  'webm',
  'ape',
] as const;

export const AUDIO_EXTENSION_RE = new RegExp(`\\.(?:${AUDIO_EXTENSIONS.join('|')})$`, 'i');
