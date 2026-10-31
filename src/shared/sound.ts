import { useEffect } from 'react';
import type { SoundPreferences } from './schema.js';

export type SoundKind = 'completion' | 'attention';

let audio: AudioContext | undefined;

function activateAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume().catch(() => {});
  } catch {
    // Sound is optional; visual feedback remains available.
  }
}

export function useSoundActivation() {
  useEffect(() => {
    document.addEventListener('pointerdown', activateAudio, true);
    document.addEventListener('keydown', activateAudio, true);
    return () => {
      document.removeEventListener('pointerdown', activateAudio, true);
      document.removeEventListener('keydown', activateAudio, true);
    };
  }, []);
}

export async function playSound(
  kind: SoundKind,
  preferences: SoundPreferences,
  preview = false,
): Promise<boolean> {
  if ((!preview && !preferences[kind]) || preferences.volume === 0) return false;
  if (document.visibilityState !== 'visible' || (!preview && !document.hasFocus())) return false;
  try {
    if (preview) activateAudio();
    if (!audio) return false;
    if (audio.state === 'suspended') await audio.resume();
    if (audio.state !== 'running') return false;
    const notes = kind === 'completion' ? [520] : [440, 370];
    const duration = kind === 'completion' ? 0.12 : 0.07;
    const start = audio.currentTime;
    for (const [index, frequency] of notes.entries()) {
      const at = start + index * 0.15;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(preferences.volume * 0.12, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start(at);
      oscillator.stop(at + duration);
    }
    return true;
  } catch {
    return false;
  }
}
