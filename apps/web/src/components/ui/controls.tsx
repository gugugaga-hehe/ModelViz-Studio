import {
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type DOMAttributes,
  type InputEvent,
  type SyntheticEvent,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

/** Keyboard focus ring shared by every control. */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
const DISABLED = "disabled:cursor-not-allowed disabled:opacity-40";

const VARIANT = {
  /** Bordered, for most actions. */
  default: "border border-border hover:border-accent",
  /** The main action of a form or view. */
  primary: "bg-accent font-medium text-white hover:bg-accent/90",
  /** Text-only, for secondary actions in dense places. */
  subtle: "text-muted hover:text-fg",
  /** Bordered, for destructive actions. */
  danger: "border border-border text-danger hover:border-danger",
  /** One of a group of options; `pressed` marks the chosen one. */
  toggle: "text-muted hover:text-fg",
  /** A row of a list; `pressed` marks the open one. */
  item: "hover:bg-bg",
} as const;

const PRESSED: Partial<Record<keyof typeof VARIANT, string>> = {
  toggle: "bg-accent font-medium text-white",
  item: "bg-accent/15",
};

const SIZE = {
  xs: "px-2 py-0.5 text-xs",
  sm: "px-2 py-1 text-xs",
  md: "px-3 py-1.5 text-xs",
  lg: "px-4 py-2 text-sm",
  /** Square, for icon-only buttons (give them an aria-label). */
  icon: "p-1",
  /** No padding, for text-like buttons. */
  inline: "",
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANT;
  size?: keyof typeof SIZE;
  /** For the toggle and item variants: this one is chosen. */
  pressed?: boolean;
}

/** The app's button. `className` is for layout only (margins, flex, width). */
export function Button({ variant = "default", size = "sm", pressed = false, className = "", ...props }: ButtonProps) {
  const look = (pressed && PRESSED[variant]) || VARIANT[variant];
  return <button className={`inline-flex items-center justify-center gap-1 rounded ${look} ${SIZE[size]} ${FOCUS} ${DISABLED} ${className}`} {...props} />;
}

const FIELD_SIZE = {
  sm: "px-2 py-1 text-xs",
  md: "px-2 py-1 text-sm",
  lg: "px-3 py-2 text-sm",
} as const;
type FieldSize = keyof typeof FIELD_SIZE;

const FIELD = `rounded border border-border bg-surface text-fg ${FOCUS} focus-visible:outline-offset-0 ${DISABLED}`;

type FieldElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

interface ValidationProps<E extends FieldElement> extends Pick<DOMAttributes<E>, "onInvalid" | "onInput" | "onChange"> {
  /** Shown when the value does not match `pattern`, e.g. which characters are allowed. */
  patternHint?: string;
}

/**
 * Replaces the browser's validation bubble (shown in the browser's language) with a message under
 * the field in the UI language. The browser still blocks the submit; the first invalid field is
 * focused, marked aria-invalid and described by the message.
 */
function useValidation<E extends FieldElement>({ onInvalid, onInput, onChange, patternHint }: ValidationProps<E>) {
  const { t } = useTranslation();
  const id = useId();
  const [message, setMessage] = useState<string | null>(null);
  const describe = (el: E): string => {
    const v = el.validity;
    if (v.valueMissing) return t("form.required");
    if (v.patternMismatch) return patternHint ?? t("form.invalid");
    if (v.rangeUnderflow) return t("form.min", { min: (el as HTMLInputElement).min });
    if (v.rangeOverflow) return t("form.max", { max: (el as HTMLInputElement).max });
    return t("form.invalid");
  };
  return {
    message: message && (
      // aria-hidden keeps the message out of a wrapping label's name; aria-describedby still reads it
      <span id={`${id}-error`} aria-hidden className="text-xs font-normal text-danger">
        {message}
      </span>
    ),
    props: {
      "aria-invalid": message ? true : undefined,
      "aria-describedby": message ? `${id}-error` : undefined,
      onInvalid: (e: SyntheticEvent<E>) => {
        e.preventDefault(); // no native bubble, so focus the first invalid field ourselves
        const el = e.currentTarget;
        setMessage(describe(el));
        if (el.form?.querySelector(":invalid") === el) el.focus();
        onInvalid?.(e);
      },
      onInput: (e: InputEvent<E>) => {
        if (message && e.currentTarget.validity.valid) setMessage(null);
        onInput?.(e);
      },
      onChange: (e: ChangeEvent<E>) => {
        if (message && e.currentTarget.validity.valid) setMessage(null);
        onChange?.(e);
      },
    },
  };
}

/** The app's text/number input. `className` is for layout only. */
export function Input({
  size = "sm",
  className = "",
  onInvalid,
  onInput,
  onChange,
  patternHint,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & { size?: FieldSize; patternHint?: string }) {
  const v = useValidation({ onInvalid, onInput, onChange, patternHint });
  return (
    <>
      <input className={`${FIELD} ${FIELD_SIZE[size]} ${className}`} {...props} {...v.props} />
      {v.message}
    </>
  );
}

/** The app's select. `className` is for layout only. */
export function Select({ size = "sm", className = "", onInvalid, onInput, onChange, ...props }: Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & { size?: FieldSize }) {
  const v = useValidation({ onInvalid, onInput, onChange });
  return (
    <>
      <select className={`${FIELD} ${FIELD_SIZE[size]} ${className}`} {...props} {...v.props} />
      {v.message}
    </>
  );
}

/** The app's multi-line input. `className` is for layout only. */
export function Textarea({ size = "sm", className = "", onInvalid, onInput, onChange, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { size?: FieldSize }) {
  const v = useValidation({ onInvalid, onInput, onChange });
  return (
    <>
      <textarea className={`${FIELD} ${FIELD_SIZE[size]} ${className}`} {...props} {...v.props} />
      {v.message}
    </>
  );
}
