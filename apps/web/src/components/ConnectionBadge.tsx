import { useTranslation } from "react-i18next";
import { useSession } from "../state/session";

const DOT: Record<string, string> = {
  connected: "bg-ok",
  connecting: "bg-warn animate-pulse",
  disconnected: "bg-danger animate-pulse",
  incompatible: "bg-danger",
  closed: "bg-muted",
};

export function ConnectionBadge() {
  const { t } = useTranslation();
  const connection = useSession((s) => s.connection);
  const error = useSession((s) => s.connectionError);
  return (
    <div role="status" data-testid="connection-status" data-state={connection} className="flex items-center gap-2 whitespace-nowrap text-sm">
      <span className={`size-2.5 shrink-0 rounded-full ${DOT[connection]}`} aria-hidden />
      <span>{t(`connection.${connection}`, { message: error ?? "" })}</span>
    </div>
  );
}
