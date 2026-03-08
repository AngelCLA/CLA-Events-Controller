# Event Control System v1.0
### Sistema de Control de Pantallas para Eventos en Vivo

Sistema 100% offline que corre en el navegador. Sin backend, sin Node.js, sin internet.

---

## 📁 Estructura del Proyecto

```
EventControlSystem/
├── admin.html           ← Panel de administración (laptop del operador)
├── lateral.html         ← Pantallas proyectores laterales
├── central.html         ← Pantalla LED central
├── js/
│   ├── channel.js       ← BroadcastChannel (comunicación entre ventanas)
│   ├── slideStorage.js  ← IndexedDB (almacenamiento local de slides)
│   └── presentationEngine.js ← Conversión PDF/PPTX/ZIP → imágenes
└── assets/
    └── logo.png         ← Logo institucional (reemplazar con el tuyo)
```

---

## 🚀 Cómo usar

### 1. Abrir las pantallas
En el navegador (Chrome recomendado), abre cada archivo:
- **admin.html** → en la ventana de la laptop del operador
- **lateral.html** → arrastra a la pantalla de los proyectores laterales (modo ventana o F para fullscreen)
- **central.html** → arrastra a la pantalla LED central

> ⚠️ Todas deben abrirse **desde el mismo navegador** (misma sesión) para que BroadcastChannel funcione.

### 2. Subir presentaciones
- En el panel admin, arrastra o haz clic en la zona de subida
- Formatos: **PDF**, **PPTX**, **ZIP** (con imágenes), imágenes individuales
- Para mejores resultados con PowerPoint: **exporta a PDF primero**

### 3. Controlar pantallas
- Selecciona la presentación en cada panel (Lateral / Central)
- Usa los botones de navegación ◄ ►
- Cambia el modo: Slide / Negro / Logo

### 4. Escenas rápidas
- Crea escenas con configuración específica para cada pantalla
- Ejecuta con un solo clic durante el evento

---

## ⌨️ Atajos de teclado (en admin.html)

| Tecla | Acción |
|-------|--------|
| `←` / `→` | Lateral: anterior / siguiente |
| `A` / `D` | Central: anterior / siguiente |
| `B` | Todas las pantallas → Negro |
| `L` | Todas las pantallas → Logo |
| `S` | Todas las pantallas → Slide activo |
| `F5` | Solicitar preview actualizado |

---

## 🛠️ Tecnologías

- **HTML + CSS + JavaScript puro** — sin frameworks
- **BroadcastChannel API** — comunicación entre ventanas
- **IndexedDB** — almacenamiento persistente de slides
- **pdf.js** (Mozilla) — renderizado de PDFs
- **JSZip** — extracción de PPTX y ZIP
- **Tailwind CSS** (CDN) — utilidades de estilo

---

## ✅ Reemplazar el logo

1. Coloca tu logo en `assets/logo.png` (PNG con fondo transparente recomendado)
2. El logo se mostrará cuando actives el modo **Logo** en cualquier pantalla

---

## ⚡ Notas de rendimiento

- Los slides se almacenan como imágenes JPEG en IndexedDB
- El cambio de slides es instantáneo (crossfade CSS 0.6s)
- Las pantallas envían preview cada 4-6 segundos al admin
- Funciona sin internet después de la primera carga