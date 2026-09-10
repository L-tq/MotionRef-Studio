import { useStore } from "../state/store";
import { useT } from "../i18n";

/** Dropdown message center: every toast and background error is archived
 *  here (newest first) so nothing has to hover over the canvas forever. */
export function MessagesPanel() {
  const t = useT();
  const messages = useStore((s) => s.messages);
  const clearMessages = useStore((s) => s.clearMessages);
  const close = () => useStore.setState({ messagesOpen: false });

  return (
    <>
      <div className="msglog-overlay" onClick={close} />
      <div className="msglog" role="dialog" aria-label={t("messages.title")}>
        <div className="msglog-header">
          <span>{t("messages.title")}</span>
          <span style={{ flex: 1 }} />
          <button className="btn small" onClick={clearMessages} disabled={messages.length === 0}>
            {t("messages.clear")}
          </button>
          <button className="btn small" title={t("common.close")} onClick={close}>
            ✕
          </button>
        </div>
        <div className="msglog-list">
          {messages.length === 0 && <div className="empty-note">{t("messages.empty")}</div>}
          {messages.map((m) => (
            <div key={m.id} className={`msglog-row ${m.kind}`}>
              <span className="dot" />
              <span className="text">
                {m.text}
                {m.count > 1 && <span className="chip" style={{ marginLeft: 6 }}>×{m.count}</span>}
              </span>
              <time>{new Date(m.time).toLocaleTimeString()}</time>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
