import { selectIncidentLocation as fromCourseAdapter } from '../../../course-evaluation';
import { parseProviderLocation, selectIncidentLocation } from '../selectIncidentLocation';

const MANUAL = 'Edificio B, planta baja (ficticio)';
const manual = { source: 'manual', label: MANUAL };

describe('selectIncidentLocation', () => {
  test('acepta coordenadas en 0,0 y en los límites exactos', () => {
    expect(selectIncidentLocation({ label: 'Zona de prueba', latitude: 0, longitude: 0 }, MANUAL)).toEqual({
      source: 'provider', label: 'Zona de prueba', latitude: 0, longitude: 0,
    });
    expect(selectIncidentLocation({ label: 'Borde', latitude: -90, longitude: 180 }, MANUAL)).toEqual({
      source: 'provider', label: 'Borde', latitude: -90, longitude: 180,
    });
    expect(selectIncidentLocation({ label: 'Borde', latitude: 90, longitude: -180 }, MANUAL)).toMatchObject({ source: 'provider' });
  });

  test('ignora campos extra del proveedor', () => {
    expect(selectIncidentLocation({ label: 'Zona', latitude: 1, longitude: 2, extra: 'x' }, MANUAL)).toEqual({
      source: 'provider', label: 'Zona', latitude: 1, longitude: 2,
    });
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['error como dato 429', { status: 429 }],
    ['incompleta', { label: 'Incompleta' }],
    ['latitud 91', { label: 'X', latitude: 91, longitude: 0 }],
    ['latitud -91', { label: 'X', latitude: -91, longitude: 0 }],
    ['longitud 181', { label: 'X', latitude: 0, longitude: 181 }],
    ['longitud -181', { label: 'X', latitude: 0, longitude: -181 }],
    ['NaN', { label: 'X', latitude: NaN, longitude: 0 }],
    ['Infinity', { label: 'X', latitude: 0, longitude: Infinity }],
    ['coordenadas como texto', { label: 'X', latitude: '0', longitude: '0' }],
    ['longitud null (doble invalid_coordinates)', { label: 'Zona ficticia', latitude: 999, longitude: null }],
    ['label vacío', { label: '', latitude: 0, longitude: 0 }],
    ['label sólo espacios', { label: '   ', latitude: 0, longitude: 0 }],
    ['label no textual', { label: 7, latitude: 0, longitude: 0 }],
    ['arreglo', [{ label: 'X', latitude: 0, longitude: 0 }]],
    ['texto', 'Zona de prueba'],
    ['número', 42],
  ])('%s → ubicación manual sin coordenadas inventadas', (_name, value) => {
    const result = selectIncidentLocation(value, MANUAL);
    expect(result).toEqual(manual);
    expect(result).not.toHaveProperty('latitude');
    expect(result).not.toHaveProperty('longitude');
  });

  test('parseProviderLocation no muta la entrada', () => {
    const input = Object.freeze({ label: 'Zona', latitude: 1, longitude: 1 });
    expect(parseProviderLocation(input)).toEqual({ label: 'Zona', latitude: 1, longitude: 1 });
  });

  test('el adaptador del curso llama a la misma lógica de dominio', () => {
    const value = { label: 'Zona', latitude: 10, longitude: -20 };
    expect(fromCourseAdapter(value, MANUAL)).toEqual(selectIncidentLocation(value, MANUAL));
    expect(fromCourseAdapter({ status: 'timeout' }, MANUAL)).toEqual(manual);
  });
});
