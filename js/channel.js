/**
 * channel.js — BroadcastChannel inter-window communication
 * EventControlSystem v1.0
 * ─────────────────────────────────────────────────────────
 * Todos los mensajes siguen la estructura:
 * { type, payload, from, timestamp }
 */

const CHANNEL_NAME = 'ecs-control-v1';

class EventChannel {
  constructor(windowId = 'unknown') {
    this.windowId = windowId;
    this.channel   = new BroadcastChannel(CHANNEL_NAME);
    this.listeners = new Map();   // type → [callback, ...]
    this._setupListener();
  }

  _setupListener() {
    this.channel.onmessage = ({ data: msg }) => {
      if (!msg || !msg.type) return;

      // Type-specific handlers
      (this.listeners.get(msg.type) || []).forEach(h => {
        try { h(msg.payload, msg); } catch (e) { console.error('[ECS Channel]', e); }
      });

      // Wildcard handlers
      (this.listeners.get('*') || []).forEach(h => {
        try { h(msg.payload, msg); } catch (e) { console.error('[ECS Channel]', e); }
      });
    };
  }

  /** Envía un mensaje a todas las demás ventanas */
  send(type, payload = {}) {
    const message = { type, payload, from: this.windowId, timestamp: Date.now() };
    this.channel.postMessage(message);
    return message;
  }

  /** Suscribirse a un tipo de mensaje. Devuelve función de baja. */
  on(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
    return () => this.off(type, callback);
  }

  off(type, callback) {
    if (!this.listeners.has(type)) return;
    this.listeners.set(type, this.listeners.get(type).filter(h => h !== callback));
  }

  /** Escuchar una sola vez */
  once(type, callback) {
    const unsub = this.on(type, (payload, msg) => { unsub(); callback(payload, msg); });
    return unsub;
  }

  destroy() { this.channel.close(); this.listeners.clear(); }
}

// ═══════════════════════════════════════════════════════════
//  Constantes de tipos de mensajes
// ═══════════════════════════════════════════════════════════
const MSG = Object.freeze({
  // Control de slides
  LATERAL_SLIDE     : 'LATERAL_SLIDE',      // { presentationId, slideIndex }
  CENTRAL_SLIDE     : 'CENTRAL_SLIDE',      // { presentationId, slideIndex }

  // Modo de pantalla ('slide' | 'black' | 'logo' | 'video')
  LATERAL_MODE      : 'LATERAL_MODE',       // { mode, presentationId?, seconds? }
  CENTRAL_MODE      : 'CENTRAL_MODE',

  // Preview (admin recibe thumbnails de las pantallas)
  PREVIEW_UPDATE    : 'PREVIEW_UPDATE',     // { screen, image, mode, slideIndex, totalSlides }
  PREVIEW_REQUEST   : 'PREVIEW_REQUEST',    // { screen? }   — sin screen = todas

  // Escenas
  SCENE_EXECUTE     : 'SCENE_EXECUTE',      // { lateral:{...}, central:{...} }

  // Sistema
  SCREEN_READY      : 'SCREEN_READY',       // { screen }
  SCREEN_HEARTBEAT  : 'SCREEN_HEARTBEAT',   // { screen, mode }
  AUTOPLAY_CONTROL  : 'AUTOPLAY_CONTROL',   // { screen, action:'start'|'stop', seconds? }
});

window.EventChannel = EventChannel;
window.MSG          = MSG;