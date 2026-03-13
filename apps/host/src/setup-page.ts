export const renderSetupPage = (): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>DumplBot Setup</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4efe6;
        --card: #fffaf3;
        --ink: #1f2a30;
        --muted: #61737d;
        --accent: #0d6c7d;
        --accent-strong: #094c57;
        --border: #d5c9b8;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at top, rgba(13, 108, 125, 0.16), transparent 32%),
          linear-gradient(180deg, #f8f2e8 0%, var(--bg) 100%);
        color: var(--ink);
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
      }

      main {
        width: min(42rem, calc(100vw - 2rem));
        margin: 0 auto;
        padding: 2rem 0 3rem;
      }

      .card {
        background: color-mix(in srgb, var(--card) 92%, white);
        border: 1px solid var(--border);
        border-radius: 1.25rem;
        box-shadow: 0 20px 50px rgba(31, 42, 48, 0.08);
        padding: 1.25rem;
      }

      h1, h2, p { margin: 0; }
      .eyebrow {
        color: var(--accent);
        font-size: 0.82rem;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }

      .lede {
        color: var(--muted);
        margin-top: 0.75rem;
        line-height: 1.45;
      }

      form {
        display: grid;
        gap: 1rem;
        margin-top: 1.5rem;
      }

      label {
        display: grid;
        gap: 0.45rem;
        font-size: 0.96rem;
      }

      select, input, button, textarea {
        width: 100%;
        border-radius: 0.9rem;
        border: 1px solid var(--border);
        padding: 0.8rem 0.9rem;
        font: inherit;
      }

      select, input { background: white; }
      textarea {
        min-height: 14rem;
        background: white;
        resize: vertical;
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: "SFMono-Regular", "Menlo", monospace;
      }

      button {
        background: var(--accent);
        color: white;
        font-weight: 700;
        cursor: pointer;
      }

      button:hover { background: var(--accent-strong); }

      .meta {
        display: grid;
        gap: 0.45rem;
        margin-top: 1.5rem;
        color: var(--muted);
        font-size: 0.92rem;
      }

      .status {
        min-height: 1.4rem;
        color: var(--accent-strong);
        font-weight: 700;
      }

      .secondary-button {
        background: transparent;
        color: var(--accent-strong);
      }

      .button-row {
        display: grid;
        gap: 0.75rem;
        grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
      }
    </style>
  </head>
  <body>
    <main>
      <section class="card">
        <p class="eyebrow">LAN-only setup</p>
        <h1>DumplBot Setup</h1>
        <p class="lede">
          Non-secret appliance setup for the current device. Update the default workspace,
          default skill, and safety mode without SSH.
        </p>
        <p class="lede">
          Secret values stay hidden here. The page only shows whether the local secrets file
          and provider keys are configured. Leave key fields blank to keep existing values.
        </p>

        <form id="setup-form">
          <label>
            Default workspace
            <select id="default-workspace" name="default_workspace"></select>
          </label>

          <label>
            Default skill
            <select id="default-skill" name="default_skill"></select>
          </label>

          <label>
            Safety mode
            <select id="safety-mode" name="safety_mode">
              <option value="strict">strict</option>
              <option value="balanced">balanced</option>
              <option value="permissive">permissive</option>
            </select>
          </label>

          <button type="submit">Save setup</button>
          <p class="status" id="status">Loading setup…</p>
        </form>

        <div class="meta" id="meta">
          <p>Active workspace: <span id="active-workspace">-</span></p>
          <p>Active skill: <span id="active-skill">-</span></p>
          <p>Secrets file: <span id="secrets-file-status">-</span></p>
          <p>OpenAI key: <span id="openai-key-status">-</span></p>
          <p>Anthropic key: <span id="anthropic-key-status">-</span></p>
          <p>Active bind: <span id="active-server-bind">-</span></p>
          <p>Configured bind: <span id="configured-server-bind">-</span></p>
          <p>Same-Wi-Fi setup: <span id="lan-setup-ready">-</span></p>
          <p>Restart required: <span id="restart-required">-</span></p>
          <p>System hint: <span id="system-status-message">-</span></p>
          <p>Daemon health: <span id="daemon-health">-</span></p>
          <p>Scheduler: <span id="scheduler-enabled">-</span></p>
          <p>STT ready: <span id="stt-ready">-</span></p>
          <p>STT model: <span id="stt-model">-</span></p>
          <p>Setup health: <span id="setup-health-message">-</span></p>
          <p>Skill integrations:</p>
          <pre id="skill-integrations">-</pre>
          <p>Next step: <span id="system-action-label">-</span></p>
          <pre id="system-action-instructions">-</pre>
        </div>

        <form id="secrets-form">
          <label>
            OpenAI API key
            <input
              id="openai-api-key"
              name="openai_api_key"
              type="password"
              autocomplete="off"
              placeholder="sk-..."
            />
          </label>

          <label>
            Anthropic API key
            <input
              id="anthropic-api-key"
              name="anthropic_api_key"
              type="password"
              autocomplete="off"
              placeholder="sk-ant-..."
            />
          </label>

          <button type="submit">Save keys</button>
        </form>

        <form id="config-form">
          <label>
            Config export
            <textarea
              id="config-export"
              name="config_export"
              spellcheck="false"
            ></textarea>
          </label>

          <div class="button-row">
            <button type="button" class="secondary-button" id="refresh-config">Refresh export</button>
            <button type="submit" id="import-config">Import config</button>
          </div>
        </form>
      </section>
    </main>

    <script type="module">
      const statusNode = document.querySelector("#status");
      const workspaceSelect = document.querySelector("#default-workspace");
      const skillSelect = document.querySelector("#default-skill");
      const safetySelect = document.querySelector("#safety-mode");
      const activeWorkspaceNode = document.querySelector("#active-workspace");
      const activeSkillNode = document.querySelector("#active-skill");
      const secretsFileStatusNode = document.querySelector("#secrets-file-status");
      const openAiKeyStatusNode = document.querySelector("#openai-key-status");
      const anthropicKeyStatusNode = document.querySelector("#anthropic-key-status");
      const activeServerBindNode = document.querySelector("#active-server-bind");
      const configuredServerBindNode = document.querySelector("#configured-server-bind");
      const lanSetupReadyNode = document.querySelector("#lan-setup-ready");
      const restartRequiredNode = document.querySelector("#restart-required");
      const systemStatusMessageNode = document.querySelector("#system-status-message");
      const daemonHealthNode = document.querySelector("#daemon-health");
      const schedulerEnabledNode = document.querySelector("#scheduler-enabled");
      const sttReadyNode = document.querySelector("#stt-ready");
      const sttModelNode = document.querySelector("#stt-model");
      const setupHealthMessageNode = document.querySelector("#setup-health-message");
      const skillIntegrationsNode = document.querySelector("#skill-integrations");
      const systemActionLabelNode = document.querySelector("#system-action-label");
      const systemActionInstructionsNode = document.querySelector("#system-action-instructions");
      const formNode = document.querySelector("#setup-form");
      const secretsFormNode = document.querySelector("#secrets-form");
      const openAiApiKeyNode = document.querySelector("#openai-api-key");
      const anthropicApiKeyNode = document.querySelector("#anthropic-api-key");
      const configFormNode = document.querySelector("#config-form");
      const configExportNode = document.querySelector("#config-export");
      const refreshConfigButtonNode = document.querySelector("#refresh-config");

      const renderOptions = (selectNode, items, selectedValue) => {
        selectNode.innerHTML = "";

        for (const item of items) {
          const optionNode = document.createElement("option");
          optionNode.value = item.value;
          optionNode.textContent = item.label;
          optionNode.selected = item.value === selectedValue;
          selectNode.append(optionNode);
        }
      };

      const fetchJson = async (path, options) => {
        const response = await fetch(path, options);
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload.error || response.statusText || "request failed");
        }

        return payload;
      };

      const formatConfiguredStatus = (isConfigured) => isConfigured ? "configured" : "missing";
      const formatReadyStatus = (isReady) => isReady ? "ready" : "not ready";
      const formatRestartStatus = (restartRequired) => restartRequired ? "yes" : "no";
      const formatEnabledStatus = (enabled) => enabled ? "enabled" : "disabled";
      const formatHealthyStatus = (healthy) => healthy ? "healthy" : "unhealthy";

      const renderSkillIntegrations = (skills) => {
        const lines = skills
          .filter((skill) => skill && typeof skill.id === "string")
          .map((skill) => {
            const integrations = Array.isArray(skill.integrations)
              ? skill.integrations
                  .filter((integration) => integration && typeof integration.provider === "string")
                  .map((integration) =>
                    integration.provider + "[" + (integration.configured ? "ready" : "missing") + "]"
                  )
              : [];

            return skill.id + ": " + (integrations.length > 0 ? integrations.join(", ") : "(none)");
          });

        skillIntegrationsNode.textContent = lines.length > 0
          ? lines.join("\\n")
          : "No skills loaded";
      };

      const loadConfigExport = async () => {
        const configExportPayload = await fetchJson("/api/config/export");
        configExportNode.value = configExportPayload.config;
      };

      const loadSetupStatus = async () => {
        const setupStatusPayload = await fetchJson("/api/setup/status");
        secretsFileStatusNode.textContent = formatConfiguredStatus(
          setupStatusPayload.secrets.secrets_file_present,
        );
        openAiKeyStatusNode.textContent = formatConfiguredStatus(
          setupStatusPayload.secrets.openai_api_key_configured,
        );
        anthropicKeyStatusNode.textContent = formatConfiguredStatus(
          setupStatusPayload.secrets.anthropic_api_key_configured,
        );
      };

      const loadSetupSystem = async () => {
        const setupSystemPayload = await fetchJson("/api/setup/system");
        activeServerBindNode.textContent = setupSystemPayload.system.active_server.bind;
        configuredServerBindNode.textContent = setupSystemPayload.system.configured_server.bind;
        lanSetupReadyNode.textContent = formatReadyStatus(setupSystemPayload.system.lan_setup_ready);
        restartRequiredNode.textContent = formatRestartStatus(setupSystemPayload.system.restart_required);
        systemStatusMessageNode.textContent = setupSystemPayload.system.status_message;
        systemActionLabelNode.textContent = setupSystemPayload.system.action_label || "none";
        systemActionInstructionsNode.textContent = setupSystemPayload.system.action_instructions.length > 0
          ? setupSystemPayload.system.action_instructions.join("\n")
          : "No action needed";
      };

      const loadSetupHealth = async () => {
        const setupHealthPayload = await fetchJson("/api/setup/health");
        daemonHealthNode.textContent = formatHealthyStatus(setupHealthPayload.health.daemon_healthy);
        schedulerEnabledNode.textContent = formatEnabledStatus(setupHealthPayload.health.scheduler_enabled);
        sttReadyNode.textContent = formatReadyStatus(setupHealthPayload.health.stt_ready);
        sttModelNode.textContent = setupHealthPayload.health.stt_model
          + " ("
          + setupHealthPayload.health.stt_language
          + ")";
        setupHealthMessageNode.textContent = setupHealthPayload.health.status_message;
      };

      const loadSetup = async () => {
        statusNode.textContent = "Loading setup…";

        const [configPayload, workspacePayload, skillPayload] = await Promise.all([
          fetchJson("/api/config"),
          fetchJson("/api/workspaces"),
          fetchJson("/api/skills"),
        ]);

        renderOptions(
          workspaceSelect,
          workspacePayload.workspaces.map((workspace) => ({
            value: workspace.id,
            label: workspace.id,
          })),
          configPayload.runtime.default_workspace,
        );
        renderOptions(
          skillSelect,
          skillPayload.skills.map((skill) => ({
            value: skill.id,
            label: skill.id,
          })),
          configPayload.runtime.default_skill,
        );
        renderSkillIntegrations(skillPayload.skills);

        safetySelect.value = configPayload.runtime.safety_mode;
        activeWorkspaceNode.textContent = configPayload.runtime.active_workspace || "default fallback";
        activeSkillNode.textContent = configPayload.runtime.active_skill || "default fallback";
        await loadSetupStatus();
        await loadSetupHealth();
        await loadSetupSystem();
        await loadConfigExport();
        statusNode.textContent = "Setup loaded";
      };

      formNode.addEventListener("submit", async (event) => {
        event.preventDefault();
        statusNode.textContent = "Saving setup…";

        try {
          const payload = await fetchJson("/api/config", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              runtime: {
                default_workspace: workspaceSelect.value,
                default_skill: skillSelect.value,
                safety_mode: safetySelect.value,
              },
            }),
          });

          activeWorkspaceNode.textContent = payload.runtime.active_workspace || "default fallback";
          activeSkillNode.textContent = payload.runtime.active_skill || "default fallback";
          statusNode.textContent = "Setup saved";
        } catch (error) {
          statusNode.textContent = error instanceof Error ? error.message : "save failed";
        }
      });

      secretsFormNode.addEventListener("submit", async (event) => {
        event.preventDefault();

        const payload = {};

        if (openAiApiKeyNode.value.trim().length > 0) {
          payload.openai_api_key = openAiApiKeyNode.value.trim();
        }

        if (anthropicApiKeyNode.value.trim().length > 0) {
          payload.anthropic_api_key = anthropicApiKeyNode.value.trim();
        }

        if (Object.keys(payload).length === 0) {
          statusNode.textContent = "Enter at least one key to update";
          return;
        }

        statusNode.textContent = "Saving keys…";

        try {
          await fetchJson("/api/setup/secrets", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });

          openAiApiKeyNode.value = "";
          anthropicApiKeyNode.value = "";
          await loadSetupStatus();
          const skillPayload = await fetchJson("/api/skills");
          renderSkillIntegrations(skillPayload.skills);
          statusNode.textContent = "Keys saved";
        } catch (error) {
          statusNode.textContent = error instanceof Error ? error.message : "key save failed";
        }
      });

      refreshConfigButtonNode.addEventListener("click", async () => {
        statusNode.textContent = "Refreshing config export…";

        try {
          await loadConfigExport();
          statusNode.textContent = "Config export refreshed";
        } catch (error) {
          statusNode.textContent = error instanceof Error ? error.message : "config refresh failed";
        }
      });

      configFormNode.addEventListener("submit", async (event) => {
        event.preventDefault();
        statusNode.textContent = "Importing config…";

        try {
          await fetchJson("/api/config/import", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              config: configExportNode.value,
            }),
          });

          await loadSetup();
          statusNode.textContent = "Config imported";
        } catch (error) {
          statusNode.textContent = error instanceof Error ? error.message : "config import failed";
        }
      });

      loadSetup().catch((error) => {
        statusNode.textContent = error instanceof Error ? error.message : "setup load failed";
      });
    </script>
  </body>
</html>
`;
