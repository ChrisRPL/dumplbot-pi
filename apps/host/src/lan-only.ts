const SETUP_ONLY_PATHS = new Set<string>([
  "/setup",
  "/api/config",
  "/api/config/export",
  "/api/config/import",
  "/api/setup/health",
  "/api/setup/first-run",
  "/api/setup/secrets",
  "/api/setup/status",
  "/api/setup/system",
]);

const parseIpv4Octets = (address: string): number[] | null => {
  const normalizedAddress = address.startsWith("::ffff:")
    ? address.slice("::ffff:".length)
    : address;

  const parts = normalizedAddress.split(".");

  if (parts.length !== 4) {
    return null;
  }

  const octets = parts.map((part) => Number.parseInt(part, 10));

  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets;
};

export const isLanClientAddress = (address: string | null | undefined): boolean => {
  if (!address) {
    return false;
  }

  if (address === "::1" || address === "127.0.0.1") {
    return true;
  }

  const ipv4Octets = parseIpv4Octets(address);

  if (ipv4Octets) {
    const [firstOctet, secondOctet] = ipv4Octets;
    return firstOctet === 10
      || firstOctet === 127
      || (firstOctet === 192 && secondOctet === 168)
      || (firstOctet === 172 && typeof secondOctet === "number" && secondOctet >= 16 && secondOctet <= 31);
  }

  const normalizedAddress = address.toLowerCase();
  return normalizedAddress.startsWith("fc")
    || normalizedAddress.startsWith("fd")
    || normalizedAddress.startsWith("fe80:");
};

export const isLanOnlySetupPath = (pathname: string): boolean => (
  SETUP_ONLY_PATHS.has(pathname)
);
