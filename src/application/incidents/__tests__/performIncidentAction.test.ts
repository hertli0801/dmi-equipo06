import type { IncidentActionsPort } from '../../../domain/incident/IncidentPermissions';
import { ForbiddenActionError } from '../../../domain/incident/IncidentPermissions';
import { performIncidentAction } from '../performIncidentAction';

const INCIDENT = { id: 'campus-inc-001', categoria: null, descripcion: null, estado: 'resolved' as const };

function port(assignedTechnicianId: string | null) {
  const performAction = jest.fn(async () => INCIDENT);
  const impl: IncidentActionsPort = {
    getWork: async () => ({ version: 3, status: 'in_progress', assignedTechnicianId }),
    performAction,
  };
  return { impl, performAction };
}

describe('performIncidentAction — autorización en la lógica', () => {
  test('técnico NO asignado: se rechaza y ni siquiera se llama al servidor', async () => {
    const { impl, performAction } = port('technician-2');
    await expect(
      performIncidentAction(impl, { actorId: 'technician-1', role: 'technician' }, 'campus-inc-001', 'resolve', { diagnosis: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenActionError);
    expect(performAction).not.toHaveBeenCalled();
  });

  test('técnico asignado puede resolver, con la versión leída', async () => {
    const { impl, performAction } = port('technician-1');
    await performIncidentAction(impl, { actorId: 'technician-1', role: 'technician' }, 'campus-inc-001', 'resolve', { diagnosis: 'ok' });
    expect(performAction).toHaveBeenCalledWith('campus-inc-001', 'resolve', 3, { diagnosis: 'ok' });
  });

  test('coordinador cierra; reportante no puede cerrar', async () => {
    const { impl } = port('technician-1');
    await expect(performIncidentAction(impl, { actorId: 'coordinator-1', role: 'coordinator' }, 'campus-inc-001', 'close')).resolves.toBeDefined();
    await expect(performIncidentAction(impl, { actorId: 'reporter-1', role: 'reporter' }, 'campus-inc-001', 'close')).rejects.toBeInstanceOf(ForbiddenActionError);
  });
});
