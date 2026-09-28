import { redactForTelemetry as courseAdapter } from '../../../course-evaluation';
import { REDACTED, redactForTelemetry } from '../redactForTelemetry';

// Datos 100% ficticios: ninguna persona, correo ni ubicación real.
function buildIncidentReport() {
  return {
    incidentId: 'campus-inc-001',
    correlationId: 'corr-0001',
    status: 'assigned',
    attempt: 2,
    durationMs: 38,
    reportante: {
      nombre: 'Persona Ficticia Uno',
      ubicacion: 'Edificio de prueba A, aula 000',
      email: 'reportante.ficticio@campusops.test',
    },
    payload: {
      category: 'connectivity',
      reporterId: 'reporter-1',
      assignedTechnicianId: 'technician-1',
      location: { label: 'Zona ficticia', latitude: 0.123, longitude: -0.456 },
      photos: ['synthetic-photo-1', 'synthetic-photo-2'],
      internalComments: ['Nota interna ficticia'],
      assignmentHistory: [{ technicianId: 'technician-2', at: '2026-09-01T00:00:00Z' }],
    },
    attachments: [
      { kind: 'photo', evidence: 'synthetic-evidence-1', status: 'uploaded' },
      { kind: 'note', internal_comments: 'Otra nota ficticia', status: 'draft' },
    ],
    request: { headers: { Authorization: 'Bearer course-valid-token', accept: 'application/json' } },
  };
}

const SENSITIVE_VALUES = [
  'Persona Ficticia Uno',
  'Edificio de prueba A, aula 000',
  'reportante.ficticio@campusops.test',
  'reporter-1',
  'technician-1',
  'technician-2',
  'Zona ficticia',
  'synthetic-photo-1',
  'Nota interna ficticia',
  'synthetic-evidence-1',
  'Otra nota ficticia',
  'course-valid-token',
];

function expectNoSensitiveValue(serialized: string) {
  for (const value of SENSITIVE_VALUES) expect(serialized).not.toContain(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe('redactForTelemetry — amenaza 2 del threat model: filtrar datos en logs', () => {
  test('neg-01 sin sanitizar, el log crudo SÍ filtra los datos (demuestra la amenaza)', () => {
    const raw = JSON.stringify(buildIncidentReport());
    expect(SENSITIVE_VALUES.filter((value) => raw.includes(value))).toEqual(SENSITIVE_VALUES);
  });

  test('neg-02 objeto anidado reportante: {nombre, ubicacion} queda oculto', () => {
    const result = redactForTelemetry(buildIncidentReport()) as ReturnType<typeof buildIncidentReport>;
    expect(result.reportante).toEqual({ nombre: REDACTED, ubicacion: REDACTED, email: REDACTED });
    expect(result.payload.location).toBe(REDACTED);
    expect(result.payload.reporterId).toBe(REDACTED);
    expect(result.payload.assignedTechnicianId).toBe(REDACTED);
    expect(result.payload.assignmentHistory).toBe(REDACTED);
    expect(result.request.headers.Authorization).toBe(REDACTED);
    expectNoSensitiveValue(JSON.stringify(result));
  });

  test('neg-03 listas: se recorren elemento por elemento y las listas sensibles se ocultan completas', () => {
    const result = redactForTelemetry(buildIncidentReport()) as ReturnType<typeof buildIncidentReport>;
    expect(result.payload.photos).toBe(REDACTED);
    expect(result.payload.internalComments).toBe(REDACTED);
    expect(result.attachments).toEqual([
      { kind: 'photo', evidence: REDACTED, status: 'uploaded' },
      { kind: 'note', internal_comments: REDACTED, status: 'draft' },
    ]);
    const list = redactForTelemetry([{ userId: 'u-1', status: 'open' }, [{ password: 'x' }]]);
    expect(list).toEqual([{ userId: REDACTED, status: 'open' }, [{ password: REDACTED }]]);
  });

  test('neg-04 conserva sólo contexto técnico seguro', () => {
    const result = redactForTelemetry(buildIncidentReport()) as ReturnType<typeof buildIncidentReport>;
    expect(result).toMatchObject({
      incidentId: 'campus-inc-001',
      correlationId: 'corr-0001',
      status: 'assigned',
      attempt: 2,
      durationMs: 38,
    });
    expect(result.payload.category).toBe('connectivity');
    expect(result.request.headers.accept).toBe('application/json');
  });

  test('neg-05 no muta la entrada original (ni objetos anidados ni listas)', () => {
    const original = buildIncidentReport();
    const snapshot = structuredClone(original);
    const result = redactForTelemetry(deepFreeze(original)) as ReturnType<typeof buildIncidentReport>;
    expect(original).toEqual(snapshot);
    expect(result).not.toBe(original);
    expect(result.reportante).not.toBe(original.reportante);
    expect(result.attachments).not.toBe(original.attachments);
  });

  test('neg-06 normaliza mayúsculas, guiones y guiones bajos en las claves', () => {
    expect(
      redactForTelemetry({
        ACCESS_TOKEN: 'a',
        'refresh-token': 'b',
        Assigned_Technician_Id: 'technician-1',
        DisplayName: 'Persona ficticia',
        'internal-comments': ['c'],
        incident_id: 'campus-inc-001',
      }),
    ).toEqual({
      ACCESS_TOKEN: REDACTED,
      'refresh-token': REDACTED,
      Assigned_Technician_Id: REDACTED,
      DisplayName: REDACTED,
      'internal-comments': REDACTED,
      incident_id: 'campus-inc-001',
    });
  });

  test('neg-07 caso límite: referencias circulares y valores primitivos no rompen la sanitización', () => {
    const cyclic: Record<string, unknown> = { incidentId: 'campus-inc-001', name: 'Persona ficticia' };
    cyclic.self = cyclic;
    expect(redactForTelemetry(cyclic)).toEqual({ incidentId: 'campus-inc-001', name: REDACTED, self: '[Circular]' });
    const shared = { status: 'open' };
    expect(redactForTelemetry({ a: shared, b: shared })).toEqual({ a: { status: 'open' }, b: { status: 'open' } });
    expect(redactForTelemetry(null)).toBeNull();
    expect(redactForTelemetry('texto')).toBe('texto');
    expect(redactForTelemetry(42)).toBe(42);
    expect(redactForTelemetry([])).toEqual([]);
  });

  test('neg-08 el adaptador evaluable usa la misma lógica real de la app', () => {
    const input = buildIncidentReport();
    expect(courseAdapter(input)).toEqual(redactForTelemetry(input));
  });
});
