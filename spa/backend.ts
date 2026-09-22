import init, * as wasm from '../jspi-probe/pkg-encryption/jspi_probe.js';
import { parseList, parseState, type List, type State } from './state';
export type { List, State } from './state';

export const DATABASE = 'todo-app-encrypted.sqlite';
const ready = async () => {};
const noPublish = async () => { throw new Error('A read operation attempted to publish'); };
export type Api = Pick<typeof wasm, 'app_inspect' | 'app_create' | 'app_state' | 'app_create_list' |
  'app_change_key' | 'todo_add_item' | 'todo_update_item' | 'todo_delete_item' |
  'todo_rename_list' | 'todo_delete_list' | 'todo_export'>;

export function capabilityError(): string | null {
  const wa = WebAssembly as typeof WebAssembly & { promising?: unknown; Suspending?: unknown };
  if (!globalThis.isSecureContext) return 'This app requires HTTPS or localhost.';
  if (typeof wa.promising !== 'function' || typeof wa.Suspending !== 'function') return 'This browser does not support WebAssembly JSPI.';
  if (!navigator.storage?.getDirectory) return 'This browser does not provide OPFS storage.';
  if (!navigator.locks?.request) return 'This browser does not provide Web Locks.';
  return null;
}
let initialization: Promise<unknown> | undefined;
export async function initialize(): Promise<void> {
  const unsupported = capabilityError();
  if (unsupported) throw new Error(unsupported);
  // Explicit URL stays next to the emitted browser entry script after bundling.
  initialization ??= init({ module_or_path: new URL('./jspi_probe_bg.wasm', import.meta.url) }).catch(error => {
    initialization = undefined;
    throw error;
  });
  await initialization;
}

export function errorCode(error: unknown): number | undefined {
  return error && typeof error === 'object' && 'sqliteCode' in error ? Number(error.sqliteCode) : undefined;
}
export function errorMessage(error: unknown): string {
  if (errorCode(error) === 5) return 'Another tab is using this database. Try again after its operation finishes.';
  if (errorCode(error) === 26) return 'The password is incorrect, the key changed in another tab, or the database is unreadable.';
  if (errorCode(error) === 1034) return 'Storage publication failed. The operation may have committed. Unlock and inspect the saved data before retrying.';
  return error instanceof Error ? error.message : String(error);
}

/** Plain snapshots only: no live WASM objects survive a call. */
export class Session {
  #key: string | null = null;
  #busy = false;
  constructor(readonly name = DATABASE, private api: Api = wasm, private hook: () => Promise<void> = ready) {}
  get unlocked(): boolean { return this.#key !== null; }
  get busy(): boolean { return this.#busy; }
  lock(): void {
    if (this.#busy) throw new Error('Wait for the current operation before locking.');
    this.#key = null;
  }
  async #run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new Error('An operation is already running.');
    this.#busy = true;
    try { return await operation(); }
    catch (error) {
      // A key may have changed in another tab; a failed publication may have committed.
      if ([26, 1034].includes(errorCode(error) ?? 0)) this.#key = null;
      throw error;
    } finally { this.#busy = false; }
  }
  #password(): string {
    if (this.#key === null) throw new Error('Unlock the database first.');
    return this.#key;
  }
  inspect(): Promise<string> { return this.#run(() => this.api.app_inspect(this.name)); }
  open(password: string, create: boolean, selected?: number): Promise<State> {
    if (!password) return Promise.reject(new Error('A password is required.'));
    return this.#run(async () => {
      this.#key = null;
      const value = create ? await this.api.app_create(this.name, password, this.hook)
        : await this.api.app_state(this.name, password, selected, noPublish);
      const state = parseState(value);
      this.#key = password;
      return state;
    });
  }
  state(selected?: number): Promise<State> {
    return this.#run(async () => parseState(await this.api.app_state(this.name, this.#password(), selected, noPublish)));
  }
  createList(title: string): Promise<List> {
    return this.#run(async () => parseList(await this.api.app_create_list(this.name, this.#password(), title, this.hook)));
  }
  renameList(id: number, title: string): Promise<List> {
    return this.#run(async () => parseList(await this.api.todo_rename_list(this.name, id, title, this.hook, this.#password())));
  }
  deleteList(id: number): Promise<void> {
    return this.#run(() => this.api.todo_delete_list(this.name, id, this.hook, this.#password()));
  }
  addItem(id: number, description: string): Promise<List> {
    return this.#run(async () => parseList(await this.api.todo_add_item(this.name, id, description, this.hook, this.#password())));
  }
  updateItem(id: number, item: number, description: string, completed: boolean): Promise<List> {
    return this.#run(async () => parseList(await this.api.todo_update_item(this.name, id, item, description, completed, this.hook, this.#password())));
  }
  deleteItem(id: number, item: number): Promise<List> {
    return this.#run(async () => parseList(await this.api.todo_delete_item(this.name, id, item, this.hook, this.#password())));
  }
  export(): Promise<Uint8Array> {
    return this.#run(() => this.api.todo_export(this.name, noPublish, this.#password()));
  }
  changePassword(replacement: string): Promise<void> {
    if (!replacement) return Promise.reject(new Error('The new password must not be empty. Encryption cannot be removed.'));
    return this.#run(async () => {
      try {
        await this.api.app_change_key(this.name, this.#password(), replacement, this.hook);
        this.#key = replacement;
      } catch (error) {
        // Never guess which password is current after an ambiguous key-change failure.
        this.#key = null;
        throw error;
      }
    });
  }
}
