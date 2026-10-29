/** Test bridge runs the real Main handlers without starting Electron or SSH. */
export const handlers = new Map<string, (...args: any[]) => unknown>();
export const ipcMain = { handle: (name: string, handler: (...args: any[]) => unknown) => { handlers.set(name, handler); } };
