import { useTranslation } from "react-i18next";
import { LANGUAGES } from "../i18n";

export function LanguageSelect() {
  const { t, i18n } = useTranslation();
  return (
    <label className="flex items-center gap-2 text-sm text-muted">
      {t("language.label")}
      <select
        aria-label={t("language.label")}
        value={i18n.language}
        onChange={(e) => void i18n.changeLanguage(e.target.value)}
        className="rounded border border-border bg-surface px-2 py-1 text-fg"
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}
