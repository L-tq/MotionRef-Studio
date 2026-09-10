import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import { testConnection } from "../agent/llmClient";
import { AGENT_SKILL_GUIDE } from "../agent/guide";
import { getLocale } from "../i18n";

export function SettingsDialog({ onboarding }: { onboarding?: boolean }) {
  const t = useT();
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const setUi = useStore((s) => s.setUi);

  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [model, setModel] = useState(settings.model);
  const [provider, setProvider] = useState(settings.provider);
  const [connection, setConnection] = useState(settings.connection);
  const [maxImages, setMaxImages] = useState(settings.maxImages);
  const [maxSteps, setMaxSteps] = useState(settings.maxSteps);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    setTestResult(null);
  }, [baseUrl, apiKey, model, provider, connection]);

  const close = () => setUi("settingsOpen", false);
  const isMock = provider === "mock";

  const apply = (nextProvider?: "real" | "mock") => {
    const p = nextProvider ?? provider;
    saveSettings({ baseUrl, apiKey, model, provider: p, connection, maxImages, maxSteps });
    close();
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testConnection({ baseUrl, apiKey, model, provider, connection, maxImages, maxSteps });
      setTestResult((result.ok ? "✓ " : "✗ ") + result.detail);
    } catch (err) {
      setTestResult("✗ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="modal-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget && !onboarding) close(); }}>
      <div className="modal">
        <div className="modal-header">
          {onboarding ? t("settings.welcomeTitle") : t("settings.title")}
          <span className="spacer" />
        </div>
        <div className="modal-body">
          {onboarding && <p style={{ margin: 0, color: "var(--text-2)", lineHeight: 1.6 }}>{t("settings.welcomeBody")}</p>}

          <div className="field">
            <label>{t("settings.provider")}</label>
            <div className="radio-cards">
              <button className={!isMock ? "active" : ""} onClick={() => setProvider("real")}>
                {t("settings.providerReal")}
              </button>
              <button className={isMock ? "active" : ""} onClick={() => setProvider("mock")}>
                {t("settings.providerMock")}
              </button>
            </div>
          </div>

          {!isMock && (
            <>
              <div className="field">
                <label>{t("settings.baseUrl")}</label>
                <input type="text" placeholder="https://api.deepseek.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                <span className="hint">{t("settings.baseUrlHint")}</span>
              </div>
              <div className="field">
                <label>{t("settings.apiKey")}</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    autoComplete="off"
                    style={{ flex: 1 }}
                  />
                  <button className="btn small" onClick={() => setShowKey(!showKey)}>
                    {showKey ? "🙈" : "👁"}
                  </button>
                </div>
                <span className="hint">{t("settings.apiKeyHint")}</span>
              </div>
              <div className="field">
                <label>{t("settings.model")}</label>
                <input type="text" placeholder="glm-4.5v / deepseek-vl2 / gpt-4o …" value={model} onChange={(e) => setModel(e.target.value)} />
                <span className="hint">{t("settings.modelHint")}</span>
              </div>
              <div className="field">
                <label>{t("settings.connection")}</label>
                <div className="radio-cards">
                  <button className={connection === "proxy" ? "active" : ""} onClick={() => setConnection("proxy")}>
                    {t("settings.proxy")}
                  </button>
                  <button className={connection === "direct" ? "active" : ""} onClick={() => setConnection("direct")}>
                    {t("settings.direct")}
                  </button>
                </div>
                <span className="hint">{connection === "proxy" ? t("settings.proxyHint") : t("settings.directHint")}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div className="field">
                  <label>{t("settings.maxImages")}</label>
                  <input type="number" min={1} max={64} value={maxImages} onChange={(e) => setMaxImages(Math.max(1, parseInt(e.target.value, 10) || 1))} />
                </div>
                <div className="field">
                  <label>{t("settings.maxSteps")}</label>
                  <input type="number" min={1} max={100} value={maxSteps} onChange={(e) => setMaxSteps(Math.max(1, parseInt(e.target.value, 10) || 1))} />
                </div>
              </div>
              <div className="insp-row">
                <button className="btn" disabled={testing || !baseUrl.trim()} onClick={test}>
                  {testing ? t("settings.testing") : t("settings.test")}
                </button>
                {testResult && (
                  <span style={{ color: testResult.startsWith("✓") ? "var(--accent-2)" : "var(--danger)", fontSize: 12 }}>
                    {testResult}
                  </span>
                )}
              </div>
            </>
          )}

          <details className="docs" open={showGuide} onToggle={(e) => setShowGuide((e.target as HTMLDetailsElement).open)}>
            <summary>📘 {t("settings.guidePreview")}</summary>
            <pre>{AGENT_SKILL_GUIDE[getLocale()]}</pre>
          </details>
        </div>
        <div className="modal-footer">
          {onboarding && (
            <button className="btn" onClick={() => apply("mock")}>
              {t("settings.skipMock")}
            </button>
          )}
          <span className="spacer" style={{ flex: 1 }} />
          {!onboarding && (
            <button className="btn" onClick={close}>
              {t("common.close")}
            </button>
          )}
          <button className="btn primary" onClick={() => apply()} disabled={!isMock && !baseUrl.trim()}>
            {t("common.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
