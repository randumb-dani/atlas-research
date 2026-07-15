const SOUNDS = {
  clarifying: "/sounds/clarification-required.mp3",
  planning: "/sounds/planning.mp3",
  researching: "/sounds/researching.mp3",
  gap_check: "/sounds/gap-check.mp3",
  compiling: "/sounds/compiling.mp3",
  done: "/sounds/finished.mp3",
} as const;

type SoundKey = keyof typeof SOUNDS;

const audioCache = new Map<SoundKey, HTMLAudioElement>();

function getAudio(key: SoundKey): HTMLAudioElement {
  let audio = audioCache.get(key);
  if (!audio) {
    audio = new Audio(SOUNDS[key]);
    audio.preload = "auto";
    audio.addEventListener("error", (e) => console.error(`[sound] failed to load ${key}:`, e));
    audio.addEventListener("canplay", () => console.log(`[sound] ready: ${key}`));
    audioCache.set(key, audio);
  }
  return audio;
}

export function playSound(key: SoundKey, volume = 0.7) {
  try {
    const audio = getAudio(key);
    audio.volume = volume;
    audio.currentTime = 0;
    const promise = audio.play();
    if (promise) {
      promise.catch((err) => {
        if (err.name === "NotAllowedError") {
          console.warn(`[sound] autoplay blocked for ${key} - needs user interaction first`);
        } else {
          console.error(`[sound] play failed for ${key}:`, err);
        }
      });
    }
  } catch (err) {
    console.error(`[sound] error playing ${key}:`, err);
  }
}

export function preloadSounds() {
  Object.keys(SOUNDS).forEach((k) => getAudio(k as SoundKey));
}