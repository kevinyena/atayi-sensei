// Shared inline stylesheet used by all the Atayi Sensei landing pages
// except index.html (which has its own bespoke styling). Injected by
// any page that imports this module so we don't duplicate CSS across files.

const SHARED_CSS = `
:root {
  color-scheme: dark;
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: #000;
  color: #fff;
  min-height: 100vh;
}

body {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  padding: 32px 24px;
}

.atayi-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  max-width: 960px;
  margin: 0 auto 48px;
  width: 100%;
}

.atayi-nav a.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  color: white;
}

.atayi-nav a.logo img {
  width: 28px;
  height: 28px;
  border-radius: 6px;
}

.atayi-nav a.logo span {
  font-size: 15px;
  font-weight: 600;
}

.atayi-card {
  background: #0f1011;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 20px;
  padding: 40px 36px;
  max-width: 560px;
  width: 100%;
  margin: 0 auto;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6);
}

.atayi-card h1 {
  font-size: 26px;
  font-weight: 700;
  margin: 0 0 10px;
}

.atayi-card p.subtitle {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.6);
  margin: 0 0 24px;
  line-height: 1.5;
}

.atayi-card label {
  display: block;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  margin-bottom: 6px;
  font-weight: 500;
}

.atayi-card input[type=email],
.atayi-card input[type=password],
.atayi-card input[type=text] {
  width: 100%;
  background: #15171a;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 12px 14px;
  color: white;
  font-size: 14px;
  outline: none;
  transition: border-color 0.15s;
}

.atayi-card input:focus {
  border-color: #3b82f6;
}

.atayi-btn {
  display: inline-block;
  background: #3b82f6;
  color: white;
  border: none;
  border-radius: 10px;
  padding: 12px 20px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
  transition: filter 0.15s, transform 0.1s;
  width: 100%;
  text-align: center;
}

.atayi-btn:hover { filter: brightness(1.1); }
.atayi-btn:active { transform: translateY(1px); }

.atayi-btn.secondary {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: rgba(255, 255, 255, 0.7);
}
.atayi-btn.secondary:hover { background: rgba(255, 255, 255, 0.05); }

.atayi-license-code {
  background: #0a0b0d;
  border: 2px dashed #3b82f6;
  border-radius: 12px;
  padding: 20px 16px;
  margin: 16px 0;
  text-align: center;
  font-family: "SF Mono", Menlo, Consolas, monospace;
  font-size: 16px;
  font-weight: 600;
  color: #60a5fa;
  letter-spacing: 1px;
  word-break: break-all;
  user-select: all;
}

.atayi-warning {
  background: rgba(234, 179, 8, 0.1);
  border: 1px solid rgba(234, 179, 8, 0.3);
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 13px;
  color: #eab308;
  margin: 12px 0;
  line-height: 1.5;
}

.atayi-success {
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.3);
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 13px;
  color: #4ade80;
  margin: 12px 0;
}

.atayi-error {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 13px;
  color: #f87171;
  margin: 12px 0;
}

.atayi-muted {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
  text-align: center;
  margin-top: 20px;
}

.atayi-muted a { color: #60a5fa; text-decoration: none; }
.atayi-muted a:hover { text-decoration: underline; }

.atayi-plan-chip {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 99px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}
.atayi-plan-chip.trial { background: rgba(59, 130, 246, 0.15); color: #60a5fa; }
.atayi-plan-chip.starter { background: rgba(234, 179, 8, 0.15); color: #eab308; }
.atayi-plan-chip.ultra { background: rgba(168, 85, 247, 0.15); color: #c084fc; }

.atayi-spinner {
  display: inline-block;
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-top-color: white;
  border-radius: 50%;
  animation: atayi-spin 0.8s linear infinite;
}
@keyframes atayi-spin {
  to { transform: rotate(360deg); }
}
`;

export function injectSharedStyles() {
  if (document.getElementById("atayi-shared-styles")) return;
  const styleElement = document.createElement("style");
  styleElement.id = "atayi-shared-styles";
  styleElement.textContent = SHARED_CSS;
  document.head.appendChild(styleElement);
}
