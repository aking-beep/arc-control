import { lookup } from 'node:dns/promises';
import { connect, type PeerCertificate } from 'node:tls';

/**
 * Endpoint vetting at registration, ported from the Connectivity Scanner
 * (ADR-0002).
 *
 * The connector's host allowlist decides which **names** a tool may reach.
 * This decides whether what answers at that name is fit to hold credentials
 * and be driven by an agent: that it is HTTPS, that it does not resolve to a
 * link-local or metadata address (or to a private one nobody approved), that
 * its certificate is valid and not about to lapse, and that it does not
 * redirect somewhere else.
 *
 * It is a point-in-time check. DNS can change after registration, which is
 * why the connector's own checks — allowlist on the final URL, HTTPS, refusing
 * redirects — still run on every call.
 */

export type VettingSeverity = 'error' | 'warning';

export interface VettingFinding {
  readonly id: string;
  readonly severity: VettingSeverity;
  readonly detail: string;
}

export interface EndpointVetting {
  readonly url: string;
  readonly host: string;
  readonly ok: boolean;
  readonly findings: readonly VettingFinding[];
  readonly addresses: readonly string[];
  readonly certificate?: { readonly validTo: string; readonly daysRemaining: number; readonly subject?: string };
  readonly vettedAt: string;
}

/** What a probe of the live endpoint observed. Injected in tests. */
export interface EndpointProbe {
  /** The TLS handshake, for HTTPS endpoints. */
  readonly tls?: {
    /** Whether the certificate chain verified against the trust store and matched the host. */
    readonly authorized: boolean;
    readonly authorizationError?: string;
    readonly validTo?: string;
    readonly subject?: string;
  };
  /** Status of an unauthenticated HEAD to the endpoint, redirects not followed. */
  readonly status?: number;
  readonly location?: string;
}

export interface VetOptions {
  /** Resolves a host to addresses. Defaults to the system resolver. */
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  /** Probes the endpoint. Defaults to a real TLS handshake and HEAD request. */
  readonly probe?: (url: URL, addresses: readonly string[]) => Promise<EndpointProbe>;
  /** Hosts allowed to resolve to private (RFC 1918, unique-local, loopback) addresses. Never link-local. */
  readonly allowPrivateHosts?: readonly string[];
  /** A certificate expiring sooner than this many days is refused. Defaults to 14. */
  readonly minimumCertificateDays?: number;
  readonly now?: () => Date;
}

const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata', 'instance-data', 'metadata.azure.com']);

/**
 * Vets the endpoint a `generic-http` tool's URL template points at.
 *
 * Placeholders are path-only by construction (the connector never templates
 * the host), so they are filled with a neutral value to read the host.
 */
export async function vetEndpoint(urlTemplate: string, options: VetOptions = {}): Promise<EndpointVetting> {
  const now = options.now ?? (() => new Date());
  const findings: VettingFinding[] = [];
  const fail = (id: string, detail: string): void => void findings.push({ id, severity: 'error', detail });
  const warn = (id: string, detail: string): void => void findings.push({ id, severity: 'warning', detail });
  const done = (url: string, host: string, addresses: readonly string[], certificate?: EndpointVetting['certificate']): EndpointVetting => ({
    url,
    host,
    ok: findings.every((finding) => finding.severity !== 'error'),
    findings,
    addresses,
    ...(certificate ? { certificate } : {}),
    vettedAt: now().toISOString(),
  });

  let url: URL;
  try {
    url = new URL(String(urlTemplate).replace(/\{[A-Za-z0-9_]+\}/g, 'x'));
  } catch {
    fail('EP-001', `"${String(urlTemplate)}" is not a valid URL`);
    return done(String(urlTemplate), '', []);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    fail('EP-001', `${url.protocol} is not an HTTP scheme`);
    return done(url.toString(), host, []);
  }
  if (url.username || url.password) fail('EP-001', 'the URL embeds credentials; put them in connector headers instead');

  if (METADATA_HOSTS.has(host) || (host.endsWith('.internal') && host.startsWith('metadata'))) {
    fail('EP-003', `${host} is a cloud metadata endpoint`);
    return done(url.toString(), host, []);
  }

  let addresses: readonly string[];
  try {
    addresses = isIpLiteral(host) ? [host] : await (options.resolve ?? systemResolve)(host);
  } catch (cause) {
    fail('EP-002', `${host} did not resolve: ${describe(cause)}`);
    return done(url.toString(), host, []);
  }
  if (addresses.length === 0) {
    fail('EP-002', `${host} resolved to no addresses`);
    return done(url.toString(), host, []);
  }

  const privateAllowed = (options.allowPrivateHosts ?? []).map((entry) => entry.toLowerCase()).includes(host);
  for (const address of addresses) {
    const kind = classifyAddress(address);
    if (kind === 'link-local' || kind === 'unspecified') {
      fail('EP-003', `${host} resolves to ${address}, a ${kind} address — the shape of a metadata-service request`);
    } else if (kind === 'private' && !privateAllowed) {
      fail('EP-003', `${host} resolves to private address ${address}; list it in allowPrivateHosts if it is a sanctioned internal API`);
    }
  }

  const loopbackOnly = addresses.every((address) => classifyAddress(address) === 'private' && isLoopbackAddress(address));
  if (url.protocol === 'http:' && !loopbackOnly) {
    fail('EP-004', `${host} is reached over plaintext HTTP; the connector carries credentials and agent-chosen parameters`);
  }
  if (findings.some((finding) => finding.severity === 'error')) return done(url.toString(), host, addresses);

  let probe: EndpointProbe;
  try {
    probe = await (options.probe ?? systemProbe)(url, addresses);
  } catch (cause) {
    fail('EP-005', `${host} could not be probed: ${describe(cause)}`);
    return done(url.toString(), host, addresses);
  }

  let certificate: EndpointVetting['certificate'];
  if (url.protocol === 'https:') {
    if (!probe.tls) {
      fail('EP-005', `no TLS handshake was observed for ${host}`);
    } else {
      if (!probe.tls.authorized) {
        fail('EP-005', `${host} presented a certificate that did not verify${probe.tls.authorizationError ? `: ${probe.tls.authorizationError}` : ''}`);
      }
      const validTo = probe.tls.validTo === undefined ? Number.NaN : Date.parse(probe.tls.validTo);
      if (Number.isNaN(validTo)) {
        fail('EP-006', `${host} presented a certificate with no readable expiry`);
      } else {
        const daysRemaining = Math.floor((validTo - now().getTime()) / 86_400_000);
        certificate = {
          validTo: new Date(validTo).toISOString(),
          daysRemaining,
          ...(probe.tls.subject ? { subject: probe.tls.subject } : {}),
        };
        const minimum = options.minimumCertificateDays ?? 14;
        if (daysRemaining < 0) fail('EP-006', `${host}'s certificate expired ${-daysRemaining} day(s) ago`);
        else if (daysRemaining < minimum) fail('EP-006', `${host}'s certificate expires in ${daysRemaining} day(s), under the ${minimum}-day minimum`);
      }
    }
  }

  if (probe.status !== undefined && probe.status >= 300 && probe.status < 400) {
    let target: URL | undefined;
    try {
      target = probe.location ? new URL(probe.location, url) : undefined;
    } catch {
      target = undefined;
    }
    if (!target || target.hostname.toLowerCase() !== host) {
      fail('EP-007', `${host} redirects to ${target?.hostname ?? 'an unreadable location'}; the connector refuses redirects, so every call would fail or leave the allowed host`);
    } else if (target.protocol !== 'https:' && url.protocol === 'https:') {
      fail('EP-007', `${host} redirects from HTTPS to ${target.protocol}`);
    } else {
      warn('EP-007', `${host} redirects within the same host (${target.pathname}); the connector will refuse it at call time — point the tool at the final path`);
    }
  }

  return done(url.toString(), host, addresses, certificate);
}

type AddressKind = 'public' | 'private' | 'link-local' | 'unspecified';

/** Classifies an IPv4 or IPv6 address. Anything unparseable is treated as private: fail closed. */
export function classifyAddress(address: string): AddressKind {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = parseIPv4(value);
  if (v4) return classifyV4(v4);

  if (!value.includes(':')) return 'private';
  if (value === '::') return 'unspecified';
  if (value === '::1') return 'private';
  const mapped = mappedV4(value);
  if (mapped) return classifyV4(mapped);
  const first = parseInt(value.split(':')[0] || '0', 16);
  if (Number.isNaN(first)) return 'private';
  if ((first & 0xffc0) === 0xfe80) return 'link-local';
  if ((first & 0xfe00) === 0xfc00) return 'private';
  if ((first & 0xff00) === 0xff00) return 'private';
  return 'public';
}

function classifyV4([a, b]: readonly number[]): AddressKind {
  if (a === 0) return 'unspecified';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 10 || a === 127) return 'private';
  if (a === 172 && b! >= 16 && b! <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 100 && b! >= 64 && b! <= 127) return 'private';
  if (a! >= 224) return 'private';
  return 'public';
}

function parseIPv4(value: string): number[] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return undefined;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part <= 255) ? parts : undefined;
}

/** `::ffff:a.b.c.d` and `::ffff:7f00:1` both carry an IPv4 address. */
function mappedV4(value: string): number[] | undefined {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (dotted) return parseIPv4(dotted[1]!);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (!hex) return undefined;
  const high = parseInt(hex[1]!, 16);
  const low = parseInt(hex[2]!, 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isLoopbackAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = parseIPv4(value) ?? mappedV4(value);
  return value === '::1' || (v4 !== undefined && v4[0] === 127);
}

function isIpLiteral(host: string): boolean {
  return parseIPv4(host) !== undefined || host.includes(':');
}

async function systemResolve(host: string): Promise<readonly string[]> {
  return (await lookup(host, { all: true })).map((record) => record.address);
}

/**
 * The real probe: a TLS handshake to the first resolved address with the
 * hostname as SNI, then a HEAD request with redirects left unfollowed.
 */
async function systemProbe(url: URL, addresses: readonly string[]): Promise<EndpointProbe> {
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const tls =
    url.protocol === 'https:'
      ? await new Promise<NonNullable<EndpointProbe['tls']>>((resolve, reject) => {
          const socket = connect({ host: addresses[0], port, servername: url.hostname, rejectUnauthorized: false, timeout: 10_000 });
          socket.once('secureConnect', () => {
            const certificate: PeerCertificate = socket.getPeerCertificate();
            resolve({
              authorized: socket.authorized,
              ...(socket.authorizationError ? { authorizationError: String(socket.authorizationError) } : {}),
              ...(certificate?.valid_to ? { validTo: certificate.valid_to } : {}),
              ...(certificate?.subject?.CN ? { subject: String(certificate.subject.CN) } : {}),
            });
            socket.end();
          });
          socket.once('timeout', () => socket.destroy(new Error('TLS handshake timed out')));
          socket.once('error', reject);
        })
      : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: controller.signal });
    const location = response.headers.get('location');
    return { ...(tls ? { tls } : {}), status: response.status, ...(location ? { location } : {}) };
  } finally {
    clearTimeout(timer);
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
