import { initialize, Session, errorMessage, type List, type State } from './backend';

function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  return el as T;
}
const input = (id: string) => element<HTMLInputElement>(id);
const selectionKey = 'encrypted-todo-selected-list';
function savedSelection(): number | undefined {
  try { const value = Number(sessionStorage.getItem(selectionKey)); return Number.isInteger(value) && value > 0 ? value : undefined; }
  catch { return undefined; }
}
function remember(id: number | undefined): void {
  try { if (id === undefined) sessionStorage.removeItem(selectionKey); else sessionStorage.setItem(selectionKey, String(id)); }
  catch { /* Storage preferences are optional; passwords never enter storage. */ }
}

class App {
  private session = new Session();
  private state: State = { lists: [], selected: null };
  private busy = false;
  private initialized = false;
  private create = false;
  private canOpen = false;
  private status(message: string): void { element('status').textContent = message; }
  private controls(): void {
    for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) control.disabled = this.busy || !this.initialized;
    for (const control of element('workspace').querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) control.disabled ||= !this.session.unlocked;
    for (const control of element('access-form').querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) control.disabled ||= !this.canOpen;
    for (const control of element('items-controls').querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) control.disabled ||= !this.state.selected;
    element('app').setAttribute('aria-busy', String(this.busy));
  }
  private clearPasswords(): void {
    for (const id of ['password', 'confirmation', 'new-password', 'new-password-confirm']) input(id).value = '';
  }
  private locked(): void {
    this.state = { lists: [], selected: null };
    this.clearPasswords();
    input('new-list-title').value = '';
    input('new-item-desc').value = '';
    element('key-form').hidden = true;
    element('workspace').hidden = true;
    element('access').hidden = false;
    this.render();
  }
  private async action(operation: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.controls();
    try { await operation(); }
    catch (error) {
      if (!this.session.unlocked) {
        this.locked();
        if (this.initialized) {
          // Creation or key change could have published before an error. Inspect
          // before offering creation again; never automatically retry a write.
          try { await this.inspect(); } catch { /* Preserve the original error below. */ }
        }
      }
      this.status(errorMessage(error));
    } finally { this.busy = false; this.controls(); }
  }
  private async inspect(): Promise<void> {
    const kind = await this.session.inspect();
    this.create = kind === 'missing' || kind === 'empty';
    this.canOpen = kind !== 'plaintext';
    element('access-form').hidden = !this.canOpen;
    element('confirmation-label').hidden = !this.create;
    input('confirmation').required = this.create;
    input('password').autocomplete = this.create ? 'new-password' : 'current-password';
    element('open').textContent = this.create ? 'Create encrypted database' : 'Unlock';
    element('access-title').textContent = this.create ? 'Create your encrypted database' : 'Unlock your database';
    element('access-message').textContent = kind === 'plaintext'
      ? 'A plaintext file exists at this app’s database location. It will not be converted or overwritten.'
      : this.create ? 'Choose a password and confirm it. The database will remain encrypted.'
      : 'Enter your password. Unlocking keeps the stored database encrypted.';
  }
  private show(state: State): void {
    this.state = state;
    remember(state.selected?.id);
    element('access').hidden = true;
    element('workspace').hidden = false;
    this.render();
  }
  private update(list: List): void {
    this.state.selected = list;
    const summary = this.state.lists.find(value => value.id === list.id);
    if (summary) summary.title = list.title;
    this.render();
  }
  private render(): void {
    const lists = element('lists'); lists.replaceChildren();
    for (const list of this.state.lists) {
      const li = document.createElement('li');
      const title = document.createElement('span'); title.textContent = list.title;
      const load = document.createElement('button'); load.type = 'button'; load.textContent = this.state.selected?.id === list.id ? 'Selected' : 'Load';
      load.setAttribute('aria-label', `Load ${list.title}`);
      load.onclick = () => void this.action(async () => { this.show(await this.session.state(list.id)); this.status('List loaded.'); });
      li.append(title, load); lists.append(li);
    }
    if (!this.state.lists.length && this.session.unlocked) lists.textContent = 'No lists yet. Create your first list.';
    const selected = this.state.selected;
    element('current-list-title').textContent = selected?.title ?? 'No lists yet';
    input('list-title').value = selected?.title ?? '';
    element('items-controls').hidden = !selected;
    const items = element('items'); items.replaceChildren();
    for (const item of selected?.items ?? []) {
      const li = document.createElement('li');
      const form = document.createElement('form'); form.className = 'item-form';
      const description = document.createElement('input'); description.required = true; description.value = item.description; description.setAttribute('aria-label', 'Item description');
      const completed = document.createElement('input'); completed.type = 'checkbox'; completed.checked = item.completed;
      const label = document.createElement('label'); label.className = 'completion'; label.append(completed, ' Completed');
      const save = document.createElement('button'); save.textContent = 'Save item';
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete item'; remove.className = 'danger';
      form.onsubmit = event => { event.preventDefault(); void this.action(async () => {
        this.update(await this.session.updateItem(selected!.id, item.id, description.value, completed.checked));
        this.status('Item saved.');
      }); };
      remove.onclick = () => void this.action(async () => { this.update(await this.session.deleteItem(selected!.id, item.id)); this.status('Item deleted.'); });
      form.append(description, label, save, remove); li.append(form); items.append(li);
    }
    if (selected && !selected.items.length) items.textContent = 'This list has no items.';
    this.controls();
  }
  async start(): Promise<void> {
    this.bind();
    await this.action(async () => {
      await initialize(); this.initialized = true;
      await this.inspect(); this.status('Ready.');
    });
  }
  private bind(): void {
    element<HTMLFormElement>('access-form').onsubmit = event => {
      event.preventDefault();
      if (this.busy) return;
      const password = input('password').value;
      const matches = !this.create || password === input('confirmation').value;
      this.clearPasswords();
      void this.action(async () => {
        if (!matches) throw new Error('Passwords do not match.');
        this.status(this.create ? 'Creating encrypted database…' : 'Unlocking…');
        this.show(await this.session.open(password, this.create, savedSelection()));
        this.status('Unlocked. Changes are saved encrypted.');
      });
    };
    element('retry').onclick = () => void this.action(async () => { await this.inspect(); this.status('Storage checked.'); });
    element('refresh').onclick = () => void this.action(async () => { this.show(await this.session.state(this.state.selected?.id)); this.status('Saved data reloaded.'); });
    element('lock').onclick = () => void this.action(async () => { this.session.lock(); this.locked(); await this.inspect(); this.status('Locked.'); });
    element<HTMLFormElement>('create-list-form').onsubmit = event => { event.preventDefault(); void this.action(async () => {
      const list = await this.session.createList(input('new-list-title').value);
      input('new-list-title').value = '';
      this.show(await this.session.state(list.id)); this.status('List created.');
    }); };
    element<HTMLFormElement>('rename-form').onsubmit = event => { event.preventDefault(); void this.action(async () => {
      if (!this.state.selected) return;
      this.update(await this.session.renameList(this.state.selected.id, input('list-title').value)); this.status('List renamed.');
    }); };
    element<HTMLFormElement>('add-item-form').onsubmit = event => { event.preventDefault(); void this.action(async () => {
      if (!this.state.selected) return;
      this.update(await this.session.addItem(this.state.selected.id, input('new-item-desc').value));
      input('new-item-desc').value = ''; this.status('Item added.');
    }); };
    element('delete-list').onclick = () => {
      if (this.busy || !this.state.selected || !confirm(`Delete “${this.state.selected.title}” and all its items?`)) return;
      void this.action(async () => {
        await this.session.deleteList(this.state.selected!.id);
        this.show(await this.session.state()); this.status('List deleted.');
      });
    };
    element('show-key-form').onclick = () => { if (!this.busy) { this.clearPasswords(); element('key-form').hidden = false; input('new-password').focus(); } };
    element('cancel-key').onclick = () => { if (!this.busy) { this.clearPasswords(); element('key-form').hidden = true; } };
    element<HTMLFormElement>('key-form').onsubmit = event => {
      event.preventDefault(); if (this.busy) return;
      const password = input('new-password').value;
      const matches = password === input('new-password-confirm').value;
      this.clearPasswords();
      void this.action(async () => {
        if (!matches) throw new Error('Passwords do not match.');
        this.status('Changing password…');
        await this.session.changePassword(password);
        element('key-form').hidden = true;
        this.status('Password changed. Use the new password after locking or reloading.');
      });
    };
    element('download-db').onclick = () => void this.action(async () => {
      const bytes = await this.session.export();
      const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: 'application/vnd.sqlite3' }));
      const link = document.createElement('a'); link.href = url; link.download = 'todo-encrypted.sqlite'; document.body.append(link);
      try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
      this.status('Encrypted download requested. It uses the password current when exported.');
    });
    window.addEventListener('pagehide', () => { if (!this.session.busy) { this.session.lock(); this.locked(); } });
    window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  }
}
void new App().start();
