import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Attachment } from './openwa.js';

const run = promisify(execFile);

export type MediaInput = { image: string } | { audio: string };
export type MediaKind = 'image' | 'audio' | 'video';

export function mediaKind(type: string): MediaKind | null {
  if (type === 'image') return 'image';
  if (type === 'audio' || type === 'ptt') return 'audio';
  return type === 'video' ? 'video' : null;
}

export async function* prepareSearchMedia(
  attachment: Attachment,
  kind: MediaKind,
  signal: AbortSignal,
): AsyncGenerator<MediaInput> {
  if (kind === 'image') {
    yield { image: attachment.bytes.toString('base64') };
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'chat2tasks-search-media-'));
  const source = join(dir, 'source');
  const options = { signal, timeout: 600_000, maxBuffer: 256_000 };
  try {
    await writeFile(source, attachment.bytes, { mode: 0o600 });
    const probe = await run(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', source],
      options,
    );
    const streams = new Set(probe.stdout.trim().split(/\s+/));
    if (kind === 'video' && streams.has('video')) {
      await run(
        'ffmpeg',
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          source,
          '-vf',
          "fps=1/5:start_time=0,scale='min(768,iw)':-2",
          '-q:v',
          '4',
          join(dir, 'frame-%06d.jpg'),
        ],
        options,
      );
    }
    if (streams.has('audio')) {
      await run(
        'ffmpeg',
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          source,
          '-map',
          '0:a:0',
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'pcm_s16le',
          '-f',
          'segment',
          '-segment_time',
          '30',
          '-reset_timestamps',
          '1',
          join(dir, 'audio-%06d.wav'),
        ],
        options,
      );
    }
    const files = (await readdir(dir))
      .filter((name) => /^(frame-.*\.jpg|audio-.*\.wav)$/.test(name))
      .sort();
    if (!files.length) throw new Error('No supported media streams');
    for (const name of files) {
      const data = (await readFile(join(dir, name))).toString('base64');
      yield name.startsWith('frame-') ? { image: data } : { audio: data };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
