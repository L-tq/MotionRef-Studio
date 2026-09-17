/** Studio Link badge (TopBar) + view-only banner.
 *
 *  Shows the connection to the local studio server, the attached external
 *  agents, and who holds the edit lock. While another writer (external agent
 *  or another tab) holds the lock, a slim banner marks this tab view-only —
 *  every doc mutation is blocked (the store refuses it) with a toast. */
import { useState, type CSSProperties } from "react";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import { forceUnlock } from "../state/studioLink";

export function StudioLinkBadge() {
  const t = useT();
  const studio = useStore((s) => s.studio);
  const clientId = studio.clientId;
  const [open, setOpen] = useState(false);

  if (studio.status === "off") return null;

  const holder = studio.lock;
  const mine = holder && holder.id === clientId;
  const viewOnly = !!holder && !mine;
  const color = studio.status === "connected" ? (viewOnly ? "var(--warn, #e6a23c)" : "var(--ok, #67c23a)") : "var(--text-3)";

  const holderName = (h: { kind: string; label: string }) =>
    h.label || (h.kind === "user" ? "Web UI" : h.kind === "mcp" ? "External agent" : "Agent");

  return (
    <div className="studio-badge-wrap" style={{ position: "relative" }}>
      <button
        className={`btn small ${open ? "active" : ""}`}
        title={t("studio.title")}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: color, marginRight: 6 }} />
        {studio.mcpClients > 0 ? `🤖 ${studio.mcpClients}` : "🔗"}
      </button>
      {open && (
        <div className="popover" style={popoverStyle}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{t("studio.title")}</div>
          <div style={{ lineHeight: 1.6 }}>
            {studio.status === "connected" ? t("studio.connected") : t("studio.connecting")}
          </div>
          <div>
            {t("studio.presence", { agents: studio.mcpClients, tabs: studio.browsers })}
          </div>
          {holder && (
            <div style={{ marginTop: 4 }}>
              {mine ? t("studio.youAreEditing", { name: holderName(holder) }) : t("studio.lockedBy", { name: holderName(holder) })}
            </div>
          )}
          {holder && !mine && (
            <button className="btn small" style={{ marginTop: 8 }} onClick={() => forceUnlock()}>
              🔓 {t("studio.forceUnlock")}
            </button>
          )}
          <div style={{ marginTop: 8, color: "var(--text-3)", fontSize: 11, wordBreak: "break-all" }}>
            {t("studio.workspace")}: {studio.workspace}
            <br />
            MCP: {studio.mcpUrl}
          </div>
        </div>
      )}
    </div>
  );
}

/** Full-width slim banner shown while another writer holds the edit lock. */
export function ViewOnlyBanner() {
  const t = useT();
  const studio = useStore((s) => s.studio);
  const holder = studio.lock;
  if (studio.status !== "connected" || !holder || holder.id === studio.clientId) return null;
  const name = holder.label || (holder.kind === "user" ? "Web UI" : holder.kind === "mcp" ? "External agent" : "Agent");
  return (
    <div
      className="viewonly-banner"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "4px 12px",
        background: "color-mix(in srgb, var(--warn, #e6a23c) 14%, var(--bg-1, #222))",
        borderBottom: "1px solid var(--border-2)",
        fontSize: 12,
      }}
    >
      <span>🔒 {t("studio.viewOnly", { name })}</span>
      <span className="spacer" />
      <button className="btn small" onClick={() => forceUnlock()}>
        {t("studio.forceUnlock")}
      </button>
    </div>
  );
}

const popoverStyle: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  right: 0,
  zIndex: 60,
  minWidth: 260,
  maxWidth: 360,
  padding: "10px 12px",
  fontSize: 12,
  lineHeight: 1.5,
  background: "var(--bg-2)",
  border: "1px solid var(--border-2)",
  borderRadius: 8,
  boxShadow: "0 8px 30px rgba(0,0,0,.35)",
};
