import { useEffect, useState } from "react";
import { Bot, BookOpen, Check, Copy, Eye, EyeOff } from "lucide-react";
import { useStore } from "../state/store";
import { useT } from "../i18n";
import { testConnection } from "../agent/llmClient";
import { AGENT_SKILL_GUIDE } from "../agent/guide";
import { getLocale } from "../i18n";

/** Local studio mode: connection info + copy-paste MCP configs for the five
 *  supported external agent CLIs. The system prompt they get (the external
 *  Agent Skill Guide) shares its body with the built-in agent. */
function ExternalAgentsSection() {
  const t = useT();
  const studio = useStore((s) => s.studio);
  const [copied, setCopied] = useState<string | null>(null);
  if (studio.status !== "connected") return null;

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((k) => (k === key ? null : k)), 1500);
    } catch {
      /* clipboard denied — the text is selectable */
    }
  };

  const url = studio.mcpUrl;
  const tok = studio.token;
  const repoCmd = "npm run mcp"; // stdio shim from the motionref-studio repo
  const snippets: Array<{ key: string; label: string; code: string }> = [
    {
      key: "zcode",
      label: "ZCode",
      code: JSON.stringify({ mcpServers: { motionref: { url, headers: { Authorization: `Bearer ${tok}` } } } }, null, 2),
    },
    {
      key: "claude",
      label: "Claude Code",
      code: `claude mcp add --transport http motionref ${url} --header "Authorization: Bearer ${tok}"`,
    },
    {
      key: "codex",
      label: "Codex",
      code: `# ~/.codex/config.toml\n[mcp_servers.motionref]\nurl = "${url}"\nhttp_headers = { "Authorization" = "Bearer ${tok}" }`,
    },
    {
      key: "opencode",
      label: "OpenCode",
      code: JSON.stringify({ mcp: { motionref: { type: "remote", url, headers: { Authorization: `Bearer ${tok}` } } } }, null, 2),
    },
    {
      key: "deepseek",
      label: "DeepSeek Harness",
      code: `# stdio bridge (run inside your agent workspace)\n${repoCmd} --url ${url} --token ${tok}`,
    },
  ];

  return (
    <details className="docs">
      <summary>
        <Bot size={12} />
        {t("studio.externalAgents")}
      </summary>
      <div className="field" style={{ marginTop: 8 }}>
        <label>{t("studio.mcpEndpoint")}</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input readOnly value={url} style={{ flex: 1 }} onFocus={(e) => e.target.select()} />
          <button className="btn small" onClick={() => void copy("url", url)}>
            {copied === "url" ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
        <label style={{ marginTop: 8 }}>{t("studio.token")}</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input readOnly value={tok} style={{ flex: 1 }} onFocus={(e) => e.target.select()} />
          <button className="btn small" onClick={() => void copy("tok", tok)}>
            {copied === "tok" ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
        <span className="hint">{t("studio.tokenHint")}</span>
      </div>
      {snippets.map((s) => (
        <div className="field" key={s.key}>
          <label>
            {s.label}{" "}
            <button className="btn small" style={{ marginLeft: 6 }} onClick={() => void copy(s.key, s.code)}>
              {copied === s.key ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </label>
          <pre style={{ margin: 0, userSelect: "text" }}>{s.code}</pre>
        </div>
      ))}
      <span className="hint">{t("studio.snippetHint")}</span>
    </details>
  );
}

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
  const [limitMaxSteps, setLimitMaxSteps] = useState(settings.limitMaxSteps);
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
    saveSettings({ baseUrl, apiKey, model, provider: p, connection, maxImages, maxSteps, limitMaxSteps });
    close();
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testConnection({ baseUrl, apiKey, model, provider, connection, maxImages, maxSteps, limitMaxSteps });
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
                    {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
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
                  <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input type="checkbox" checked={limitMaxSteps} onChange={(e) => setLimitMaxSteps(e.target.checked)} />
                    {t("settings.maxSteps")}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={maxSteps}
                    disabled={!limitMaxSteps}
                    onChange={(e) => setMaxSteps(Math.max(1, parseInt(e.target.value, 10) || 1))}
                  />
                  <span className="hint">{t("settings.maxStepsHint")}</span>
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

          <ExternalAgentsSection />

          <details className="docs" open={showGuide} onToggle={(e) => setShowGuide((e.target as HTMLDetailsElement).open)}>
            <summary>
              <BookOpen size={12} />
              {t("settings.guidePreview")}
            </summary>
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
