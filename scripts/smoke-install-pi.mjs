#!/usr/bin/env node

import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const runSmoke = async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "dumplbot-install-smoke-"));
  const fakeBin = join(tmpRoot, "fake-bin");
  const installRoot = join(tmpRoot, "install");
  const configRoot = join(tmpRoot, "config");
  const systemdRoot = join(tmpRoot, "systemd");
  const healthcheckPath = join(tmpRoot, "dumplbot-healthcheck");
  const serviceUser = process.env.USER || "unknown";

  try {
    await chmod(fakeBin, 0o755).catch(() => {});
  } catch {}

  const mkdirResult = spawnSync("mkdir", ["-p", fakeBin], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  if (mkdirResult.status !== 0) {
    throw new Error(`mkdir failed: ${mkdirResult.stderr || mkdirResult.stdout}`);
  }

  const fakeBwrapPath = join(fakeBin, "bwrap");
  const fakeBwrapResult = spawnSync(
    "bash",
    ["-lc", `printf '#!/usr/bin/env bash\nexit 0\n' > "${fakeBwrapPath}" && chmod +x "${fakeBwrapPath}"`],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  if (fakeBwrapResult.status !== 0) {
    throw new Error(`fake bwrap setup failed: ${fakeBwrapResult.stderr || fakeBwrapResult.stdout}`);
  }

  const result = spawnSync(
    "bash",
    ["scripts/install_pi.sh"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        DUMPLBOT_INSTALL_ROOT: installRoot,
        DUMPLBOT_CONFIG_ROOT: configRoot,
        DUMPLBOT_TMP_ROOT: join(tmpRoot, "tmp"),
        DUMPLBOT_SYSTEMD_ROOT: systemdRoot,
        DUMPLBOT_HEALTHCHECK_PATH: healthcheckPath,
        DUMPLBOT_SKIP_APT_BOOTSTRAP: "1",
        DUMPLBOT_SKIP_NPM_BUILD: "1",
        DUMPLBOT_SKIP_SYSTEMCTL: "1",
        DUMPLBOT_ALLOW_UNPRIVILEGED: "1",
        DUMPLBOT_SERVICE_USER: serviceUser,
      },
    },
  );

  if (result.status !== 0) {
    throw new Error(`install_pi.sh failed: ${result.stderr || result.stdout}`);
  }

  const configYaml = await readFile(join(configRoot, "config.yaml"), "utf8");
  const secretsEnv = await readFile(join(configRoot, "secrets.env"), "utf8");
  const daemonUnit = await readFile(join(systemdRoot, "dumplbotd.service"), "utf8");
  const uiUnit = await readFile(join(systemdRoot, "dumpl-ui.service"), "utf8");
  const healthcheckStats = await stat(healthcheckPath);

  assert(configYaml.includes("server:"), "expected config.yaml to be installed");
  assert(secretsEnv === "", "expected empty secrets.env to be created");
  assert(daemonUnit.includes(`User=${serviceUser}`), "expected daemon service user to be templated");
  assert(uiUnit.includes(`User=${serviceUser}`), "expected ui service user to be templated");
  assert(
    daemonUnit.includes(`Environment=DUMPLBOT_CONFIG_PATH=${configRoot}/config.yaml`),
    "expected daemon config env to be templated",
  );
  assert(
    uiUnit.includes(`Environment=DUMPLBOT_TMP_ROOT=${join(tmpRoot, "tmp")}`),
    "expected ui tmp env to be templated",
  );
  assert((healthcheckStats.mode & 0o111) !== 0, "expected healthcheck to be executable");
  assert(result.stdout.includes("install complete"), "expected install completion output");
  assert(result.stdout.includes(`service user: ${serviceUser}`), "expected service user in output");
  assert(result.stdout.includes("/setup"), "expected setup URL in output");

  await rm(tmpRoot, { recursive: true, force: true });
};

runSmoke().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
