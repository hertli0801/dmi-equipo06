import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { resolve } from 'node:path';

import { IncidentRemoteError, type IncidentRemoteFailure } from '../../../domain/incident/IncidentRemoteError';
import { CloudIncidentRepository } from '../CloudIncidentRepository';

/**
 * Mismo cliente contra el backend didáctico (course-backend/server.mjs) levantado en 127.0.0.1
 * con un puerto libre: no usa Internet público. Cada variante se pide con `X-Course-Scenario`.
 * Los IDs (be-XX) coinciden con reports/week-05/failure-matrix.json.
 *
 * jest-expo reemplaza `fetch` global por el del runtime de Expo, que no hace peticiones reales;
 * por eso se inyecta un fetch mínimo sobre `node:http` que respeta método, headers, body y signal.
 */
const nodeHttpFetch = ((url: string, init: RequestInit = {}) =>
  new Promise<Response>((done, fail) => {
    const req = request(url, { method: init.method ?? 'GET', headers: init.headers as Record<string, string> }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', fail);
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        done({
          status,
          ok: status >= 200 && status < 300,
          headers: { get: (name: string) => (res.headers[name.toLowerCase()] as string | undefined) ?? null },
          text: async () => Buffer.concat(chunks).toString('utf8'),
        } as unknown as Response);
      });
    });
    init.signal?.addEventListener('abort', () => {
      req.destroy();
      fail(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
    req.on('error', fail);
    if (typeof init.body === 'string') req.write(init.body);
    req.end();
  })) as unknown as typeof fetch;

const SERVER = resolve(__dirname, '../../../../course-backend/server.mjs');
let backend: ChildProcess;
let baseUrl: string;

beforeAll(async () => {
  backend = spawn(process.execPath, [SERVER], {
    env: { ...process.env, COURSE_BACKEND_HOST: '127.0.0.1', COURSE_BACKEND_PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  baseUrl = await new Promise<string>((done, fail) => {
    backend.stdout!.on('data', (chunk: Buffer) => {
      const match = /listening at (http:\/\/[^\s]+)/.exec(chunk.toString());
      if (match) done(match[1]!);
    });
    backend.once('exit', () => fail(new Error('el backend didáctico terminó antes de iniciar')));
  });
});

afterAll(() => {
  backend?.kill();
});

function repo(scenario: string, timeoutMs = 3000) {
  return new CloudIncidentRepository('reporter-1', 'course-valid-token', baseUrl, {
    fetchImpl: nodeHttpFetch,
    timeoutMs,
    maxAttempts: 1,
    extraHeaders: { 'X-Course-Scenario': scenario },
  });
}

async function failureOf(promise: Promise<unknown>): Promise<IncidentRemoteFailure> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(IncidentRemoteError);
    return (error as IncidentRemoteError).failure;
  }
  throw new Error('se esperaba una falla');
}

describe('CloudIncidentRepository contra el backend didáctico local', () => {
  test('be-01 success: lista y detalle llegan como Incident de dominio', async () => {
    const list = await repo('success').getAll();
    expect(list.map((incident) => incident.id)).toContain('campus-inc-001');
    await expect(repo('success').getById('campus-inc-001')).resolves.toEqual({
      id: 'campus-inc-001',
      categoria: 'connectivity',
      descripcion: 'Sin conexión en laboratorio ficticio',
      estado: 'assigned',
    });
  });

  test('be-02 nullable: payload null válido → incidencia sin detalle, no error', async () => {
    await expect(repo('nullable').getById('campus-inc-001')).resolves.toEqual({
      id: 'campus-inc-001',
      categoria: null,
      descripcion: null,
      estado: 'assigned',
    });
  });

  test('be-03 malformed: JSON roto → malformed', async () => {
    expect(await failureOf(repo('malformed').getAll())).toEqual({ kind: 'malformed' });
  });

  test('be-04 server_error: 500 → serverError', async () => {
    expect(await failureOf(repo('server_error').getById('campus-inc-001'))).toEqual({
      kind: 'serverError',
      status: 500,
    });
  });

  test('be-05 slow (1200 ms) con límite de 500 ms → timeout', async () => {
    expect(await failureOf(repo('slow', 500).getAll())).toEqual({ kind: 'timeout', timeoutMs: 500 });
  });

  test('be-06 slow con límite de 3000 ms → éxito: la lentitud tolerable no es error', async () => {
    await expect(repo('slow', 3000).getAll()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'campus-inc-001' })]),
    );
  });

  test('be-07 crear incidencia: la respuesta 201 se valida y llega como Incident abierto', async () => {
    const created = await repo('success').create({
      categoria: 'electrical',
      descripcion: 'Contacto ficticio sin energía',
      location: 'Edificio de prueba A',
    });
    expect(created).toMatchObject({ categoria: 'electrical', estado: 'open' });
  });

  test('be-08 crear con server_error → serverError tipado, sin excepción suelta', async () => {
    const failure = await failureOf(
      repo('server_error').create({ categoria: 'water', descripcion: 'Fuga ficticia', location: 'Edificio A' }),
    );
    expect(failure).toEqual({ kind: 'serverError', status: 500 });
  });
});
