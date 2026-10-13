import { IncidentRemoteError } from '../../../domain/incident/IncidentRemoteError';
import type { SessionPort } from '../../../domain/session/SessionPort';
import { CloudIncidentRepository } from '../CloudIncidentRepository';

const DTO = { id: 'campus-inc-001', version: 1, status: 'assigned', payload: { category: 'connectivity', description: 'Sin red', location: 'A', assignedTechnicianId: 'technician-1' } };

function reply(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => JSON.stringify(body) } as unknown as Response;
}

/** Sesión falsa: cuenta cuántas veces se pidió refresh y con qué token responde. */
function fakeSession(refreshResult: string | null) {
  const refresh = jest.fn(async () => refreshResult);
  const session: SessionPort = {
    getAccessToken: () => 'token-viejo',
    getGeneration: () => 1,
    refresh,
  };
  return { session, refresh };
}

function build(fetchImpl: typeof fetch, session: SessionPort) {
  return new CloudIncidentRepository('technician-1', 'x', 'http://stub.invalid', { fetchImpl, session, sleep: async () => {} });
}

describe('CloudIncidentRepository — 401 y refresh', () => {
  test('401 → refresh → UN reintento con el token nuevo', async () => {
    const auth: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      auth.push((init.headers as Record<string, string>).Authorization!);
      return auth.length === 1 ? reply(401, { code: 'unauthorized' }) : reply(200, DTO);
    }) as unknown as typeof fetch;
    const { session, refresh } = fakeSession('token-nuevo');

    await expect(build(fetchImpl, session).getById('campus-inc-001')).resolves.toMatchObject({ id: 'campus-inc-001' });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(auth).toEqual(['Bearer token-viejo', 'Bearer token-nuevo']);
  });

  test('refresh fallido: propaga el 401 y no reintenta', async () => {
    const fetchImpl = jest.fn(async () => reply(401, { code: 'unauthorized' })) as unknown as typeof fetch;
    const { session, refresh } = fakeSession(null);

    const error = await build(fetchImpl, session).getAll().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IncidentRemoteError);
    expect((error as IncidentRemoteError).failure).toEqual({ kind: 'http', status: 401 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('si el reintento vuelve a dar 401 no hay bucle: 2 peticiones y 1 refresh', async () => {
    const fetchImpl = jest.fn(async () => reply(401, { code: 'unauthorized' })) as unknown as typeof fetch;
    const { session, refresh } = fakeSession('token-nuevo');

    await expect(build(fetchImpl, session).getAll()).rejects.toMatchObject({ failure: { kind: 'http', status: 401 } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('getWork y performAction mandan baseVersion e Idempotency-Key', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return url.endsWith('/actions')
        ? reply(201, { incident: { ...DTO, version: 2, status: 'in_progress' } })
        : reply(200, DTO);
    }) as unknown as typeof fetch;
    const repo = build(fetchImpl, fakeSession('x').session);

    await expect(repo.getWork('campus-inc-001')).resolves.toEqual({ version: 1, status: 'assigned', assignedTechnicianId: 'technician-1' });
    await expect(repo.performAction('campus-inc-001', 'start', 1)).resolves.toMatchObject({ estado: 'in_progress' });
    const post = calls[1]!;
    expect(post.url).toBe('http://stub.invalid/v1/incidents/campus-inc-001/actions');
    expect(JSON.parse(post.init.body as string)).toEqual({ action: 'start', baseVersion: 1 });
    expect((post.init.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
  });
});