import { join } from 'node:path';

export const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
export const DATA_DIR = process.env.PROOFDESK_DATA
  ? process.env.PROOFDESK_DATA
  : join(ROOT, 'data');
export const MEDIA_DIR = join(DATA_DIR, 'media');
export const DB_FILE = join(DATA_DIR, 'db.json');
export const PORT = Number(process.env.PORT || 8080);
export const MAX_AUDIO_BYTES = 200 * 1024 * 1024; // 200MB
export const MAX_JSON_BYTES = 2 * 1024 * 1024;
