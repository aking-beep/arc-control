import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
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
  // The result is recorded, so it carries the URL without credentials or
  // query values (invariant 8), and no finding quotes the raw URL.
  const done = (url: string, host: string, addresses: readonly string[], certificate?: EndpointVetting['certificate']): EndpointVetting => ({
    url: redact(url),
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
    fail('EP-001', 'the tool URL is not a valid URL');
    return done('', '', []);
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
  const dotted = parseIPv4(value);
  if (dotted) return classifyV4(dotted);

  if (!value.includes(':') || isIP(value) !== 6) return 'private';
  const groups = expandV6(value);
  if (!groups) return 'private';
  if (groups.every((group) => group === 0)) return 'unspecified';
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return 'private';

  // Every transition form that carries an IPv4 address is judged by that
  // address: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d), NAT64
  // (64:ff9b::/96) and 6to4 (2002::/16). Otherwise `::a9fe:a9fe` would read
  // as a public IPv6 address and reach the metadata service.
  const embedded = (high: number, low: number): number[] => [high >> 8, high & 0xff, low >> 8, low & 0xff];
  if (groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    return classifyV4(embedded(groups[6]!, groups[7]!));
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return classifyV4(embedded(groups[6]!, groups[7]!));
  }
  if (groups[0] === 0x2002) return classifyV4(embedded(groups[1]!, groups[2]!));

  const first = groups[0]!;
  if ((first & 0xffc0) === 0xfe80) return 'link-local';
  if ((first & 0xffc0) === 0xfec0) return 'private'; // deprecated site-local
  if ((first & 0xfe00) === 0xfc00) return 'private';
  if ((first & 0xff00) === 0xff00) return 'private';
  return 'public';
}

/** Eight 16-bit groups, or undefined. Accepts `::` compression and a trailing dotted IPv4. */
function expandV6(value: string): number[] | undefined {
  let text = value;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const parts = parseIPv4(dotted[1]!);
    if (!parts) return undefined;
    text = `${text.slice(0, -dotted[1]!.length)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] => (part === '' ? [] : part.split(':').map((group) => parseInt(group, 16)));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return undefined;
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? fill : 0 }, () => 0), ...tail];
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : undefined;
}

function classifyV4([a, b]: readonly number[]): AddressKind {
  if (a === 0) return 'unspecified';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 10 || a === 127) return 'private';
  if (a === 172 && b! >= 16 && b! <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 100 && b! >= 64 && b! <= 127) return 'private';
  if (a === 198 && (b === 18 || b === 19)) return 'private';
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
  if (v4) return v4[0] === 127;
  const groups = expandV6(value);
  return groups !== undefined && groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
}

/** The URL without credentials, query values or fragment. Unparseable input is not echoed. */
function redact(value: string): string {
  if (value === '') return '';
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = 'redacted';
      url.password = '';
    }
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, 'redacted');
    url.hash = '';
    return url.toString();
  } catch {
    return '[unparseable url]';
  }
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

  // The HEAD goes to the same vetted address as the handshake. Letting it
  // resolve the name again would let a rebinding DNS answer send it to an
  // address that was never classified.
  const head = await new Promise<{ status: number; location?: string }>((resolve, reject) => {
    const pinned = addresses[0]!;
    const family = isIP(pinned) === 6 ? 6 : 4;
    const issue = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = issue(
      url,
      {
        method: 'HEAD',
        timeout: 10_000,
        lookup: ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) =>
          options?.all ? callback(null, [{ address: pinned, family }]) : callback(null, pinned, family)) as never,
        ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
      },
      (response) => {
        const location = response.headers.location;
        response.resume();
        resolve({ status: response.statusCode ?? 0, ...(typeof location === 'string' ? { location } : {}) });
      },
    );
    request.once('timeout', () => request.destroy(new Error('HEAD request timed out')));
    request.once('error', reject);
    request.end();
  });
  return { ...(tls ? { tls } : {}), status: head.status, ...(head.location ? { location: head.location } : {}) };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
