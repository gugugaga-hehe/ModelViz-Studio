import type { ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

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

/** The app's text/number input. `className` is for layout only. */
export function Input({ size = "sm", className = "", ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & { size?: FieldSize }) {
  return <input className={`${FIELD} ${FIELD_SIZE[size]} ${className}`} {...props} />;
}

/** The app's select. `className` is for layout only. */
export function Select({ size = "sm", className = "", ...props }: Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & { size?: FieldSize }) {
  return <select className={`${FIELD} ${FIELD_SIZE[size]} ${className}`} {...props} />;
}

/** The app's multi-line input. `className` is for layout only. */
export function Textarea({ size = "sm", className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { size?: FieldSize }) {
  return <textarea className={`${FIELD} ${FIELD_SIZE[size]} ${className}`} {...props} />;
}
