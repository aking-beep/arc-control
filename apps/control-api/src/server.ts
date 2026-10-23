import { createServer, type Server } from 'node:http';
import { Gateway } from '@arc-control/gateway';
import type { ControlStore } from '@arc-control/store';
import { buildRoutes } from './routes.js';
import { OperatorAuth } from './operator.js';

export const API_VERSION = '0.1.0';

export interface ControlApiOptions {
  readonly store: ControlStore;
  readonly operatorToken?: string;
  readonly defaultOrganizationId?: string;
  readonly defaultEnvironment?: string;
  /**
   * True when this API was started with the worked example loaded. Reported on
   * `/health` so the console can label the environment as a demonstration
   * rather than leaving an operator to guess whether the records in front of
   * them describe their own systems.
   */
  readonly demoSeed?: boolean;
}

export interface ControlApi {
  readonly gateway: Gateway;
  readonly server: Server;
  listen(port: number, host?: string): Promise<{ port: number; host: string }>;
  close(): Promise<void>;
}

/**
 * Builds the control API around a gateway. Exposed as a function rather than
 * only a binary so tests and examples can drive the real HTTP surface in
 * process, against the real gateway.
 */
export function createControlApi(options: ControlApiOptions): ControlApi {
  const gateway = new Gateway({
    store: options.store,
    ...(options.defaultOrganizationId ? { defaultOrganizationId: options.defaultOrganizationId } : {}),
    ...(options.defaultEnvironment ? { defaultEnvironment: options.defaultEnvironment } : {}),
  });

  const operators = new OperatorAuth(options.operatorToken ? { token: options.operatorToken } : {});
  const router = buildRoutes({
    gateway,
    operators,
    version: API_VERSION,
    demoSeed: options.demoSeed === true,
  });

  const server = createServer((request, response) => {
    void router.handle(request, response).catch((cause: unknown) => {
      // The router handles its own errors; reaching here means the response
      // itself failed, so there is nothing left to tell the client.
      process.stderr.write(`arc-control: unrecoverable request failure: ${String(cause)}\n`);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  return {
    gateway,
    server,
    listen: (port, host = '127.0.0.1') =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          const actual = typeof address === 'object' && address ? address.port : port;
          resolve({ port: actual, host });
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((cause) => (cause ? reject(cause) : resolve()));
      }),
  };
}
