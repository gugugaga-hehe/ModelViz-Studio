import { useTranslation } from "react-i18next";
import { LANGUAGES } from "../i18n";
import { Select } from "./ui/controls";

export function LanguageSelect() {
  const { t, i18n } = useTranslation();
  return (
    <label className="flex items-center gap-2 whitespace-nowrap text-sm text-muted">
      {/* on narrow windows only the select shows; it keeps its accessible name */}
      <span className="max-sm:sr-only">{t("language.label")}</span>
      <Select
        aria-label={t("language.label")}
        value={i18n.language}
        onChange={(e) => void i18n.changeLanguage(e.target.value)}
        size="md"
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </Select>
    </label>
  );
}
