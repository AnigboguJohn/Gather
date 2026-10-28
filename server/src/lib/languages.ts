/**
 * The languages Gather supports for captions, translations and summaries.
 *  - `whisper`: the code speech-to-text understands (null = let it auto-detect, e.g. Igbo and Pidgin).
 *  - `tts`: the voice locale browsers use to read translations aloud.
 * The web app keeps a matching list in web/src/lib/format.ts.
 */
export const LANGUAGES: Record<string, { name: string; whisper: string | null; tts: string }> = {
  en: { name: "English", whisper: "en", tts: "en-NG" },
  yo: { name: "Yoruba", whisper: "yo", tts: "yo-NG" },
  ha: { name: "Hausa", whisper: "ha", tts: "ha-NG" },
  ig: { name: "Igbo", whisper: null, tts: "ig-NG" },
  pcm: { name: "Nigerian Pidgin", whisper: null, tts: "en-NG" },
  sw: { name: "Swahili", whisper: "sw", tts: "sw-KE" },
  fr: { name: "French", whisper: "fr", tts: "fr-FR" },
};
/** Type guard used when validating input: is this one of our language codes? */
export const isLanguage = (l: unknown): l is string => typeof l === "string" && l in LANGUAGES;
/** Human name for a code ("yo" → "Yoruba"); unknown codes are returned as-is. */
export const languageName = (l: string) => LANGUAGES[l]?.name ?? l;
