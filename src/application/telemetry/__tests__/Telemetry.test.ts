import { listIncidents } from '../../incidents/listIncidents';
import { getIncidentDetail } from '../../incidents/getIncidentDetail';
import type { IncidentRepository } from '../../../domain/incident/IncidentRepository';
import { ConsoleTelemetrySink } from '../../../infrastructure/telemetry/ConsoleTelemetrySink';
import { InMemoryIncidentRepository } from '../../../infrastructure/incidents/InMemoryIncidentRepository';
import { createTelemetry, scrubTelemetryText, type TelemetryEntry } from '../Telemetry';

// Error ficticio que simula una respuesta del backend que repite datos de la petición.
const LEAKY_MESSAGE =
  'GET http://tester:clave-ficticia@127.0.0.1:4310/v1/incidents?token=tok-ficticio failed: ' +
  'Authorization: Bearer course-valid-token for reportante.ficticio@campusops.test';
const LEAKED_VALUES = ['clave-ficticia', 'tok-ficticio', 'course-valid-token', 'reportante.ficticio@campusops.test'];

function memorySink() {
  const entries: TelemetryEntry[] = [];
  return { entries, sink: { write: (entry: TelemetryEntry) => void entries.push(entry) } };
}

const failingRepository: IncidentRepository = {
  getAll: () => Promise.reject(new Error(LEAKY_MESSAGE)),
  getById: () => Promise.reject(new Error(LEAKY_MESSAGE)),
  create: () => Promise.reject(new Error(LEAKY_MESSAGE)),
};

describe('Telemetry — caminos de error (amenazas 1 y 2 del threat model)', () => {
  test('neg-09 sin sanitizar, el mensaje de error crudo SÍ contiene token, contraseña y correo', () => {
    expect(LEAKED_VALUES.every((value) => LEAKY_MESSAGE.includes(value))).toBe(true);
  });

  test('neg-10 el error de listIncidents se registra sin credenciales ni correo', async () => {
    const { entries, sink } = memorySink();
    await expect(listIncidents(failingRepository, createTelemetry(sink))).rejects.toThrow();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: 'error', event: 'incidents.list_failed' });
    const serialized = JSON.stringify(entries);
    for (const value of LEAKED_VALUES) expect(serialized).not.toContain(value);
    expect(entries[0]?.error?.message).toContain('Bearer [REDACTED]');
  });

  test('neg-11 el error de getIncidentDetail conserva el incidentId y oculta lo demás', async () => {
    const { entries, sink } = memorySink();
    await expect(getIncidentDetail(failingRepository, 'campus-inc-001', createTelemetry(sink))).rejects.toThrow();
    expect(entries[0]).toMatchObject({ event: 'incidents.detail_failed', context: { incidentId: 'campus-inc-001' } });
    const serialized = JSON.stringify(entries);
    for (const value of LEAKED_VALUES) expect(serialized).not.toContain(value);
  });

  test('neg-12 un valor lanzado que no es Error (objeto con datos personales) no se vuelca al log', () => {
    const { entries, sink } = memorySink();
    createTelemetry(sink).error('incidents.sync_failed', { name: 'Persona ficticia', location: 'Zona ficticia' });
    expect(entries[0]?.error).toEqual({ name: 'NonError', message: 'thrown value of type object' });
    expect(JSON.stringify(entries)).not.toContain('Persona ficticia');
  });

  test('neg-13 el contexto del evento también se sanitiza (anidado)', () => {
    const { entries, sink } = memorySink();
    createTelemetry(sink).info('incidents.assigned', {
      incidentId: 'campus-inc-001',
      assignment: { technicianId: 'technician-1', history: [{ actorId: 'coordinator-1' }] },
    });
    expect(entries[0]?.context).toEqual({
      incidentId: 'campus-inc-001',
      assignment: { technicianId: '[REDACTED]', history: '[REDACTED]' },
    });
  });

  test('neg-14 si el destino de logs falla, la app no se cae', async () => {
    const telemetry = createTelemetry({
      write() {
        throw new Error('disk full');
      },
    });
    await expect(listIncidents(new InMemoryIncidentRepository(), telemetry)).resolves.toHaveLength(4);
  });

  test('neg-15 la consola real sólo recibe la entrada sanitizada', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(listIncidents(failingRepository, createTelemetry(new ConsoleTelemetrySink()))).rejects.toThrow();
      const printed = warn.mock.calls.flat().join('\n');
      expect(printed).toContain('incidents.list_failed');
      for (const value of LEAKED_VALUES) expect(printed).not.toContain(value);
    } finally {
      warn.mockRestore();
    }
  });

  test('neg-16 flujo nominal: el evento de éxito sólo trae contexto técnico', async () => {
    const { entries, sink } = memorySink();
    await getIncidentDetail(new InMemoryIncidentRepository(), 'inc-001', createTelemetry(sink));
    expect(entries[0]).toMatchObject({
      level: 'info',
      event: 'incidents.detail_loaded',
      context: { incidentId: 'inc-001', status: 'open' },
    });
    expect(JSON.stringify(entries)).not.toContain('Corto circuito');
  });

  test('scrubTelemetryText no altera texto técnico sin secretos', () => {
    expect(scrubTelemetryText('Backend health failed with 503')).toBe('Backend health failed with 503');
  });
});
