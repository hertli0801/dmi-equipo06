import { render, waitFor } from '@testing-library/react-native';

import { createTelemetry, type TelemetryEntry } from '../../../application/telemetry/Telemetry';
import type { IncidentRepository } from '../../../domain/incident/IncidentRepository';
import { IncidentDetailScreen } from '../IncidentDetailScreen';
import { IncidentListScreen } from '../IncidentListScreen';

const LEAKY_MESSAGE = 'Bearer course-valid-token rejected for reportante.ficticio@campusops.test';

const failingRepository: IncidentRepository = {
  getAll: () => Promise.reject(new Error(LEAKY_MESSAGE)),
  getById: () => Promise.reject(new Error(LEAKY_MESSAGE)),
  create: () => Promise.reject(new Error(LEAKY_MESSAGE)),
};

function memoryTelemetry() {
  const entries: TelemetryEntry[] = [];
  return { entries, telemetry: createTelemetry({ write: (entry) => void entries.push(entry) }) };
}

describe('Pantallas — el dato oculto en la UI tampoco queda en el log', () => {
  test('neg-17 la lista muestra un error genérico y el log no conserva token ni correo', async () => {
    const { entries, telemetry } = memoryTelemetry();
    const view = await render(
      <IncidentListScreen repository={failingRepository} telemetry={telemetry} onSelectIncident={() => {}} />,
    );
    await waitFor(() => expect(view.getByTestId('incident-list-error')).toBeTruthy());
    expect(view.queryByText(/course-valid-token|campusops\.test/)).toBeNull();
    expect(JSON.stringify(entries)).not.toMatch(/course-valid-token|reportante\.ficticio/);
  });

  test('neg-18 el detalle muestra un error genérico y el log no conserva token ni correo', async () => {
    const { entries, telemetry } = memoryTelemetry();
    const view = await render(
      <IncidentDetailScreen
        repository={failingRepository}
        telemetry={telemetry}
        incidentId="campus-inc-001"
        onBack={() => {}}
      />,
    );
    await waitFor(() => expect(view.getByTestId('incident-detail-error')).toBeTruthy());
    expect(view.queryByText(/course-valid-token|campusops\.test/)).toBeNull();
    expect(entries[0]).toMatchObject({ event: 'incidents.detail_failed', context: { incidentId: 'campus-inc-001' } });
    expect(JSON.stringify(entries)).not.toMatch(/course-valid-token|reportante\.ficticio/);
  });
});
