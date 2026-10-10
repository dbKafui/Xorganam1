import dns from 'node:dns/promises'
import ipaddr from 'ipaddr.js'

function normalizedAddress(address) {
  const parsed = typeof address === 'string' ? ipaddr.parse(address) : address
  return parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress() ? parsed.toIPv4Address() : parsed
}

function normalizedNetwork(network, prefix) {
  if (network.kind() === 'ipv6' && network.isIPv4MappedAddress() && prefix >= 96) {
    return [network.toIPv4Address(), prefix - 96]
  }
  return [network, prefix]
}

export function isSmtpAddressBlocked(address, blockedCidrs) {
  const candidate = normalizedAddress(address)
  return blockedCidrs.some((cidr) => {
    const [network, prefix] = ipaddr.parseCIDR(cidr)
    const [normalized, normalizedPrefix] = normalizedNetwork(network, prefix)
    return normalized.kind() === candidate.kind() && candidate.match(normalized, normalizedPrefix)
  })
}

export async function resolveSmtpDestination(host, policy, lookup = dns.lookup) {
  if (typeof host !== 'string' || !host.trim() || /[\s/@]/.test(host)) {
    throw new Error('SMTP host is invalid.')
  }
  const answers = await lookup(host, { all: true, verbatim: true })
  if (!Array.isArray(answers) || answers.length === 0) throw new Error('SMTP host did not resolve to an address.')
  for (const answer of answers) {
    if (!answer?.address || isSmtpAddressBlocked(answer.address, policy.blockedSmtpCidrs)) {
      throw new Error('SMTP host resolves to a blocked network.')
    }
  }
  const destination = answers[0]
  return { hostname: host, address: destination.address, family: destination.family }
}

export function createPinnedDnsLookup(destination) {
  return (_hostname, options, callback) => {
    const result = { address: destination.address, family: destination.family }
    if (options?.all) return process.nextTick(() => callback(null, [result]))
    process.nextTick(() => callback(null, result.address, result.family))
  }
}