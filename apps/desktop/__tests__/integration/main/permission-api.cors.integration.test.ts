import type http from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalAllowedOrigins = process.env.PERMISSION_API_ALLOWED_ORIGINS;

async function waitForServerListening(server: http.Server): Promise<void> {
  if (server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function loadPermissionApiWithOrigins(allowedOrigins?: string) {
  if (allowedOrigins === undefined) {
    delete process.env.PERMISSION_API_ALLOWED_ORIGINS;
  } else {
    process.env.PERMISSION_API_ALLOWED_ORIGINS = allowedOrigins;
  }

  vi.resetModules();
  return import('@main/permission-api');
}

async function startTestServer(allowedOrigins?: string): Promise<{
  server: http.Server;
  baseUrl: string;
}> {
  const { startPermissionApiServer } = await loadPermissionApiWithOrigins(allowedOrigins);
  const server = startPermissionApiServer(0);
  await waitForServerListening(server);

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Permission API test server did not bind to a TCP port');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

describe.sequential('Permission API CORS Regression', () => {
  afterEach(async () => {
    if (originalAllowedOrigins === undefined) {
      delete process.env.PERMISSION_API_ALLOWED_ORIGINS;
    } else {
      process.env.PERMISSION_API_ALLOWED_ORIGINS = originalAllowedOrigins;
    }
    vi.resetModules();
  });

  it('accepts allowlisted browser origins and echoes a specific origin header', async () => {
    const allowlistedOrigin = 'https://app.example';
    const { server, baseUrl } = await startTestServer(allowlistedOrigin);

    try {
      const response = await fetch(`${baseUrl}/permission`, {
        method: 'OPTIONS',
        headers: {
          Origin: allowlistedOrigin,
          'Access-Control-Request-Method': 'POST',
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe(allowlistedOrigin);
      expect(response.headers.get('vary')).toContain('Origin');
      expect(response.headers.get('access-control-allow-origin')).not.toBe('*');
    } finally {
      await closeServer(server);
    }
  });

  it('rejects non-allowlisted origins and omits Access-Control-Allow-Origin', async () => {
    const { server, baseUrl } = await startTestServer('https://app.example');

    try {
      const response = await fetch(`${baseUrl}/permission`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example',
          'Access-Control-Request-Method': 'POST',
        },
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: 'Origin not allowed' });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  it('rejects preflight requests that omit Origin', async () => {
    const { server, baseUrl } = await startTestServer('https://app.example');

    try {
      const response = await fetch(`${baseUrl}/permission`, {
        method: 'OPTIONS',
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'Origin header is required for preflight requests',
      });
    } finally {
      await closeServer(server);
    }
  });
});
