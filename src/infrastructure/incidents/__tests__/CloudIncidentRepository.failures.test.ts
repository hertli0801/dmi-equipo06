import { createIncident } from '../../../application/incidents/createIncident';
import { getIncidentDetail } from '../../../application/incidents/getIncidentDetail';
import { listIncidents } from '../../../application/incidents/listIncidents';
import { createTelemetry, type TelemetryEntry } from '../../../application/telemetry/Telemetry';
import { IncidentRemoteError, type IncidentRemoteFailure } from '../../../domain/incident/IncidentRemoteError';
import { CloudIncidentRepository } from '../CloudIncidentRepository';

/**
 * Matriz de fallos con un fetch simulado: respuestas repetibles, sin Internet ni backend real.
 * Los IDs (fm-XX) coinciden con reports/week-05/failure-matrix.json.
 */

const TOKEN = 'course-valid-token';
const VALID_DTO = {
  id: 'campus-inc-001',
  version: 1,
  status: 'assigned',
  payload: {
    category: 'connectivity',
    description: 'Sin conexión en laboratorio ficticio',
    location: 'Edificio de prueba A',
    reporterId: 'reporter-1',
  },
};

type StubCall = { url: string; init: RequestInit };

function reply(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name] ?? null },
    text: async () => body,
  } as unknown as Response;
}

function stubFetch(...responses: (() => Promise<Response>)[]) {
  const calls: StubCall[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return next();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

/** Nunca responde; sólo termina cuando el cliente aborta por timeout. */
function hangUntilAborted(): typeof fetch {
  return ((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })) as unknown as typeof fetch;
}

function repo(fetchImpl: typeof fetch, timeoutMs = 50) {
  return new CloudIncidentRepository('reporter-1', TOKEN, 'http://stub.invalid', {
    fetchImpl,
    timeoutMs,
    sleep: async () => {},
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

function memoryTelemetry() {
  const entries: TelemetryEntry[] = [];
  return { entries, telemetry: createTelemetry({ write: (entry) => void entries.push(entry) }) };
}

describe('CloudIncidentRepository — matriz de fallos con fetch simulado', () => {
  test('fm-01 respuesta válida: el DTO pasa por parseRemoteResource y llega como Incident de dominio', async () => {
    const { fetchImpl } = stubFetch(async () => reply(200, JSON.stringify(VALID_DTO)));
    await expect(repo(fetchImpl).getById('campus-inc-001')).resolves.toEqual({
      id: 'campus-inc-001',
      categoria: 'connectivity',
      descripcion: 'Sin conexión en laboratorio ficticio',
      estado: 'assigned',
    });
  });

  test('fm-02 payload null válido: no es error ni se inventan datos', async () => {
    const { fetchImpl } = stubFetch(async () => reply(200, JSON.stringify({ ...VALID_DTO, payload: null })));
    const incident = await repo(fetchImpl).getById('campus-inc-001');
    expect(incident).toEqual({ id: 'campus-inc-001', categoria: null, descripcion: null, estado: 'assigned' });
  });

  test('fm-03 JSON roto (200 con cuerpo inválido) → malformed, sin SyntaxError suelto', async () => {
    const { fetchImpl } = stubFetch(async () => reply(200, '{"items": [}'));
    expect(await failureOf(repo(fetchImpl).getAll())).toEqual({ kind: 'malformed' });
  });

  test('fm-04 objeto que viola el contrato (version como string) → contract', async () => {
    const { fetchImpl } = stubFetch(async () => reply(200, JSON.stringify({ ...VALID_DTO, version: '1' })));
    expect(await failureOf(repo(fetchImpl).getById('campus-inc-001'))).toEqual({ kind: 'contract' });
  });

  test('fm-05 payload no nulo pero incompleto (sin category) → contract, no se confunde con null', async () => {
    const { fetchImpl } = stubFetch(async () =>
      reply(200, JSON.stringify({ ...VALID_DTO, payload: { description: 'Falla ficticia' } })),
    );
    expect(await failureOf(repo(fetchImpl).getById('campus-inc-001'))).toEqual({ kind: 'contract' });
  });

  test('fm-06 lista con un elemento corrupto → contract (no se muestra una lista parcial)', async () => {
    const { fetchImpl } = stubFetch(async () =>
      reply(200, JSON.stringify({ items: [VALID_DTO, { ...VALID_DTO, id: '' }] })),
    );
    expect(await failureOf(repo(fetchImpl).getAll())).toEqual({ kind: 'contract' });
  });

  test('fm-07 sobre de lista sin items → contract', async () => {
    const { fetchImpl } = stubFetch(async () => reply(200, JSON.stringify({ data: [] })));
    expect(await failureOf(repo(fetchImpl).getAll())).toEqual({ kind: 'contract' });
  });

  test('fm-08 el servidor no responde → timeout, distinto de un 500', async () => {
    const timeout = await failureOf(repo(hangUntilAborted(), 30).getAll());
    const { fetchImpl } = stubFetch(async () => reply(500, '{"code":"controlled_failure"}'));
    const serverError = await failureOf(repo(fetchImpl).getAll());
    expect(timeout).toEqual({ kind: 'timeout', timeoutMs: 30 });
    expect(serverError).toEqual({ kind: 'serverError', status: 500 });
    expect(timeout.kind).not.toBe(serverError.kind);
  });

  test('fm-09 error 500 en detalle → serverError con status', async () => {
    const { fetchImpl } = stubFetch(async () => reply(500, '{"code":"controlled_failure"}'));
    expect(await failureOf(repo(fetchImpl).getById('campus-inc-001'))).toEqual({ kind: 'serverError', status: 500 });
  });

  test('fm-10 sin red (fetch rechaza) → network', async () => {
    const { fetchImpl } = stubFetch(async () => {
      throw new TypeError('Network request failed');
    });
    expect(await failureOf(repo(fetchImpl).getAll())).toEqual({ kind: 'network' });
  });

  test('fm-11 404 en detalle → null (no encontrado), no es error', async () => {
    const { fetchImpl } = stubFetch(async () => reply(404, '{"code":"not_found"}'));
    await expect(repo(fetchImpl).getById('campus-inc-999')).resolves.toBeNull();
  });

  test('fm-12 crear con 500 y luego 201: reintenta con la MISMA Idempotency-Key', async () => {
    const created = { incident: { ...VALID_DTO, id: 'campus-inc-101', status: 'open' }, duplicate: false };
    const { calls, fetchImpl } = stubFetch(
      async () => reply(500, '{"code":"controlled_failure"}'),
      async () => reply(201, JSON.stringify(created)),
    );
    const incident = await repo(fetchImpl).create({
      categoria: 'connectivity',
      descripcion: 'Falla ficticia',
      location: 'Edificio de prueba A',
    });
    expect(incident.id).toBe('campus-inc-101');
    const keys = calls.map((call) => (call.init.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  test('fm-13 crear con timeout persistente → agota intentos y termina en timeout (sin bucle infinito)', async () => {
    let attempts = 0;
    const hang = hangUntilAborted();
    const fetchImpl = ((url: string, init: RequestInit) => {
      attempts++;
      return hang(url, init);
    }) as unknown as typeof fetch;
    const failure = await failureOf(
      repo(fetchImpl, 20).create({ categoria: 'water', descripcion: 'Fuga ficticia', location: 'Edificio A' }),
    );
    expect(failure.kind).toBe('timeout');
    expect(attempts).toBe(3);
  });

  test('fm-14 crear con 422 no se reintenta → http 422', async () => {
    const { calls, fetchImpl } = stubFetch(async () => reply(422, '{"code":"invalid_incident"}'));
    const failure = await failureOf(
      repo(fetchImpl).create({ categoria: 'inexistente', descripcion: 'x', location: 'Edificio A' }),
    );
    expect(failure).toEqual({ kind: 'http', status: 422 });
    expect(calls).toHaveLength(1);
  });
});

describe('Casos de uso — los fallos quedan tipados en logs sanitizados', () => {
  const LEAKY_BODY = `{"items": [} Bearer ${TOKEN} reportante.ficticio@campusops.test`;

  test('fm-15 malformed/timeout/500 se registran con failureKind distinto y sin token ni correo', async () => {
    const { entries, telemetry } = memoryTelemetry();
    const malformed = stubFetch(async () => reply(200, LEAKY_BODY)).fetchImpl;
    const server = stubFetch(async () => reply(500, LEAKY_BODY)).fetchImpl;

    await expect(listIncidents(repo(malformed), telemetry)).rejects.toBeInstanceOf(IncidentRemoteError);
    await expect(listIncidents(repo(hangUntilAborted(), 20), telemetry)).rejects.toBeInstanceOf(IncidentRemoteError);
    await expect(getIncidentDetail(repo(server), 'campus-inc-001', telemetry)).rejects.toBeInstanceOf(
      IncidentRemoteError,
    );

    expect(entries.map((entry) => (entry.context as { failureKind: string }).failureKind)).toEqual([
      'malformed',
      'timeout',
      'serverError',
    ]);
    expect(entries.every((entry) => entry.error?.name === 'IncidentRemoteError')).toBe(true);
    expect(JSON.stringify(entries)).not.toMatch(/course-valid-token|reportante\.ficticio|stub\.invalid/);
  });

  test('fm-16 crear con payload sensible: el log de éxito no contiene descripción ni ubicación', async () => {
    const { entries, telemetry } = memoryTelemetry();
    const created = { incident: { ...VALID_DTO, id: 'campus-inc-102', status: 'open' } };
    const { fetchImpl } = stubFetch(async () => reply(201, JSON.stringify(created)));
    await createIncident(
      repo(fetchImpl),
      { categoria: 'connectivity', descripcion: 'Persona ficticia en Zona ficticia', location: 'Zona ficticia' },
      telemetry,
    );
    expect(entries[0]).toMatchObject({ event: 'incidents.create_succeeded', context: { incidentId: 'campus-inc-102' } });
    expect(JSON.stringify(entries)).not.toMatch(/Persona ficticia|Zona ficticia|course-valid-token/);
  });
});
