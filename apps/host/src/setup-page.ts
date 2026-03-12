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

      select, button {
        width: 100%;
        border-radius: 0.9rem;
        border: 1px solid var(--border);
        padding: 0.8rem 0.9rem;
        font: inherit;
      }

      select { background: white; }

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
          and provider keys are configured.
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
        </div>
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
      const formNode = document.querySelector("#setup-form");

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

      const loadSetup = async () => {
        statusNode.textContent = "Loading setup…";

        const [configPayload, workspacePayload, skillPayload, setupStatusPayload] = await Promise.all([
          fetchJson("/api/config"),
          fetchJson("/api/workspaces"),
          fetchJson("/api/skills"),
          fetchJson("/api/setup/status"),
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

        safetySelect.value = configPayload.runtime.safety_mode;
        activeWorkspaceNode.textContent = configPayload.runtime.active_workspace || "default fallback";
        activeSkillNode.textContent = configPayload.runtime.active_skill || "default fallback";
        secretsFileStatusNode.textContent = formatConfiguredStatus(
          setupStatusPayload.secrets.secrets_file_present,
        );
        openAiKeyStatusNode.textContent = formatConfiguredStatus(
          setupStatusPayload.secrets.openai_api_key_configured,
        );
        anthropicKeyStatusNode.textContent = formatConfiguredStatus(
          setupStatusPayload.secrets.anthropic_api_key_configured,
        );
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

      loadSetup().catch((error) => {
        statusNode.textContent = error instanceof Error ? error.message : "setup load failed";
      });
    </script>
  </body>
</html>
`;
