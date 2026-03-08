/**
 * slideStorage.js — IndexedDB wrapper
 * EventControlSystem v1.0
 * ─────────────────────────────────────────────────────────
 * Esquema:
 *   DB: EventControlDB  v1
 *   stores:
 *     presentations  { id, name, type, totalSlides, createdAt }
 *     slides         { id, presentationId, slideIndex, image, width, height, createdAt }
 *     scenes         { id, name, order, lateral:{...}, central:{...}, createdAt }
 */

const DB_NAME    = 'EventControlDB';
const DB_VERSION = 1;

class SlideStorage {
  constructor() {
    this.db    = null;
    this.ready = this._init();
  }

  // ── Inicialización ──────────────────────────────────────
  _init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onerror = () => reject(req.error);

      req.onsuccess = () => {
        this.db = req.result;
        resolve(this.db);
      };

      req.onupgradeneeded = e => {
        const db = e.target.result;

        if (!db.objectStoreNames.contains('presentations')) {
          const s = db.createObjectStore('presentations', { keyPath: 'id' });
          s.createIndex('createdAt', 'createdAt', { unique: false });
        }

        if (!db.objectStoreNames.contains('slides')) {
          const s = db.createObjectStore('slides', { keyPath: 'id' });
          s.createIndex('presentationId', 'presentationId', { unique: false });
          s.createIndex('slideIndex',     'slideIndex',     { unique: false });
        }

        if (!db.objectStoreNames.contains('scenes')) {
          const s = db.createObjectStore('scenes', { keyPath: 'id' });
          s.createIndex('order', 'order', { unique: false });
        }
      };
    });
  }

  async _ready() { await this.ready; }

  _tx(store, mode = 'readonly') {
    return this.db.transaction(store, mode).objectStore(store);
  }

  _promisify(req) {
    return new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
  }

  // ── Presentations ───────────────────────────────────────
  async savePresentation(p)  { await this._ready(); return this._promisify(this._tx('presentations','readwrite').put(p)); }
  async getPresentation(id)  { await this._ready(); return this._promisify(this._tx('presentations').get(id)); }
  async getAllPresentations() { await this._ready(); return this._promisify(this._tx('presentations').getAll()); }

  async deletePresentation(id) {
    await this._ready();
    await this.deleteSlidesByPresentation(id);
    return this._promisify(this._tx('presentations','readwrite').delete(id));
  }

  // ── Slides ──────────────────────────────────────────────
  async saveSlide(slide) { await this._ready(); return this._promisify(this._tx('slides','readwrite').put(slide)); }

  async getSlide(presentationId, slideIndex) {
    await this._ready();
    return this._promisify(this._tx('slides').get(`${presentationId}_${slideIndex}`));
  }

  async getSlidesByPresentation(presentationId) {
    await this._ready();
    const slides = await this._promisify(this._tx('slides').index('presentationId').getAll(presentationId));
    return slides.sort((a, b) => a.slideIndex - b.slideIndex);
  }

  async getSlideCount(presentationId) {
    await this._ready();
    return this._promisify(this._tx('slides').index('presentationId').count(presentationId));
  }

  async deleteSlidesByPresentation(presentationId) {
    await this._ready();
    const slides = await this.getSlidesByPresentation(presentationId);
    if (!slides.length) return;

    const store = this._tx('slides', 'readwrite');
    return new Promise((res, rej) => {
      let pending = slides.length;
      slides.forEach(s => {
        const r = store.delete(s.id);
        r.onsuccess = () => { if (--pending === 0) res(); };
        r.onerror   = () => rej(r.error);
      });
    });
  }

  // ── Scenes ──────────────────────────────────────────────
  async saveScene(scene)   { await this._ready(); return this._promisify(this._tx('scenes','readwrite').put(scene)); }
  async getScene(id)       { await this._ready(); return this._promisify(this._tx('scenes').get(id)); }
  async deleteScene(id)    { await this._ready(); return this._promisify(this._tx('scenes','readwrite').delete(id)); }
  async getAllScenes() {
    await this._ready();
    const all = await this._promisify(this._tx('scenes').getAll());
    return all.sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  // ── Utilidades ──────────────────────────────────────────
  async getStats() {
    await this._ready();
    const presentations = await this.getAllPresentations();
    const scenes        = await this.getAllScenes();
    let totalSlides = 0;
    for (const p of presentations) totalSlides += p.totalSlides || 0;
    return { presentations: presentations.length, totalSlides, scenes: scenes.length };
  }
}

window.SlideStorage = SlideStorage;