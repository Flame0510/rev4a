'use strict';
/**
 * Where Rev4a listens (SEC-9B). Pure functions, no I/O: server.js reads the host (network
 * interfaces, the Docker bridge gateway) and the agent code reads the setting, then both ask
 * these functions what to do. CommonJS because server.js is.
 *
 *   REV4A_LISTEN              the panel:  all (default) | local | <one IP address>
 *   REV4A_AGENT_PORTS_LISTEN  agent ports: all (default) | local | <one IP address>
 *
 * Never expose more than asked: a value that cannot be honoured falls back to `local`.
 */
const net = require('net');

const LOOPBACK_V4 = '127.0.0.1';
const LOOPBACK_V6 = '::1';

/** Lower-case, trimmed, no brackets, so `[::1]` and `::1` compare equal. */
function normaliseAddress(value) {
  return String(value ?? '').trim().replace(/^\[(.*)\]$/, '$1').toLowerCase();
}

function isWildcard(address) {
  return address === '0.0.0.0' || address === '::';
}

/** What a setting asks for, before the host is looked at: all | local | address | invalid. */
function parseSetting(value) {
  const text = String(value ?? '').trim();
  if (text === '' || text.toLowerCase() === 'all') return { kind: 'all' };
  if (text.toLowerCase() === 'local') return { kind: 'local' };
  const address = normaliseAddress(text);
  if (net.isIP(address) && !isWildcard(address)) return { kind: 'address', address };
  return { kind: 'invalid', text };
}

/**
 * The panel's listeners.
 *
 * @param value REV4A_LISTEN as written (undefined when unset)
 * @param host `platform` (process.platform), `gateway` (the Docker bridge gateway, null when unknown),
 *   `hasIpv6` (the host can bind ::1), `hostAddresses` (every address of the host's interfaces)
 * @returns `mode` (all | local | address), `address` (the one IP asked for, in `address` mode), `addresses` (empty for `all`: one wildcard listener),
 *   `warnings` and `errors` (strings to log)
 */
function listenAddresses(value, host = {}) {
  const platform = host.platform ?? process.platform;
  const gateway = host.gateway ? normaliseAddress(host.gateway) : null;
  const hostAddresses = new Set((host.hostAddresses ?? []).map(normaliseAddress));
  const warnings = [];
  const errors = [];

  const setting = parseSetting(value);
  if (setting.kind === 'all') return { mode: 'all', address: null, addresses: [], warnings, errors };

  let mode = 'local';
  let wanted = null;
  if (setting.kind === 'invalid') {
    warnings.push(`REV4A_LISTEN="${setting.text}" is not "all", "local" or an IP address: listening on this host only (local)`);
  } else if (setting.kind === 'address') {
    if (hostAddresses.has(setting.address)) {
      mode = 'address';
      wanted = setting.address;
    } else {
      errors.push(`REV4A_LISTEN=${setting.address}: this host has no such address; listening on this host only (local)`);
    }
  }

  const addresses = [LOOPBACK_V4];
  if (host.hasIpv6) addresses.push(LOOPBACK_V6);
  if (wanted) addresses.push(wanted);
  // Agents reach the panel (the model) at host.docker.internal, which on Linux is the default
  // bridge gateway. Docker Desktop reaches the host's loopback instead.
  if (platform === 'linux') {
    if (gateway && net.isIP(gateway)) addresses.push(gateway);
    else warnings.push('REV4A_LISTEN: the Docker host-gateway address was not found, so agents cannot reach the panel (their model) until Rev4a is restarted with Docker running');
  }
  return { mode, address: wanted, addresses: [...new Set(addresses)], warnings, errors };
}

/** The first IPv4 gateway among every IPAM config of Docker's default bridge (`GET /networks/bridge`), or null. */
function gatewayFromBridge(network) {
  const configs = network && network.IPAM && Array.isArray(network.IPAM.Config) ? network.IPAM.Config : [];
  for (const config of configs) {
    const gateway = config && config.Gateway;
    if (typeof gateway === 'string' && net.isIPv4(gateway)) return gateway;
  }
  return null;
}

/** The docker0 interface's IPv4 address from `os.networkInterfaces()`, or null: the gateway when Docker does not answer. */
function docker0Address(interfaces) {
  const list = interfaces && Array.isArray(interfaces.docker0) ? interfaces.docker0 : [];
  const found = list.find((i) => i && (i.family === 'IPv4' || i.family === 4) && net.isIPv4(i.address));
  return found ? found.address : null;
}

/** Every address of the host's interfaces, from `os.networkInterfaces()`. */
function hostAddressList(interfaces) {
  return Object.values(interfaces || {}).flat().filter(Boolean).map((i) => i.address);
}

/** Loopback always exists; any other address must be on an interface of this host. */
function hostHasAddress(address, hostAddresses) {
  const ip = normaliseAddress(address);
  if (ip === LOOPBACK_V6 || /^127(?:\.\d{1,3}){3}$/.test(ip)) return true;
  return (hostAddresses || []).some((a) => normaliseAddress(a) === ip);
}

/** The addresses `-p` arguments publish on (`-p 10.0.0.5:3700:3000`, `-p [::1]:3700:3000`); none for a wildcard. */
function hostIpsFromPortArgs(portArgs) {
  const ips = [];
  for (let i = 0; i < portArgs.length - 1; i++) {
    if (portArgs[i] !== '-p') continue;
    const spec = String(portArgs[i + 1] || '').replace(/\/(?:tcp|udp)$/, '');
    const v6 = spec.match(/^\[([^\]]+)\]:/);
    if (v6) { ips.push(v6[1]); continue; }
    const parts = spec.split(':');
    if (parts.length === 3 && net.isIPv4(parts[0])) ips.push(parts[0]);
  }
  return ips.filter((ip) => !isWildcard(normaliseAddress(ip)));
}

/** `host:port` for a log line or a URL: IPv6 in brackets. */
function formatHostPort(address, port) {
  return net.isIPv6(address) ? `[${address}]:${port}` : `${address}:${port}`;
}

/**
 * The host IP agent ports are published on, from REV4A_AGENT_PORTS_LISTEN.
 * `hostIp` null means every interface (the Docker default: no IP in `-p`).
 */
function agentPortsListen(value, hostAddresses) {
  const setting = parseSetting(value);
  // Unset keeps each binding as it is (hostIp null); an explicit `all` moves every binding back to every
  // interface (hostIp '', the wildcard), so an agent moved to `local` can be brought back from the app.
  if (setting.kind === 'all') {
    const explicit = String(value ?? '').trim().toLowerCase() === 'all';
    return { mode: 'all', hostIp: explicit ? '' : null, warnings: [] };
  }
  if (setting.kind === 'address') {
    // An address this host lacks would make `docker run` fail after the old container is gone: never exposed more, never fail.
    if (hostAddresses && !hostHasAddress(setting.address, hostAddresses)) {
      return { mode: 'local', hostIp: LOOPBACK_V4, warnings: [`REV4A_AGENT_PORTS_LISTEN=${setting.address}: this host has no such address; agent ports are published on 127.0.0.1 only (local)`] };
    }
    return { mode: 'address', hostIp: setting.address, warnings: [] };
  }
  const warnings = setting.kind === 'invalid'
    ? [`REV4A_AGENT_PORTS_LISTEN="${setting.text}" is not "all", "local" or an IP address: agent ports are published on 127.0.0.1 only (local)`]
    : [];
  return { mode: 'local', hostIp: LOOPBACK_V4, warnings };
}

module.exports = {
  listenAddresses, gatewayFromBridge, docker0Address, hostAddressList, hostHasAddress, hostIpsFromPortArgs,
  formatHostPort, agentPortsListen, parseSetting,
};
