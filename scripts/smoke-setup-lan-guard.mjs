#!/usr/bin/env node

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isLanClientAddress, isLanOnlySetupPath } = require("../dist/apps/host/src/lan-only.js");

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const allowedAddresses = [
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "10.0.0.8",
  "::ffff:10.0.0.8",
  "192.168.1.22",
  "::ffff:192.168.1.22",
  "172.16.4.9",
  "172.31.255.254",
  "fc00::42",
  "fd12::abcd",
  "fe80::1234",
];

const deniedAddresses = [
  null,
  undefined,
  "8.8.8.8",
  "::ffff:8.8.8.8",
  "172.15.0.1",
  "172.32.0.1",
  "2001:4860:4860::8888",
];

for (const address of allowedAddresses) {
  assert(isLanClientAddress(address) === true, `expected ${address} to be LAN-allowed`);
}

for (const address of deniedAddresses) {
  assert(isLanClientAddress(address) === false, `expected ${String(address)} to be LAN-denied`);
}

assert(isLanOnlySetupPath("/setup") === true, "expected /setup to be LAN-only");
assert(isLanOnlySetupPath("/api/config") === true, "expected /api/config to be LAN-only");
assert(isLanOnlySetupPath("/api/config/export") === true, "expected /api/config/export to be LAN-only");
assert(isLanOnlySetupPath("/api/config/import") === true, "expected /api/config/import to be LAN-only");
assert(isLanOnlySetupPath("/api/setup/status") === true, "expected /api/setup/status to be LAN-only");
assert(isLanOnlySetupPath("/api/workspaces") === false, "expected /api/workspaces to remain outside setup-only guard");

console.log("setup lan guard smoke ok");
