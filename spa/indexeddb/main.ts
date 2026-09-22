import wasm_init, { Database, TodoList, apply_schema, db_is_encrypted } from "../../ffi/pkg/ffi.js";

/**
 * Application state
 */
class AppState {
    db: Database | null = null;
    currentListId: number | null = null;
    currentList: TodoList | null = null;

    setDatabase(db: Database): void {
        this.db = db;
    }

    canPerformOperations(): boolean {
        return this.db !== null;
    }

    async loadList(id: number): Promise<void> {
        if (!this.db) throw new Error("Database not initialized");

        // Free the previous list if it exists
        if (this.currentList) {
            try { this.currentList.free(); } catch { /* ignore */ }
        }

        this.currentList = await TodoList.load(this.db, id);
        this.currentListId = id;
    }

    unloadList(): void {
        if (this.currentList) {
            try { this.currentList.free(); } catch { /* ignore */ }
        }
        this.currentList = null;
        this.currentListId = null;
    }

    async saveCurrentList(): Promise<void> {
        if (!this.db || !this.currentList) {
            throw new Error("No list loaded");
        }
        await this.currentList.save(this.db);
    }
}

/**
 * DOM element references
 */
class DOMElements {
    readonly status = this.get<HTMLDivElement>('#status');
    readonly listsEl = this.get<HTMLUListElement>('#lists');
    readonly itemsEl = this.get<HTMLUListElement>('#items');
    readonly currentListTitle = this.get<HTMLHeadingElement>('#current-list-title');
    readonly itemsControls = this.get<HTMLDivElement>('#items-controls');
    readonly newListTitleInput = this.get<HTMLInputElement>('#new-list-title');
    readonly createListBtn = this.get<HTMLButtonElement>('#create-list');
    readonly newItemDescInput = this.get<HTMLInputElement>('#new-item-desc');
    readonly addItemBtn = this.get<HTMLButtonElement>('#add-item');
    readonly saveListBtn = this.get<HTMLButtonElement>('#save-list');
    readonly deleteListBtn = this.get<HTMLButtonElement>('#delete-list');
    readonly downloadDbBtn = this.get<HTMLButtonElement>('#download-db');
    readonly checkEncryptionBtn = this.get<HTMLButtonElement>('#check-encryption');
    readonly setEncryptionBtn = this.get<HTMLButtonElement>('#set-encryption');
    readonly encryptionStatus = this.get<HTMLDivElement>('#encryption-status');
    readonly passphraseModal = this.get<HTMLDivElement>('#passphrase-modal');
    readonly modalTitle = this.get<HTMLHeadingElement>('#modal-title');
    readonly modalMessage = this.get<HTMLParagraphElement>('#modal-message');
    readonly passphraseForm = this.get<HTMLFormElement>('#passphrase-form');
    readonly passphraseInput = this.get<HTMLInputElement>('#passphrase-input');
    readonly modalSubmit = this.get<HTMLButtonElement>('#modal-submit');
    readonly modalCancel = this.get<HTMLButtonElement>('#modal-cancel');
    readonly modalError = this.get<HTMLDivElement>('#modal-error');

    private get<T extends HTMLElement>(selector: string): T {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Missing element: ${selector}`);
        return el as T;
    }

    clearChildren(el: HTMLElement): void {
        while (el.firstChild) {
            el.removeChild(el.firstChild);
        }
    }
}

/**
 * Main application controller
 */
class TodoApp {
    private state = new AppState();
    private dom = new DOMElements();

    async init(): Promise<void> {
        console.log('[INIT] Starting initialization');
        await wasm_init("./ffi_bg.wasm");
        console.log('[INIT] WASM initialized');
        this.setStatus('Connecting to database...');

        // Ensure modal is hidden on startup
        console.log('[INIT] Hiding modal on startup');
        this.hideModal();

        // Check encryption before opening a connection — the key must be
        // provided as the first operation on an encrypted connection.
        console.log('[INIT] Checking if database is encrypted...');
        const isEncrypted = await db_is_encrypted('todo_app');
        console.log('[INIT] Database encrypted:', isEncrypted);

        let db: Database;
        if (isEncrypted) {
            // Connect with key; modal stays open until the passphrase is correct or the user cancels.
            console.log('[INIT] Connecting to encrypted database...');
            const result = await this.promptAndConnectEncrypted('todo_app');
            if (result === null) {
                this.setStatus('Connection cancelled — reload the page to try again');
                console.log('[INIT] Attaching event listeners (no db)');
                this.attachEventListeners();
                this.updateEncryptionStatus();
                this.updateEncryptionButton();
                return;
            }
            db = result;
        } else {
            db = await Database.connect('todo_app');
            console.log('[INIT] Applying schema');
            await apply_schema(db);
        }

        console.log('[INIT] Database connected');
        this.state.setDatabase(db);

        this.setStatus('Loading lists...');
        console.log('[INIT] Loading lists');
        await this.renderLists();

        this.setStatus('Ready');

        console.log('[INIT] Attaching event listeners');
        this.attachEventListeners();

        // Check encryption status and update button text
        console.log('[INIT] Updating encryption status display');
        this.updateEncryptionStatus();
        this.updateEncryptionButton();
        console.log('[INIT] Initialization complete');
    }

    private setStatus(text: string): void {
        this.dom.status.textContent = text;
    }

    private attachEventListeners(): void {
        console.log('[EVENTS] Attaching event listeners');
        this.dom.createListBtn.addEventListener('click', () => this.handleCreateList());
        this.dom.addItemBtn.addEventListener('click', () => this.handleAddItem());
        this.dom.saveListBtn.addEventListener('click', () => this.handleSaveList());
        this.dom.deleteListBtn.addEventListener('click', () => this.handleDeleteList());
        this.dom.downloadDbBtn.addEventListener('click', () => this.handleDownloadDatabase());
        this.dom.checkEncryptionBtn.addEventListener('click', () => {
            console.log('[EVENTS] Check encryption button clicked');
            this.updateEncryptionStatus();
            this.updateEncryptionButton();
        });
        this.dom.setEncryptionBtn.addEventListener('click', async () => {
            console.log('[EVENTS] Encryption button clicked');
            await this.handleEncryptionButtonClick();
        });
        // Note: Modal cancel button is handled by individual modal functions to avoid conflicts
        console.log('[EVENTS] Event listeners attached');
    }

    // ==================== List Management ====================

    private async renderLists(): Promise<void> {
        this.dom.clearChildren(this.dom.listsEl);

        if (!this.state.canPerformOperations()) return;

        const all = await TodoList.list_all(this.state.db!);
        const entries = all.map(([id, title]) => ({ id: Number(id), title }));
        entries.sort((a, b) => a.id - b.id);

        for (const entry of entries) {
            const li = this.createListElement(entry);
            this.dom.listsEl.appendChild(li);
        }
    }

    private createListElement(entry: { id: number; title: string }): HTMLLIElement {
        const li = document.createElement('li');

        const left = document.createElement('div');
        left.className = 'item-left';

        const titleSpan = document.createElement('span');
        titleSpan.textContent = entry.title;

        const idSpan = document.createElement('span');
        idSpan.className = 'small';
        idSpan.textContent = `#${entry.id}`;

        left.appendChild(titleSpan);
        left.appendChild(idSpan);

        const loadBtn = document.createElement('button');
        loadBtn.textContent = 'Load';
        loadBtn.onclick = () => this.handleLoadList(entry.id);

        li.appendChild(left);
        li.appendChild(loadBtn);

        return li;
    }

    private async handleCreateList(): Promise<void> {
        if (!this.state.canPerformOperations()) {
            this.showOperationBlockedMessage();
            return;
        }

        const title = this.dom.newListTitleInput.value.trim();
        if (!title) return;

        try {
            this.setStatus('Creating list...');
            const list = await TodoList.new(this.state.db!, title);
            await list.save(this.state.db!);

            this.dom.newListTitleInput.value = '';
            await this.renderLists();

            this.setStatus('List created');
            await this.handleLoadList(list.id());
        } catch (err) {
            console.error(err);
            this.setStatus('Failed to create list: ' + this.getErrorMessage(err));
        }
    }

    private async handleLoadList(id: number): Promise<void> {
        if (!this.state.canPerformOperations()) {
            this.showOperationBlockedMessage();
            return;
        }

        try {
            this.setStatus(`Loading list #${id}...`);
            await this.state.loadList(id);
            this.renderItems();
            this.setStatus('List loaded');
        } catch (err) {
            console.error(err);
            this.setStatus('Failed to load list: ' + this.getErrorMessage(err));
        }
    }

    private async handleDeleteList(): Promise<void> {
        if (!this.state.db || !this.state.currentList) return;
        if (!confirm('Delete this list? This cannot be undone.')) return;

        try {
            const id = this.state.currentList.id();
            const ok = await TodoList.delete(this.state.db, id);

            if (ok) {
                this.setStatus('List deleted');
                this.state.unloadList();
                this.renderItems();
                await this.renderLists();
            } else {
                this.setStatus('List not found');
            }
        } catch (err) {
            console.error(err);
            this.setStatus('Failed to delete list: ' + this.getErrorMessage(err));
        }
    }

    private async handleSaveList(): Promise<void> {
        try {
            this.setStatus('Saving list...');
            await this.state.saveCurrentList();
            this.setStatus('List saved');
            await this.renderLists();
        } catch (err) {
            console.error(err);
            this.setStatus('Failed to save list: ' + this.getErrorMessage(err));
        }
    }

    // ==================== Item Management ====================

    private renderItems(): void {
        this.dom.clearChildren(this.dom.itemsEl);

        if (!this.state.currentList) {
            this.dom.currentListTitle.textContent = 'No list loaded';
            this.dom.itemsControls.classList.add('hidden');
            return;
        }

        this.dom.currentListTitle.textContent = this.state.currentList.title();
        this.dom.itemsControls.classList.remove('hidden');

        const itemIds = this.state.currentList.item_ids();
        for (let i = 0; i < itemIds.length; i++) {
            const itemId = itemIds[i];
            const itemEl = this.createItemElement(itemId);
            if (itemEl) {
                this.dom.itemsEl.appendChild(itemEl);
            }
        }
    }

    private createItemElement(itemId: number): HTMLLIElement | null {
        if (!this.state.currentList) return null;

        const item = this.state.currentList.item(itemId);
        if (!item) return null;

        const li = document.createElement('li');

        // Left side: checkbox and description
        const left = document.createElement('div');
        left.className = 'item-left';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = item.is_completed();
        checkbox.onchange = () => this.handleToggleItem(itemId, checkbox.checked);

        const desc = document.createElement('span');
        desc.className = 'item-desc';
        if (item.is_completed()) {
            desc.classList.add('completed');
        }
        desc.textContent = item.description();

        left.appendChild(checkbox);
        left.appendChild(desc);

        // Right side: buttons
        const right = document.createElement('div');
        right.style.display = 'flex';
        right.style.gap = '8px';

        const editBtn = document.createElement('button');
        editBtn.textContent = 'Edit';
        editBtn.onclick = () => this.handleEditItem(itemId);

        const removeBtn = document.createElement('button');
        removeBtn.textContent = 'Remove';
        removeBtn.className = 'danger';
        removeBtn.onclick = () => this.handleRemoveItem(itemId);

        right.appendChild(editBtn);
        right.appendChild(removeBtn);

        li.appendChild(left);
        li.appendChild(right);

        return li;
    }

    private async handleToggleItem(itemId: number, checked: boolean): Promise<void> {
        if (!this.state.currentList || !this.state.db) return;

        try {
            // Use the new set_item_completed method to modify the item directly in the list
            const result = this.state.currentList.set_item_completed(itemId, checked);

            if (result === undefined) {
                this.setStatus('Item not found');
                return;
            }

            // Save to database
            await this.state.saveCurrentList();

            // Re-render to show updated state
            this.renderItems();
        } catch (err) {
            console.error(err);
            this.setStatus('Failed to toggle item: ' + this.getErrorMessage(err));
        }
    }

    private async handleEditItem(itemId: number): Promise<void> {
        if (!this.state.currentList || !this.state.db) return;

        const item = this.state.currentList.item(itemId);
        if (!item) return;

        const newDesc = prompt('Edit item description', item.description());
        if (newDesc === null) return;

        try {
            // Use the new set_item_description method to modify the item directly in the list
            const result = this.state.currentList.set_item_description(itemId, newDesc);

            if (result === undefined) {
                this.setStatus('Item not found');
                return;
            }

            await this.state.saveCurrentList();
            this.renderItems();
            this.setStatus('Item updated');
        } catch (err) {
            console.error(err);
            this.setStatus('Failed to edit item: ' + this.getErrorMessage(err));
        }
    }

    private async handleRemoveItem(itemId: number): Promise<void> {
        if (!this.state.currentList || !this.state.db) return;

        try {
            const ok = await this.state.currentList.remove_item(this.state.db, itemId);
            if (ok) {
                await this.state.saveCurrentList();
                this.renderItems();
                this.setStatus('Item removed');
            } else {
                this.setStatus('Item not found');
            }
        } catch (err) {
            console.error(err);
            this.setStatus('Failed to remove item: ' + this.getErrorMessage(err));
        }
    }

    private async handleAddItem(): Promise<void> {
        if (!this.state.currentList || !this.state.db) {
            alert('Load a list first');
            return;
        }

        const desc = this.dom.newItemDescInput.value.trim();
        if (!desc) return;

        try {
            this.setStatus('Adding item...');
            await this.state.currentList.add_item(this.state.db, desc);
            await this.state.saveCurrentList();

            this.dom.newItemDescInput.value = '';
            this.renderItems();
            this.setStatus('Item added');
        } catch (err) {
            console.error(err);
            this.setStatus('Failed to add item: ' + this.getErrorMessage(err));
        }
    }

    // ==================== Utilities ====================

    private getErrorMessage(err: unknown): string {
        if (err instanceof Error) {
            // Check if it has an error chain from the proxy
            if ((err as any).errorChain) {
                const chain = (err as any).errorChain as string[];
                return chain.join('\n  Caused by: ');
            }
            return err.message;
        }

        // Handle structured error objects
        if (err && typeof err === 'object') {
            // Try toString() first
            const str = err.toString();
            if (str && str !== '[object Object]') {
                return str;
            }

            // Try to extract useful properties
            try {
                const parts: string[] = [];
                for (const [key, value] of Object.entries(err)) {
                    if (typeof value !== 'function' && !(value instanceof Map) && !(value instanceof Set)) {
                        parts.push(`${key}: ${String(value)}`);
                    }
                }
                if (parts.length > 0) {
                    return parts.join(', ');
                }
            } catch {
                // Fall through
            }
        }

        return String(err);
    }

    private showOperationBlockedMessage(): void {
        alert('Database is encrypted. Please decrypt it first using the correct passphrase.');
    }

    // ==================== Encryption Management ====================

    private showModal(): void {
        console.log('[MODAL] Showing modal');
        console.log('[MODAL] Modal element:', this.dom.passphraseModal);
        console.log('[MODAL] Modal classes before:', this.dom.passphraseModal.className);
        this.dom.passphraseModal.classList.remove('hidden');
        console.log('[MODAL] Modal classes after:', this.dom.passphraseModal.className);
        this.dom.passphraseInput.value = '';
        this.dom.modalError.classList.add('hidden');
        this.dom.passphraseInput.focus();
    }

    private hideModal(): void {
        console.log('[MODAL] Hiding modal');
        console.log('[MODAL] Modal classes before:', this.dom.passphraseModal.className);
        this.dom.passphraseModal.classList.add('hidden');
        console.log('[MODAL] Modal classes after:', this.dom.passphraseModal.className);
        this.dom.passphraseInput.value = '';
        this.dom.modalError.classList.add('hidden');
    }

    private showModalError(message: string): void {
        this.dom.modalError.textContent = message;
        this.dom.modalError.classList.remove('hidden');
    }

    /// Open a passphrase modal and attempt `Database.connect_with_key`.
    /// Keeps the modal open on wrong passphrase; resolves with the connected
    /// Database on success, or null if the user cancels.
    private async promptAndConnectEncrypted(name: string): Promise<Database | null> {
        console.log('[DECRYPT] Setting up decrypt modal');
        this.dom.modalTitle.textContent = 'Decrypt Database';
        this.dom.modalMessage.textContent = 'This database is encrypted. Enter the passphrase to unlock it.';
        this.dom.passphraseInput.required = true;

        return new Promise<Database | null>((resolve) => {
            const handleSubmit = async (e: Event) => {
                console.log('[DECRYPT] Form submitted');
                e.preventDefault();
                const passphrase = this.dom.passphraseInput.value;
                console.log('[DECRYPT] Attempting connection with passphrase length:', passphrase.length);

                try {
                    const db = await Database.connect_with_key(name, passphrase);
                    console.log('[DECRYPT] Connection successful');
                    this.hideModal();
                    cleanup();
                    resolve(db);
                } catch (err) {
                    console.error('[DECRYPT] Connection failed:', err);
                    this.showModalError('Incorrect passphrase. Please try again.');
                }
            };

            const handleCancel = (e: Event) => {
                console.log('[DECRYPT] Cancel button clicked');
                e.preventDefault();
                this.hideModal();
                cleanup();
                resolve(null);
            };

            const cleanup = () => {
                console.log('[DECRYPT] Cleaning up event listeners');
                this.dom.passphraseForm.removeEventListener('submit', handleSubmit);
                this.dom.modalCancel.removeEventListener('click', handleCancel);
            };

            console.log('[DECRYPT] Adding event listeners');
            this.dom.passphraseForm.addEventListener('submit', handleSubmit);
            this.dom.modalCancel.addEventListener('click', handleCancel);

            this.showModal();
        });
    }

    private async handleEncryptionButtonClick(): Promise<void> {
        if (!this.state.db) {
            alert('No database connected');
            return;
        }

        // If we have a Database instance it is already open and usable;
        // decryption happens during construction. Just handle set/reset/remove.
        await this.handleSetEncryption();
    }

    private async handleSetEncryption(): Promise<void> {
        console.log('[SET_ENCRYPTION] Starting set encryption handler');
        if (!this.state.db) {
            console.log('[SET_ENCRYPTION] No database connected');
            alert('No database connected');
            return;
        }

        const isEncrypted = this.state.db.is_encrypted();
        console.log('[SET_ENCRYPTION] Database encrypted:', isEncrypted);

        const action = isEncrypted ? 'Reset' : 'Set';
        console.log('[SET_ENCRYPTION] Action:', action);
        this.dom.modalTitle.textContent = `${action} Encryption Key`;
        this.dom.modalMessage.textContent = isEncrypted
            ? 'Enter a new passphrase to re-encrypt the database, or leave empty to remove encryption.'
            : 'Enter a passphrase to encrypt the database, or leave empty to cancel.';
        // Allow empty passphrase for set/reset (to clear encryption)
        this.dom.passphraseInput.required = false;

        return new Promise<void>((resolve) => {
            const handleSubmit = async (e: Event) => {
                console.log('[SET_ENCRYPTION] Form submitted');
                e.preventDefault();
                const passphrase = this.dom.passphraseInput.value;
                console.log('[SET_ENCRYPTION] Passphrase length:', passphrase.length);

                if (!isEncrypted && passphrase === '') {
                    console.log('[SET_ENCRYPTION] Empty passphrase on unencrypted DB, cancelling');
                    this.hideModal();
                    cleanup();
                    resolve();
                    return;
                }

                try {
                    console.log('[SET_ENCRYPTION] Setting encryption key...');
                    this.setStatus('Updating encryption...');
                    this.state.db!.set_key(passphrase);

                    if (passphrase === '') {
                        console.log('[SET_ENCRYPTION] Encryption removed');
                        this.setStatus('Encryption removed');
                    } else {
                        console.log('[SET_ENCRYPTION] Encryption key set');
                        this.setStatus('Encryption key set successfully');
                    }

                    this.hideModal();
                    this.updateEncryptionStatus();
                    this.updateEncryptionButton();
                    cleanup();
                    resolve();
                } catch (err) {
                    console.error('[SET_ENCRYPTION] Failed to set encryption:', err);
                    this.showModalError('Failed to set encryption: ' + this.getErrorMessage(err));
                }
            };

            const handleCancel = (e: Event) => {
                console.log('[SET_ENCRYPTION] Cancel button clicked');
                e.preventDefault();
                this.hideModal();
                cleanup();
                resolve();
            };

            const cleanup = () => {
                console.log('[SET_ENCRYPTION] Cleaning up event listeners');
                this.dom.passphraseForm.removeEventListener('submit', handleSubmit);
                this.dom.modalCancel.removeEventListener('click', handleCancel);
            };

            console.log('[SET_ENCRYPTION] Adding event listeners');
            this.dom.passphraseForm.addEventListener('submit', handleSubmit);
            this.dom.modalCancel.addEventListener('click', handleCancel);

            this.showModal();
        });
    }

    private updateEncryptionButton(): void {
        if (!this.state.db) {
            return;
        }

        try {
            const isEncrypted = this.state.db.is_encrypted();
            this.dom.setEncryptionBtn.textContent = isEncrypted ? 'Reset Encryption Key' : 'Set Encryption Key';
        } catch (err) {
            console.error('[BUTTON] Failed to update encryption button:', err);
        }
    }

    private updateEncryptionStatus(): void {
        console.log('[STATUS] Updating encryption status');
        if (!this.state.db) {
            console.log('[STATUS] No database connected');
            this.dom.encryptionStatus.textContent = 'No database connected';
            this.dom.encryptionStatus.className = 'info-display error';
            return;
        }

        try {
            const isEncrypted = this.state.db.is_encrypted();
            console.log('[STATUS] Encrypted:', isEncrypted);

            if (isEncrypted) {
                this.dom.encryptionStatus.textContent = '🔒 Database is encrypted';
                this.dom.encryptionStatus.className = 'info-display encrypted';
            } else {
                this.dom.encryptionStatus.textContent = '🔓 Database is not encrypted';
                this.dom.encryptionStatus.className = 'info-display not-encrypted';
            }
        } catch (err) {
            console.error('[STATUS] Failed to check encryption:', err);
            this.dom.encryptionStatus.textContent = '⚠️ Failed to check encryption: ' + this.getErrorMessage(err);
            this.dom.encryptionStatus.className = 'info-display error';
        }
    }

    private async handleDownloadDatabase(): Promise<void> {
        if (!this.state.db) {
            alert('No database connected');
            return;
        }

        try {
            this.setStatus('Downloading database...');

            // Get the database name
            const dbName = this.state.db.name();

            // Export the database contents
            const data = this.state.db.export();

            // Create a Blob from the data
            // Cast to BlobPart - Uint8Array is a valid BufferSource
            const blob = new Blob([data as BlobPart], { type: 'application/x-sqlite3' });

            // Create a download link
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = dbName.endsWith('.sqlite') || dbName.endsWith('.db') ? dbName : `${dbName}.sqlite`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            // Clean up the object URL
            URL.revokeObjectURL(url);

            this.setStatus('Database downloaded successfully');
        } catch (err) {
            console.error('Failed to download database:', err);
            this.setStatus('Failed to download database: ' + this.getErrorMessage(err));
        }
    }

}

// Initialize the app
const app = new TodoApp();

/**
 * Format an error for display - returns both brief and detailed versions
 */
function formatError(err: unknown): { brief: string; detailed: string } {
    if (err instanceof Error) {
        const brief = err.message;

        // Check if it has an error chain from the proxy
        if ((err as any).errorChain) {
            const chain = (err as any).errorChain as string[];
            const detailed = chain.join('\n  Caused by: ');
            return { brief, detailed };
        }

        // Use stack if available for detailed view
        const detailed = err.stack || err.message;
        return { brief, detailed };
    }

    // Handle structured error objects
    if (err && typeof err === 'object') {
        // Try toString() first
        const str = err.toString();
        if (str && str !== '[object Object]') {
            return { brief: str, detailed: str };
        }

        // Try to extract useful properties (avoid non-serializable objects)
        try {
            const parts: string[] = [];
            for (const [key, value] of Object.entries(err)) {
                if (typeof value !== 'function' && !(value instanceof Map) && !(value instanceof Set)) {
                    parts.push(`${key}: ${String(value)}`);
                }
            }
            if (parts.length > 0) {
                const msg = parts.join(', ');
                return { brief: msg, detailed: msg };
            }
        } catch {
            // Fall through to default
        }
    }

    const fallback = String(err);
    return { brief: fallback, detailed: fallback };
}

window.addEventListener('load', async () => {
    try {
        await app.init();
    } catch (err) {
        const { brief, detailed } = formatError(err);

        // Log detailed error to console
        console.error('Failed to initialize app:', err);
        console.error('Error details:', detailed);

        // Show brief error in status line
        document.querySelector('#status')!.textContent = 'Failed to initialize: ' + brief;
    }
});
