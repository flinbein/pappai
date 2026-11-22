import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';

export function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

export async function serve(handler) {
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      await handler(request, response, Buffer.concat(chunks).toString());
    } catch (error) {
      json(response, { error: error.message }, 500);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: 'http://127.0.0.1:' + server.address().port,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

export async function mcp(request, response, body, call) {
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }
  const message = JSON.parse(body);
  if (message.id === undefined) {
    response.writeHead(202).end();
    return;
  }
  let result;
  switch (message.method) {
    case 'initialize':
      result = {
        protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1' }
      };
      break;
    case 'tools/list':
      result = { tools: [{ name: 'whoami', description: 'Fixture account', inputSchema: { type: 'object' } }] };
      break;
    case 'tools/call':
      if (message.params.name !== 'whoami') throw Error('Unexpected tool');
      result = { content: [{ type: 'text', text: await call() }] };
      break;
    default:
      return json(response, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } });
  }
  json(response, { jsonrpc: '2.0', id: message.id, result });
}

export async function oauthProvider() {
  const codes = new Map();
  const access = new Map();
  const refresh = new Map();
  const counts = { logins: [], rotations: [], rejectedRefreshes: 0, calls: [] };
  function issue(account) {
    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    access.set(accessToken, account);
    refresh.set(refreshToken, { account, accessToken });
    return { token_type: 'Bearer', access_token: accessToken, refresh_token: refreshToken, expires_in: 3600 };
  }
  const server = await serve(async (request, response, raw) => {
    const { origin } = server;
    const url = new URL(request.url, origin);
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(response, { resource: origin + '/mcp', authorization_servers: [origin] });
    }
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      return json(response, {
        issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token',
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post']
      });
    }
    if (url.pathname === '/authorize') {
      const query = url.searchParams;
      const code = randomUUID();
      const redirect = new URL(query.get('redirect_uri'));
      codes.set(code, { account: query.get('account'), challenge: query.get('code_challenge'), redirect: redirect.href });
      redirect.searchParams.set('state', query.get('state'));
      redirect.searchParams.set('iss', origin);
      redirect.searchParams.set('code', code);
      return response.writeHead(302, { Location: redirect.href }).end();
    }
    if (url.pathname === '/token') {
      const params = new URLSearchParams(raw);
      const basic = 'Basic ' + Buffer.from('fixture:fixture-secret').toString('base64');
      if (request.headers.authorization !== basic && params.get('client_secret') !== 'fixture-secret') {
        return json(response, { error: 'invalid_client' }, 401);
      }
      if (params.get('grant_type') === 'refresh_token') {
        const token = params.get('refresh_token');
        const old = refresh.get(token);
        if (!old) {
          counts.rejectedRefreshes++;
          return json(response, { error: 'invalid_grant' }, 400);
        }
        refresh.delete(token);
        access.delete(old.accessToken);
        counts.rotations.push(old.account);
        return json(response, issue(old.account));
      }
      const code = params.get('code');
      const saved = codes.get(code);
      const challenge = createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url');
      if (!saved || saved.challenge !== challenge || saved.redirect !== params.get('redirect_uri')) {
        return json(response, { error: 'invalid_grant' }, 400);
      }
      codes.delete(code);
      counts.logins.push(saved.account);
      return json(response, issue(saved.account));
    }
    if (url.pathname === '/mcp') {
      const account = access.get(request.headers.authorization?.replace(/^Bearer /, ''));
      if (!account) {
        return response.writeHead(401, { 'WWW-Authenticate': 'Bearer resource_metadata="' + origin + '/.well-known/oauth-protected-resource"' }).end();
      }
      return mcp(request, response, raw, () => {
        counts.calls.push(account);
        return account;
      });
    }
    json(response, { error: 'not_found' }, 404);
  });
  return {
    ...server, counts,
    revokeAccess(account) {
      for (const [token, owner] of access) if (owner === account) access.delete(token);
    }
  };
}
