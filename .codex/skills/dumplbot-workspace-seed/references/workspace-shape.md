# Workspace Shape

- README points to `workspaces/<name>/CLAUDE.md` for workspace-level instructions.
- A baseline seed should define: workspace goal, repo roots, allowed tools, permission mode, default skill, and scheduler defaults.
- Favor least privilege and explicit tool allowlists.
- Add scheduler jobs only when the output path and owner are clear.
- If the `workspaces/` tree is absent, scaffold docs and note the missing daemon hooks before assuming runtime support.
