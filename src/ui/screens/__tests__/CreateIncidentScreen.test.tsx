import { fireEvent, render, waitFor } from '@testing-library/react-native';

import type { Incident } from '../../../domain/incident/Incident';
import type { IncidentRepository } from '../../../domain/incident/IncidentRepository';
import { CreateIncidentScreen, LOCATION_UNAVAILABLE_MESSAGE } from '../CreateIncidentScreen';

const created: Incident = { id: 'campus-inc-100', categoria: 'maintenance', descripcion: 'Foco fundido', estado: 'open' } as Incident;

function repo() {
  const create = jest.fn().mockResolvedValue(created);
  const repository = { getAll: jest.fn(), getById: jest.fn(), create } as unknown as IncidentRepository;
  return { repository, create };
}

async function fill(view: Awaited<ReturnType<typeof render>>, description: string, location: string) {
  await fireEvent.changeText(view.getByTestId('create-description-input'), description);
  await fireEvent.changeText(view.getByTestId('create-location-input'), location);
  await fireEvent.press(view.getByTestId('create-incident-submit'));
}

describe('CreateIncidentScreen — ubicación manual', () => {
  test('con el proveedor fallando sí se crea la incidencia con la ubicación manual', async () => {
    const { repository, create } = repo();
    const onCreated = jest.fn();
    const view = await render(
      <CreateIncidentScreen
        repository={repository}
        onCreated={onCreated}
        onCancel={() => {}}
        findLocation={() => Promise.reject(new Error('503'))}
      />,
    );
    await fill(view, 'Foco fundido', 'Edificio A, pasillo 2');
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(create).toHaveBeenCalledWith({ categoria: 'maintenance', descripcion: 'Foco fundido', location: 'Edificio A, pasillo 2' });
    expect(view.getByText(LOCATION_UNAVAILABLE_MESSAGE)).toBeTruthy();
  });

  test('con el proveedor lento (timeout) no se bloquea la creación', async () => {
    const { repository, create } = repo();
    const onCreated = jest.fn();
    const view = await render(
      <CreateIncidentScreen
        repository={repository}
        onCreated={onCreated}
        onCancel={() => {}}
        lookupTimeoutMs={50}
        findLocation={() => new Promise(() => {})}
      />,
    );
    await fill(view, 'Sin internet', 'Laboratorio 3');
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ location: 'Laboratorio 3' }));
  });

  test('sin ubicación manual no se crea y se pide escribirla', async () => {
    const { repository, create } = repo();
    const view = await render(<CreateIncidentScreen repository={repository} onCreated={() => {}} onCancel={() => {}} />);
    await fill(view, 'Algo', '   ');
    await waitFor(() => expect(view.getByTestId('create-incident-error')).toBeTruthy());
    expect(create).not.toHaveBeenCalled();
  });

  test('si el repositorio falla se muestra un error genérico sin detalle técnico', async () => {
    const { repository, create } = repo();
    create.mockRejectedValue(new Error('Bearer course-valid-token rechazado'));
    const view = await render(<CreateIncidentScreen repository={repository} onCreated={() => {}} onCancel={() => {}} />);
    await fill(view, 'Algo', 'Edificio B');
    await waitFor(() => expect(view.getByText('No se pudo crear la incidencia.')).toBeTruthy());
    expect(view.queryByText(/course-valid-token/)).toBeNull();
  });
});
