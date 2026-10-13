import { coordinateRefresh } from '..';

/** Casos límite del modelo de renovación que no cubre la prueba pública. */
describe('coordinateRefresh — casos límite', () => {
  test('cr-01 refresh fallido con peticiones en espera: anónimo, sin reintentos y sin token', () => {
    expect(
      coordinateRefresh([
        { type: 'request401', requestId: 'a', generation: 0 },
        { type: 'request401', requestId: 'b', generation: 0 },
        { type: 'request401', requestId: 'c', generation: 0 },
        { type: 'refreshFailed', generation: 0 },
      ]),
    ).toEqual({ status: 'anonymous', activeGeneration: null, refreshCalls: 1, retriedRequestIds: [], persistedToken: null });
  });

  test('cr-02 tras un refresh fallido, un 401 tardío no inicia otro refresh (sin bucle)', () => {
    const summary = coordinateRefresh([
      { type: 'request401', requestId: 'a', generation: 0 },
      { type: 'refreshFailed', generation: 0 },
      { type: 'request401', requestId: 'b', generation: 0 },
      { type: 'request401', requestId: 'c', generation: 1 },
    ]);
    expect(summary.refreshCalls).toBe(1);
    expect(summary.retriedRequestIds).toEqual([]);
    expect(summary.status).toBe('anonymous');
  });

  test('cr-03 un refreshSucceeded obsoleto no pisa la generación ni el token más nuevos', () => {
    const summary = coordinateRefresh([
      { type: 'request401', requestId: 'a', generation: 0 },
      { type: 'refreshSucceeded', generation: 1, token: 'course-token-1' },
      { type: 'request401', requestId: 'b', generation: 1 },
      { type: 'refreshSucceeded', generation: 2, token: 'course-token-2' },
      { type: 'refreshSucceeded', generation: 1, token: 'course-token-viejo' },
    ]);
    expect(summary).toMatchObject({ status: 'authenticated', activeGeneration: 2, refreshCalls: 2, persistedToken: 'course-token-2' });
    expect(summary.retriedRequestIds).toEqual(['a', 'b']);
  });

  test('cr-04 un refreshFailed obsoleto no cierra una sesión más nueva', () => {
    const summary = coordinateRefresh([
      { type: 'request401', requestId: 'a', generation: 0 },
      { type: 'refreshSucceeded', generation: 1, token: 'course-token-1' },
      { type: 'refreshFailed', generation: 0 },
    ]);
    expect(summary).toMatchObject({ status: 'authenticated', activeGeneration: 1, persistedToken: 'course-token-1' });
  });

  test('cr-05 401 con generación ya renovada se reintenta con el token vigente sin otro refresh', () => {
    const summary = coordinateRefresh([
      { type: 'request401', requestId: 'a', generation: 0 },
      { type: 'refreshSucceeded', generation: 1, token: 'course-token-1' },
      { type: 'request401', requestId: 'tarde', generation: 0 },
    ]);
    expect(summary.refreshCalls).toBe(1);
    expect(summary.retriedRequestIds).toEqual(['a', 'tarde']);
  });

  test('cr-06 logout con un refresh en curso: la respuesta tardía no vuelve a persistir token', () => {
    const summary = coordinateRefresh([
      { type: 'request401', requestId: 'a', generation: 0 },
      { type: 'logout' },
      { type: 'refreshSucceeded', generation: 1, token: 'course-token-1' },
    ]);
    expect(summary).toEqual({ status: 'anonymous', activeGeneration: null, refreshCalls: 1, retriedRequestIds: [], persistedToken: null });
  });

  test('cr-07 después del logout un 401 no dispara refresh', () => {
    const summary = coordinateRefresh([
      { type: 'request401', requestId: 'a', generation: 0 },
      { type: 'refreshSucceeded', generation: 1, token: 'course-token-1' },
      { type: 'logout' },
      { type: 'request401', requestId: 'b', generation: 1 },
    ]);
    expect(summary).toMatchObject({ status: 'anonymous', refreshCalls: 1, persistedToken: null });
  });
});
