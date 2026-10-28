/**
 * Voice & video choices from Settings, saved on this device (localStorage) and used by the join screen and the call:
 * which microphone, camera and speaker to use, whether the browser cleans up the voice, and the default data use.
 */
import type { DataSaver } from "../room/useCall";

export interface DevicePrefs {
  mic?: string; cam?: string; speaker?: string;
  /** Noise suppression and automatic mic level (on by default). */
  cleanVoice: boolean;
  /** Data use to start calls with; unset = data saver on phones, normal elsewhere. */
  saver?: DataSaver;
}
const KEY = "gather.devices";

/** The saved choices (empty in a private window or when storage is blocked). */
export function loadPrefs(): DevicePrefs {
  try { return { cleanVoice: true, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return { cleanVoice: true }; }
}
/** Save some choices and return the full set. */
export function savePrefs(p: Partial<DevicePrefs>): DevicePrefs {
  const next = { ...loadPrefs(), ...p };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: just this visit */ }
  return next;
}
/** Can this browser send sound to a chosen speaker? (Chrome and Edge can; Safari and Firefox use the system's.) */
export const canPickSpeaker = () => typeof (HTMLMediaElement.prototype as any).setSinkId === "function";
