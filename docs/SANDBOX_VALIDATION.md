# Sandbox Validation

Use this note when validating the `bwrap` sandbox before final Pi bring-up.

## What macOS Can Prove

On native macOS, run:

```bash
npm run smoke:runner-sandbox-local
```

Expected result:

- `runner launch builder smoke ok`
- `runner sandbox launch smoke ok`
- `runner sandbox fs smoke skipped`
- `runner sandbox net smoke skipped`
- `runner sandbox local smoke ok`

This proves:

- host builds the expected `bwrap` launch command
- network unshare and mount shape are present in the launch args
- missing-`bwrap` failure path is surfaced cleanly

This does **not** prove:

- real `bubblewrap` mount isolation
- real network denial
- Linux user-namespace behavior
- systemd hardening

## What Linux VM Should Prove

On a small Linux VM on the Mac, install `bwrap`, then run:

```bash
npm run smoke:runner-sandbox-local
```

Expected result:

- all local sandbox smokes pass
- filesystem smoke proves workspace-only file access
- network smoke proves sandboxed runner cannot reach a host TCP listener

This is the closest local pre-Pi proof.

## What Pi Must Still Prove

On the Raspberry Pi Zero 2 WH, run:

```bash
npm run smoke:runner-sandbox-local
```

Then keep the final target checks:

- end-to-end voice path still works under sandbox
- attached repos are reachable, outside paths are denied
- scheduler-triggered runs behave the same as manual runs
- memory/latency stay acceptable on target hardware

The filesystem smoke now covers three cases on Linux/Pi:

- workspace-local file read succeeds
- attached repo read through `repos/<id>/...` succeeds after the real attach route runs
- outside-path read fails inside the sandbox
