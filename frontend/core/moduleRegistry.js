const registeredUiModules = [
  {
    id: 'caja',
    label: 'Turnos',
    roles: ['CAJERO', 'SUPERVISOR', 'DUENO', 'SOPORTE'],
  },
  {
    id: 'pos',
    label: 'Cobro',
    roles: ['CAJERO', 'SUPERVISOR', 'DUENO', 'SOPORTE'],
  },
  {
    id: 'movimientos',
    label: 'Entrada / Salida',
    roles: ['CAJERO', 'SUPERVISOR', 'DUENO', 'SOPORTE'],
  },
  {
    id: 'supervisor',
    label: 'Supervisor',
    roles: ['SUPERVISOR', 'DUENO', 'SOPORTE'],
  },
  {
    id: 'dashboard',
    label: 'Métricas',
    roles: ['DUENO', 'SOPORTE'],
  },
  {
    id: 'catalogo',
    label: 'Catálogo',
    roles: ['DUENO', 'SOPORTE'],
  },
  {
    id: 'personal',
    label: 'Personal',
    roles: ['DUENO', 'SOPORTE'],
  },
  {
    id: 'auditoria',
    label: 'Auditoría',
    roles: ['DUENO', 'SOPORTE'],
  },
];

export const uiModuleRegistry = {
  register(mod) {
    if (!registeredUiModules.some((m) => m.id === mod.id)) {
      registeredUiModules.push(mod);
    }
  },
  getVisibleModules(userRol) {
    return registeredUiModules.filter((m) => !m.roles || m.roles.includes(userRol));
  },
};
