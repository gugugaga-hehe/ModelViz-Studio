import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zhTW from "./locales/zh-TW.json";

/**
 * Glossary terms from CONTEXT.md (Project, Device, Signal, Block, …) stay in English in every
 * language so the UI, docs and code share one vocabulary.
 */
export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "zh-TW", label: "繁體中文" },
] as const;

const STORAGE_KEY = "modelviz.language";

function initialLanguage(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LANGUAGES.some((l) => l.code === saved)) return saved;
  } catch {
    /* storage unavailable */
  }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-TW" : "en";
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, "zh-TW": { translation: zhTW } },
  lng: initialLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

i18n.on("languageChanged", (lng) => {
  document.documentElement.lang = lng;
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    /* storage unavailable */
  }
});

export default i18n;
