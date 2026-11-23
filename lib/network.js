'use strict';

const net = require('net');
const os = require('os');

// Interfaces that are never the household LAN: containers, VMs, VPNs, Apple
// peer-to-peer links, Internet Sharing bridges.
const VIRTUAL = /^(docker|br-|veth|virbr|vmnet|vboxnet|utun|tun|tap|zt|tailscale|wg|llw|awdl|anpi|bridge|gif|stf|vethernet)|virtual|vmware|hyper-v|wsl|vpn/i;
const PREFERRED = /^(en|eth|wl|wlan|wi-?fi|ethernet)/i;

/**
 * @typedef {{ name: string, address: string, netmask: string }} LanInterface
 */

/**
 * @param {NodeJS.Dict<os.NetworkInterfaceInfo[]>} [nets]
 * @returns {LanInterface[]}
 */
function lanInterfaces(nets = os.networkInterfaces()) {
  /** @type {LanInterface[]} */
  const found = [];
  for (const [name, entries] of Object.entries(nets)) {
    if (VIRTUAL.test(name)) continue;
    for (const entry of entries || []) {
      const family = /** @type {string | number} */ (entry.family);
      const v4 = family === 'IPv4' || family === 4;
      if (!v4 || entry.internal || entry.address.startsWith('169.254.')) continue;
      if (found.some((item) => item.address === entry.address)) continue;
      found.push({ name, address: entry.address, netmask: entry.netmask });
    }
  }
  return found.sort((a, b) => Number(PREFERRED.test(b.name)) - Number(PREFERRED.test(a.name)));
}

/** @param {NodeJS.Dict<os.NetworkInterfaceInfo[]>} [nets] */
function lanIPv4s(nets) {
  return lanInterfaces(nets).map((item) => item.address);
}

/** @param {string} ip */
function toInt(ip) {
  return ip.split('.').reduce((total, part) => total * 256 + Number(part), 0);
}

/**
 * @param {string} ip
 * @param {LanInterface} iface
 */
function sameSubnet(ip, iface) {
  if (!net.isIPv4(ip) || !net.isIPv4(iface.netmask)) return false;
  const mask = toInt(iface.netmask);
  // Bitwise AND works on int32, so bring both sides back to unsigned.
  return ((toInt(ip) & mask) >>> 0) === ((toInt(iface.address) & mask) >>> 0);
}

/** @param {string} ip */
function usableAddress(ip) {
  return net.isIPv4(ip) && !ip.startsWith('127.') && !ip.startsWith('169.254.');
}

/**
 * Networks trusted beyond this computer's own LAN subnets, from AUDIOLAN_ALLOW:
 * comma-separated IPv4 addresses or CIDRs (`10.0.0.0/8`), or `any` to turn the
 * check off. Throws on anything else, so a typo does not silently open the room.
 * @typedef {{ any: boolean, cidrs: { base: number, mask: number }[] }} Allow
 * @param {string | undefined} text
 * @returns {Allow}
 */
function parseAllow(text) {
  /** @type {Allow} */
  const allow = { any: false, cidrs: [] };
  for (const part of String(text || '').split(',').map((item) => item.trim()).filter(Boolean)) {
    if (/^any$/i.test(part)) {
      allow.any = true;
      continue;
    }
    const match = /^([\d.]+)(?:\/(\d{1,2}))?$/.exec(part);
    const bits = match ? Number(match[2] ?? 32) : NaN;
    if (!match || !net.isIPv4(match[1]) || bits > 32) {
      throw new Error(`AUDIOLAN_ALLOW: "${part}" is not an IPv4 address, a CIDR, or "any".`);
    }
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    allow.cidrs.push({ base: (toInt(match[1]) & mask) >>> 0, mask });
  }
  return allow;
}

/** @type {Allow} */
const NO_EXTRA = { any: false, cidrs: [] };

/**
 * On this household's network: a subnet of one of this computer's LAN
 * interfaces, or a network named in AUDIOLAN_ALLOW.
 * @param {string} ip
 * @param {LanInterface[]} ifaces
 * @param {Allow} [allow]
 */
function onNetwork(ip, ifaces, allow = NO_EXTRA) {
  if (!net.isIPv4(ip)) return false;
  if (allow.any) return true;
  if (ifaces.some((iface) => sameSubnet(ip, iface))) return true;
  const value = toInt(ip);
  return allow.cidrs.some(({ base, mask }) => ((value & mask) >>> 0) === base);
}

/**
 * May this peer talk to the server at all? This computer, or a device on its
 * network. A VPN peer, a container or a port-forward from the internet is not.
 * @param {string | undefined} address the socket's remoteAddress
 * @param {LanInterface[]} ifaces
 * @param {Allow} [allow]
 */
function trustedPeer(address, ifaces, allow = NO_EXTRA) {
  const ip = String(address || '').replace(/^::ffff:/i, '');
  if (ip === '::1' || (net.isIPv4(ip) && ip.startsWith('127.'))) return true;
  return onNetwork(ip, ifaces, allow);
}

/**
 * Pick the address of a remote machine on this network. An address anywhere
 * else is never used, so an announcement cannot point the room at the internet.
 * @param {string[]} addrs
 * @param {LanInterface[]} ifaces
 * @param {Allow} [allow]
 */
function pickAddress(addrs, ifaces, allow = NO_EXTRA) {
  const usable = addrs.filter(usableAddress);
  return usable.find((ip) => ifaces.some((iface) => sameSubnet(ip, iface)))
    || usable.find((ip) => onNetwork(ip, ifaces, allow))
    || '';
}

module.exports = { lanInterfaces, lanIPv4s, sameSubnet, pickAddress, usableAddress, parseAllow, onNetwork, trustedPeer };
