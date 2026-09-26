/** Binary model storage. Model bytes must never be placed in chrome.storage. */
export interface ModelStorage {
  has(id: string): Promise<boolean>;
  read(id: string): Promise<ArrayBuffer>;
  write(id: string, data: ArrayBuffer): Promise<void>;
  remove(id: string): Promise<void>;
}

const DB = 'prosopon-emotion-models';
const STORE = 'models';

/** IndexedDB Blob storage works in both MV3 service workers and offscreen documents. */
export class IndexedDbModelStorage implements ModelStorage {
  private db: Promise<IDBDatabase> | null = null;

  has(id: string): Promise<boolean> {
    return this.get(id).then((v) => v !== undefined);
  }

  async read(id: string): Promise<ArrayBuffer> {
    const value = await this.get(id);
    if (!(value instanceof Blob)) throw new Error('emotion model is not installed');
    return value.arrayBuffer();
  }

  async write(id: string, data: ArrayBuffer): Promise<void> {
    // Transfer the downloaded buffer into the Blob once; after this transaction commits the caller drops it.
    await this.transaction('readwrite', (store) => store.put(new Blob([data]), id));
  }

  async remove(id: string): Promise<void> {
    await this.transaction('readwrite', (store) => store.delete(id));
  }

  private async get(id: string): Promise<unknown> {
    return this.transaction('readonly', (store) => store.get(id));
  }

  private async transaction(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = operation(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('model storage request failed'));
      tx.onabort = () => reject(tx.error ?? new Error('model storage transaction aborted'));
    });
  }

  private open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('cannot open model storage'));
    });
    return this.db;
  }
}
