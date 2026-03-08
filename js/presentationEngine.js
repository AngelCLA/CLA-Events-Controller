/**
 * presentationEngine.js — Conversión de archivos a slides
 * EventControlSystem v1.1 — PPTX mejorado
 * ─────────────────────────────────────────────────────────
 * Estrategia PPTX:
 *   1. Descomprime el ZIP
 *   2. Carga dimensiones, master, layouts, media (base64)
 *   3. Por cada slide: construye un div HTML con posicionamiento
 *      absoluto replicando el XML (fondos, imágenes, cuadros de texto)
 *   4. Inserta el div en contenedor offscreen
 *   5. html2canvas lo captura como imagen de alta calidad
 *   6. La imagen se guarda en IndexedDB
 */

class PresentationEngine {
  constructor(storage) {
    this.storage = storage;
  }

  _newId() {
    return `pres_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  async processFile(file, onProgress = () => {}) {
    const ext = file.name.split('.').pop().toLowerCase();
    const id  = this._newId();
    let slides = [];

    onProgress(0, 'Iniciando procesamiento…');

    switch (ext) {
      case 'pdf':
        slides = await this._processPDF(file, id, onProgress);
        break;
      case 'pptx': case 'ppt':
        slides = await this._processPPTX(file, id, onProgress);
        break;
      case 'zip':
        slides = await this._processZIP(file, id, onProgress);
        break;
      case 'jpg': case 'jpeg': case 'png':
      case 'gif': case 'webp': case 'bmp':
        slides = await this._processSingleImage(file, id, onProgress);
        break;
      default:
        throw new Error(`Formato no soportado: .${ext}\nUsa PDF, PPTX, ZIP o imágenes.`);
    }

    if (!slides.length) throw new Error('No se encontraron diapositivas en el archivo.');

    const presentation = {
      id,
      name        : file.name,
      type        : ext,
      totalSlides : slides.length,
      createdAt   : new Date().toISOString(),
    };

    onProgress(88, 'Guardando presentación…');
    await this.storage.savePresentation(presentation);

    onProgress(90, `Guardando ${slides.length} slides…`);
    for (let i = 0; i < slides.length; i++) {
      await this.storage.saveSlide(slides[i]);
      if (i % 3 === 0)
        onProgress(90 + Math.round((i / slides.length) * 8), `Guardando slide ${i + 1}/${slides.length}…`);
    }

    onProgress(100, '¡Completado!');
    return presentation;
  }

  // ══════════════════════════════════════════════════════
  //  PDF  →  pdf.js
  // ══════════════════════════════════════════════════════
  async _processPDF(file, presentationId, onProgress) {
    const pdfjsLib = window['pdfjs-dist/build/pdf'];
    if (!pdfjsLib) throw new Error('pdf.js no está disponible.');

    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    const arrayBuffer = await file.arrayBuffer();
    const pdf   = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const total = pdf.numPages;
    const slides = [];

    for (let i = 1; i <= total; i++) {
      onProgress(Math.round((i / total) * 82), `Renderizando página ${i}/${total}…`);
      const page     = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas   = document.createElement('canvas');
      canvas.width   = viewport.width;
      canvas.height  = viewport.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      slides.push({
        id: `${presentationId}_${i - 1}`, presentationId,
        slideIndex: i - 1,
        image: canvas.toDataURL('image/jpeg', 0.90),
        createdAt: new Date().toISOString(),
      });
    }
    return slides;
  }

  // ══════════════════════════════════════════════════════
  //  PPTX  →  JSZip + XML → HTML → html2canvas
  // ══════════════════════════════════════════════════════
  async _processPPTX(file, presentationId, onProgress) {
    if (!window.JSZip) throw new Error('JSZip no está disponible.');
    if (!window.html2canvas)
      throw new Error('html2canvas no está disponible. Recarga la página e intenta de nuevo.');

    onProgress(3, 'Descomprimiendo PPTX…');
    const ab  = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(ab);

    // ── Dimensiones del slide ──────────────────────────
    let emuW = 9144000, emuH = 5143500;
    try {
      const presXml = await zip.file('ppt/presentation.xml')?.async('text') || '';
      const m = presXml.match(/p:sldSz[^>]+cx="(\d+)"[^>]+cy="(\d+)"/);
      if (m) { emuW = parseInt(m[1]); emuH = parseInt(m[2]); }
    } catch {}

    const RENDER_W = 1280;
    const RENDER_H = Math.round(RENDER_W * emuH / emuW);
    const scaleX   = RENDER_W / emuW;
    const scaleY   = RENDER_H / emuH;

    // ── Cargar todos los media como data-url ───────────
    onProgress(7, 'Cargando imágenes del archivo…');
    const media = {};
    await Promise.all(
      Object.entries(zip.files)
        .filter(([p, e]) => p.startsWith('ppt/media/') && !e.dir)
        .map(async ([p, e]) => {
          const fname = p.split('/').pop();
          const ext   = fname.split('.').pop().toLowerCase();
          const MIMES = {
            jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png',
            gif:'image/gif',  webp:'image/webp', svg:'image/svg+xml',
            wmf:'image/wmf',  emf:'image/emf',
          };
          try {
            const b64 = await e.async('base64');
            media[fname] = `data:${MIMES[ext] || 'image/png'};base64,${b64}`;
          } catch {}
        })
    );

    // ── Fondo del master (slide 1) ─────────────────────
    let masterBg = null;
    let masterRels = {};
    try {
      const masterXml = await zip.file('ppt/slideMasters/slideMaster1.xml')?.async('text') || '';
      const mRelsXml  = await zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels')?.async('text') || '';
      masterRels = this._parseRels(mRelsXml, media);
      masterBg   = this._parseBg(masterXml, masterRels);
    } catch {}

    // ── Ordenar slides ─────────────────────────────────
    const entries = [];
    zip.forEach((path, e) => {
      const m = path.match(/^ppt\/slides\/slide(\d+)\.xml$/);
      if (m) entries.push({ path, e, num: parseInt(m[1]) });
    });
    entries.sort((a, b) => a.num - b.num);

    if (!entries.length) throw new Error('No se encontraron diapositivas en el PPTX.');
    onProgress(10, `Procesando ${entries.length} diapositivas…`);

    // ── Contenedor offscreen fijo ──────────────────────
    const host = document.createElement('div');
    Object.assign(host.style, {
      position  : 'fixed',
      top       : '0',
      left      : '-9999px',
      width     : `${RENDER_W}px`,
      height    : `${RENDER_H}px`,
      overflow  : 'hidden',
      zIndex    : '-1',
      pointerEvents: 'none',
      background: 'white',
    });
    document.body.appendChild(host);

    const slides = [];

    try {
      for (let i = 0; i < entries.length; i++) {
        const pct = 12 + Math.round((i / entries.length) * 72);
        onProgress(pct, `Renderizando slide ${i + 1} / ${entries.length}…`);

        try {
          const xml     = await entries[i].e.async('text');
          const relsXml = await zip.file(
            `ppt/slides/_rels/slide${entries[i].num}.xml.rels`
          )?.async('text') || '';
          const rels = this._parseRels(relsXml, media);

          // Fondo del layout
          let layoutBg = null;
          try {
            const lTarget = relsXml.match(/Type="[^"]*slideLayout[^"]*"[^>]+Target="([^"]+)"/)?.[1];
            if (lTarget) {
              const lPath  = lTarget.startsWith('../') ? `ppt/${lTarget.slice(3)}` : `ppt/slides/${lTarget}`;
              const lXml   = await zip.file(lPath)?.async('text') || '';
              const lRelsX = await zip.file(
                lPath.replace('/slideLayouts/', '/slideLayouts/_rels/') + '.rels'
              )?.async('text') || '';
              const lRels  = this._parseRels(lRelsX, media);
              layoutBg = this._parseBg(lXml, lRels);
            }
          } catch {}

          // Construir y renderizar
          const slideEl = this._buildSlideHTML(xml, rels, RENDER_W, RENDER_H, emuW, emuH, scaleX, scaleY, layoutBg, masterBg, masterRels);
          host.innerHTML = '';
          host.appendChild(slideEl);

          await this._waitImages(host, 5000);

          const canvas = await html2canvas(host, {
            width            : RENDER_W,
            height           : RENDER_H,
            scale            : 1,
            useCORS          : true,
            allowTaint       : true,
            backgroundColor  : '#ffffff',
            logging          : false,
            imageTimeout     : 6000,
          });

          slides.push({
            id: `${presentationId}_${i}`, presentationId,
            slideIndex: i,
            image: canvas.toDataURL('image/jpeg', 0.92),
            createdAt: new Date().toISOString(),
          });

        } catch (err) {
          console.warn(`Slide ${i + 1} error:`, err);
          slides.push({
            id: `${presentationId}_${i}`, presentationId,
            slideIndex: i,
            image: this._errorSlide(RENDER_W, RENDER_H, i + 1, err.message),
            createdAt: new Date().toISOString(),
          });
        }
      }
    } finally {
      document.body.removeChild(host);
    }

    return slides;
  }

  // ── Construir div HTML de un slide ─────────────────────
  _buildSlideHTML(xml, rels, W, H, emuW, emuH, scaleX, scaleY, layoutBg, masterBg, masterRels) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const div = document.createElement('div');
    Object.assign(div.style, {
      position   : 'relative',
      width      : `${W}px`,
      height     : `${H}px`,
      overflow   : 'hidden',
      fontFamily : 'Arial, Helvetica, sans-serif',
      userSelect : 'none',
    });

    // Fondo: prioridad slide > layout > master > blanco
    const bg = this._parseBg(xml, rels)
            || layoutBg
            || masterBg
            || { type:'solid', color:'#FFFFFF' };
    this._applyBg(div, bg);

    // Shapes
    const spTree = doc.querySelector('spTree');
    if (!spTree) return div;

    for (const node of Array.from(spTree.children)) {
      const el = this._buildNode(node, rels, scaleX, scaleY);
      if (el) div.appendChild(el);
    }
    return div;
  }

  _buildNode(node, rels, scaleX, scaleY) {
    switch (node.localName) {
      case 'sp':           return this._buildSp(node, rels, scaleX, scaleY);
      case 'pic':          return this._buildPic(node, rels, scaleX, scaleY);
      case 'graphicFrame': return this._buildGraphicFrame(node, rels, scaleX, scaleY);
      case 'grpSp':        return this._buildGrp(node, rels, scaleX, scaleY);
      default: return null;
    }
  }

  // ── Shape con texto ───────────────────────────────────
  _buildSp(node, rels, scaleX, scaleY) {
    const xfrm = node.querySelector('spPr xfrm');
    if (!xfrm) return null;
    const off = xfrm.querySelector('off');
    const ext = xfrm.querySelector('ext');
    if (!off || !ext) return null;

    const x   = parseInt(off.getAttribute('x')  || 0) * scaleX;
    const y   = parseInt(off.getAttribute('y')  || 0) * scaleY;
    const w   = parseInt(ext.getAttribute('cx') || 0) * scaleX;
    const h   = parseInt(ext.getAttribute('cy') || 0) * scaleY;
    const rot = parseInt(xfrm.getAttribute('rot') || 0) / 60000;

    const el = document.createElement('div');
    Object.assign(el.style, {
      position : 'absolute',
      left     : `${x}px`,
      top      : `${y}px`,
      width    : `${w}px`,
      height   : `${h}px`,
      overflow : 'hidden',
      boxSizing: 'border-box',
    });
    if (rot) el.style.transform = `rotate(${rot}deg)`;
    if (xfrm.getAttribute('flipH') === '1') el.style.transform = (el.style.transform||'') + ' scaleX(-1)';
    if (xfrm.getAttribute('flipV') === '1') el.style.transform = (el.style.transform||'') + ' scaleY(-1)';

    // Relleno de la forma
    const spPr = node.querySelector('spPr');
    if (spPr) {
      const fill = this._extractFill(spPr, rels);
      if (fill && fill !== 'transparent') el.style.background = fill;

      // Borde
      const ln = spPr.querySelector('ln');
      if (ln && !ln.querySelector('noFill')) {
        const lnSrgb = ln.querySelector('solidFill srgbClr');
        if (lnSrgb) {
          const lw = Math.max(1, Math.round(parseInt(ln.getAttribute('w') || 9525) * scaleX / 9525));
          el.style.border = `${lw}px solid #${lnSrgb.getAttribute('val')}`;
        }
      }
    }

    // Texto
    const txBody = node.querySelector('txBody');
    if (txBody) {
      const bodyPr = txBody.querySelector('bodyPr');
      const anchor = bodyPr?.getAttribute('anchor') || 't';
      const lIns   = parseInt(bodyPr?.getAttribute('lIns') || 91440) * scaleX;
      const rIns   = parseInt(bodyPr?.getAttribute('rIns') || 91440) * scaleX;
      const tIns   = parseInt(bodyPr?.getAttribute('tIns') || 45720) * scaleY;
      const bIns   = parseInt(bodyPr?.getAttribute('bIns') || 45720) * scaleY;

      // Overflow de texto
      const autoFit   = txBody.querySelector('normAutofit, spAutoFit');
      const noAutofit = txBody.querySelector('noAutofit');

      const inner = document.createElement('div');
      Object.assign(inner.style, {
        position : 'absolute',
        left     : `${lIns}px`,
        top      : `${tIns}px`,
        right    : `${rIns}px`,
        bottom   : `${bIns}px`,
        overflow : 'hidden',
        wordBreak: 'break-word',
        overflowWrap: 'break-word',
      });

      // Alineación vertical
      if (anchor === 'ctr' || anchor === 'center') {
        Object.assign(inner.style, { display:'flex', flexDirection:'column', justifyContent:'center' });
      } else if (anchor === 'b') {
        Object.assign(inner.style, { display:'flex', flexDirection:'column', justifyContent:'flex-end' });
      }

      for (const p of Array.from(txBody.querySelectorAll('p'))) {
        inner.appendChild(this._buildPara(p, scaleX, scaleY));
      }
      el.appendChild(inner);
    }

    return el;
  }

  // ── Párrafo ───────────────────────────────────────────
  _buildPara(p, scaleX, scaleY) {
    const pEl = document.createElement('p');
    Object.assign(pEl.style, { margin:'0', padding:'0', lineHeight:'1.25', minHeight:'1em' });

    const pPr = p.querySelector('pPr');
    if (pPr) {
      const algn = pPr.getAttribute('algn');
      const alignMap = { ctr:'center', r:'right', just:'justify', dist:'justify', l:'left' };
      pEl.style.textAlign = alignMap[algn] || 'left';

      const indent = parseInt(pPr.getAttribute('indent') || 0) * scaleX;
      if (indent > 0) pEl.style.textIndent = `${indent}px`;

      const spcBef = pPr.querySelector('spcBef spcPts');
      if (spcBef) pEl.style.paddingTop = `${parseInt(spcBef.getAttribute('val') || 0) / 100 * scaleY * 0.5}px`;

      const lnSpc = pPr.querySelector('lnSpc spcPct');
      if (lnSpc) pEl.style.lineHeight = `${parseInt(lnSpc.getAttribute('val') || 100000) / 100000}`;
    }

    const runs = Array.from(p.querySelectorAll('r'));
    if (!runs.length) { pEl.innerHTML = '&nbsp;'; return pEl; }

    for (const r of runs) {
      const rPr = r.querySelector('rPr');
      const t   = r.querySelector('t');
      if (!t) continue;
      const text = t.textContent;
      if (text === undefined) continue;

      const span = document.createElement('span');
      span.textContent = text || '\u200B';   // zero-width space para spans vacíos

      if (rPr) {
        // Tamaño
        const sz = rPr.getAttribute('sz');
        if (sz) {
          const ptSize = parseInt(sz) / 100;
          span.style.fontSize = `${ptSize * scaleY * 1.33}px`;
        }

        // Estilo
        if (rPr.getAttribute('b')  === '1') span.style.fontWeight = 'bold';
        if (rPr.getAttribute('i')  === '1') span.style.fontStyle  = 'italic';
        const u = rPr.getAttribute('u');
        if (u && u !== 'none') span.style.textDecoration = 'underline';
        if (rPr.getAttribute('strike') && rPr.getAttribute('strike') !== 'noStrike')
          span.style.textDecoration = (span.style.textDecoration ? span.style.textDecoration + ' ' : '') + 'line-through';

        // Color
        const sf = rPr.querySelector('solidFill');
        if (sf) {
          const srgb = sf.querySelector('srgbClr');
          if (srgb) {
            let c = '#' + srgb.getAttribute('val');
            const lm = sf.querySelector('lumMod');
            const lo = sf.querySelector('lumOff');
            if (lm || lo) c = this._applyLum(c, lm?.getAttribute('val'), lo?.getAttribute('val'));
            span.style.color = c;
          } else {
            const sch = sf.querySelector('schemeClr');
            if (sch) {
              const sc = this._schemeToColor(sch.getAttribute('val'));
              if (sc) span.style.color = sc;
            }
          }
        }

        // Fuente
        const latin = rPr.querySelector('latin');
        if (latin) {
          const face = latin.getAttribute('typeface');
          if (face && !face.startsWith('+')) {
            span.style.fontFamily = `"${face}", Arial, sans-serif`;
          }
        }

        // Sombra simple
        if (rPr.querySelector('effectLst')) {
          span.style.textShadow = '1px 1px 3px rgba(0,0,0,0.45)';
        }
      }

      pEl.appendChild(span);
    }

    return pEl;
  }

  // ── Imagen (pic) ──────────────────────────────────────
  _buildPic(node, rels, scaleX, scaleY) {
    const xfrm = node.querySelector('xfrm') || node.querySelector('spPr xfrm');
    if (!xfrm) return null;
    const off = xfrm.querySelector('off');
    const ext = xfrm.querySelector('ext');
    if (!off || !ext) return null;

    const x   = parseInt(off.getAttribute('x')  || 0) * scaleX;
    const y   = parseInt(off.getAttribute('y')  || 0) * scaleY;
    const w   = parseInt(ext.getAttribute('cx') || 0) * scaleX;
    const h   = parseInt(ext.getAttribute('cy') || 0) * scaleY;
    const rot = parseInt(xfrm.getAttribute('rot') || 0) / 60000;

    const el = document.createElement('div');
    Object.assign(el.style, {
      position : 'absolute',
      left     : `${x}px`,
      top      : `${y}px`,
      width    : `${w}px`,
      height   : `${h}px`,
      overflow : 'hidden',
    });
    if (rot) el.style.transform = `rotate(${rot}deg)`;

    // Buscar rid de la imagen con múltiples variantes de namespace
    const blip = node.querySelector('blip');
    const rid  = blip?.getAttribute('r:embed')
              || blip?.getAttribute('embed')
              || blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');

    if (rid && rels[rid]) {
      const src = rels[rid];
      // SVG, WMF, EMF: renderizar como fondo en vez de <img> para evitar errores de CORS
      if (src.includes('image/svg') || src.includes('image/wmf') || src.includes('image/emf')) {
        Object.assign(el.style, {
          backgroundImage   : `url(${src})`,
          backgroundSize    : 'contain',
          backgroundRepeat  : 'no-repeat',
          backgroundPosition: 'center',
        });
      } else {
        const img = document.createElement('img');
        img.src         = src;
        img.crossOrigin = 'anonymous';
        Object.assign(img.style, {
          width     : '100%',
          height    : '100%',
          objectFit : node.querySelector('stretch') ? 'fill' : 'contain',
          display   : 'block',
        });
        el.appendChild(img);
      }
    }

    return el;
  }

  // ── Grupo ─────────────────────────────────────────────
  _buildGrp(node, rels, scaleX, scaleY) {
    const grpXfrm = node.querySelector('grpSpPr xfrm');
    const wrap = document.createElement('div');
    wrap.style.position = 'absolute';

    if (grpXfrm) {
      const off = grpXfrm.querySelector('off');
      const ext = grpXfrm.querySelector('ext');
      if (off && ext) {
        wrap.style.left   = `${parseInt(off.getAttribute('x') || 0) * scaleX}px`;
        wrap.style.top    = `${parseInt(off.getAttribute('y') || 0) * scaleY}px`;
        wrap.style.width  = `${parseInt(ext.getAttribute('cx') || 0) * scaleX}px`;
        wrap.style.height = `${parseInt(ext.getAttribute('cy') || 0) * scaleY}px`;
      }
    }

    for (const child of Array.from(node.children)) {
      const el = this._buildNode(child, rels, scaleX, scaleY);
      if (el) wrap.appendChild(el);
    }
    return wrap;
  }

  // ── Tabla / graphicFrame ──────────────────────────────
  _buildGraphicFrame(node, rels, scaleX, scaleY) {
    const xfrm = node.querySelector('xfrm');
    if (!xfrm) return null;
    const off = xfrm.querySelector('off');
    const ext = xfrm.querySelector('ext');
    if (!off || !ext) return null;

    const x = parseInt(off.getAttribute('x')  || 0) * scaleX;
    const y = parseInt(off.getAttribute('y')  || 0) * scaleY;
    const w = parseInt(ext.getAttribute('cx') || 0) * scaleX;
    const h = parseInt(ext.getAttribute('cy') || 0) * scaleY;

    const wrap = document.createElement('div');
    Object.assign(wrap.style, {
      position : 'absolute',
      left     : `${x}px`,
      top      : `${y}px`,
      width    : `${w}px`,
      height   : `${h}px`,
      overflow : 'hidden',
    });

    const tbl = node.querySelector('tbl');
    if (!tbl) return wrap;

    const table = document.createElement('table');
    Object.assign(table.style, {
      width          : '100%',
      borderCollapse : 'collapse',
      tableLayout    : 'fixed',
      fontSize       : `${Math.round(11 * scaleY * 1.33)}px`,
    });

    for (const tr of Array.from(tbl.querySelectorAll('tr'))) {
      const trEl = document.createElement('tr');
      for (const tc of Array.from(tr.querySelectorAll('tc'))) {
        const vMerge = tc.getAttribute('vMerge') === '1';
        const hMerge = tc.getAttribute('gridSpan');
        if (vMerge) continue;   // celdas fusionadas verticalmente (simplificación)

        const tdEl = document.createElement('td');
        Object.assign(tdEl.style, {
          border       : '1px solid rgba(0,0,0,0.2)',
          padding      : '4px 6px',
          verticalAlign: 'middle',
          overflow     : 'hidden',
          wordBreak    : 'break-word',
        });
        if (hMerge && parseInt(hMerge) > 1) tdEl.colSpan = parseInt(hMerge);

        const tcPr   = tc.querySelector('tcPr');
        const fill   = this._extractFill(tcPr || tc, rels);
        if (fill) tdEl.style.background = fill;

        const anchor = tcPr?.getAttribute('anchor');
        if (anchor === 'ctr') tdEl.style.verticalAlign = 'middle';
        if (anchor === 'b')   tdEl.style.verticalAlign = 'bottom';

        for (const p of Array.from(tc.querySelectorAll('p'))) {
          tdEl.appendChild(this._buildPara(p, scaleX, scaleY));
        }
        trEl.appendChild(tdEl);
      }
      table.appendChild(trEl);
    }

    wrap.appendChild(table);
    return wrap;
  }

  // ── Fondo del slide ───────────────────────────────────
  _parseBg(xml, rels) {
    if (!xml) return null;
    const doc = typeof xml === 'string'
      ? new DOMParser().parseFromString(xml, 'text/xml')
      : xml;

    const bgEl = doc.querySelector('bg');
    if (!bgEl) return null;

    const solid = bgEl.querySelector('solidFill');
    if (solid) {
      const srgb = solid.querySelector('srgbClr');
      if (srgb) {
        let c = '#' + srgb.getAttribute('val');
        const lm = solid.querySelector('lumMod');
        const lo = solid.querySelector('lumOff');
        if (lm || lo) c = this._applyLum(c, lm?.getAttribute('val'), lo?.getAttribute('val'));
        return { type:'solid', color:c };
      }
      const sch = solid.querySelector('schemeClr');
      if (sch) return { type:'solid', color: this._schemeToColor(sch.getAttribute('val')) || '#FFFFFF' };
    }

    const grad = bgEl.querySelector('gradFill');
    if (grad) {
      const colors = Array.from(grad.querySelectorAll('gs')).map(s => {
        const sr = s.querySelector('srgbClr');
        if (sr) return '#' + sr.getAttribute('val');
        const sc = s.querySelector('schemeClr');
        if (sc) return this._schemeToColor(sc.getAttribute('val')) || '#444';
        return '#444';
      });
      const angle = grad.querySelector('lin')?.getAttribute('ang');
      const deg   = angle ? (parseInt(angle) / 60000) - 90 : 135;
      return { type:'gradient', colors, deg };
    }

    const blip = bgEl.querySelector('blipFill blip');
    if (blip) {
      const rid = blip.getAttribute('r:embed')
               || blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
      if (rid && rels && rels[rid]) return { type:'image', src: rels[rid] };
    }

    return null;
  }

  _applyBg(el, bg) {
    if (!bg) return;
    if (bg.type === 'solid') {
      el.style.background = bg.color || '#FFFFFF';
    } else if (bg.type === 'gradient') {
      const deg = bg.deg ?? 135;
      el.style.background = `linear-gradient(${deg}deg, ${(bg.colors||[]).join(', ')})`;
    } else if (bg.type === 'image' && bg.src) {
      Object.assign(el.style, {
        backgroundImage   : `url(${bg.src})`,
        backgroundSize    : 'cover',
        backgroundPosition: 'center',
        backgroundRepeat  : 'no-repeat',
      });
    } else {
      el.style.background = '#FFFFFF';
    }
  }

  // ── Extraer fill (sólido/degradado/none) ──────────────
  _extractFill(el, rels) {
    if (!el) return null;
    const solid = el.querySelector('solidFill');
    if (solid) {
      const srgb = solid.querySelector('srgbClr');
      if (srgb) {
        let c = '#' + srgb.getAttribute('val');
        const lm = solid.querySelector('lumMod');
        const lo = solid.querySelector('lumOff');
        if (lm || lo) c = this._applyLum(c, lm?.getAttribute('val'), lo?.getAttribute('val'));
        return c;
      }
      const sch = solid.querySelector('schemeClr');
      if (sch) return this._schemeToColor(sch.getAttribute('val'));
    }
    const grad = el.querySelector('gradFill');
    if (grad) {
      const colors = Array.from(grad.querySelectorAll('gs')).map(s => {
        const sr = s.querySelector('srgbClr');
        return sr ? '#' + sr.getAttribute('val') : '#888';
      });
      const angle = grad.querySelector('lin')?.getAttribute('ang');
      const deg   = angle ? (parseInt(angle) / 60000) - 90 : 135;
      if (colors.length >= 2) return `linear-gradient(${deg}deg, ${colors.join(', ')})`;
    }
    if (el.querySelector('noFill')) return 'transparent';
    return null;
  }

  // ── Relaciones ─────────────────────────────────────────
  _parseRels(relsXml, media) {
    const rels = {};
    if (!relsXml) return rels;
    for (const m of relsXml.matchAll(/Id="([^"]+)"[^/]*Target="([^"]+)"/g)) {
      const fname = m[2].split('/').pop();
      if (media[fname]) rels[m[1]] = media[fname];
    }
    return rels;
  }

  // ── Colores de esquema → hex ───────────────────────────
  _schemeToColor(name) {
    return {
      lt1:'#FFFFFF',  dk1:'#000000',
      lt2:'#EEECE1',  dk2:'#1F497D',
      accent1:'#4472C4', accent2:'#ED7D31', accent3:'#A9D18E',
      accent4:'#FFC000', accent5:'#5A96D7', accent6:'#70AD47',
      hlink:'#0563C1', folHlink:'#954F72',
      bg1:'#FFFFFF',  bg2:'#E7E6E6',
      tx1:'#000000',  tx2:'#404040',
    }[name] || null;
  }

  _applyLum(hex, lumModStr, lumOffStr) {
    try {
      const lm = lumModStr ? parseInt(lumModStr) / 100000 : 1;
      const lo = lumOffStr ? parseInt(lumOffStr) / 100000 : 0;
      const h  = hex.replace('#', '');
      let r = parseInt(h.slice(0,2),16);
      let g = parseInt(h.slice(2,4),16);
      let b = parseInt(h.slice(4,6),16);
      r = Math.min(255, Math.max(0, Math.round(r * lm + lo * 255)));
      g = Math.min(255, Math.max(0, Math.round(g * lm + lo * 255)));
      b = Math.min(255, Math.max(0, Math.round(b * lm + lo * 255)));
      return `rgb(${r},${g},${b})`;
    } catch { return hex; }
  }

  // ── Esperar que carguen las imágenes ──────────────────
  _waitImages(container, timeout = 5000) {
    const imgs = Array.from(container.querySelectorAll('img'));
    if (!imgs.length) return Promise.resolve();
    return Promise.race([
      Promise.all(imgs.map(img => {
        if (img.complete && img.naturalWidth) return Promise.resolve();
        return new Promise(res => { img.onload = res; img.onerror = res; });
      })),
      new Promise(res => setTimeout(res, timeout)),
    ]);
  }

  // ══════════════════════════════════════════════════════
  //  ZIP  →  imágenes
  // ══════════════════════════════════════════════════════
  async _processZIP(file, presentationId, onProgress) {
    if (!window.JSZip) throw new Error('JSZip no está disponible.');
    const ab  = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(ab);
    const IMG = new Set(['jpg','jpeg','png','gif','webp','bmp']);
    const files = [];
    zip.forEach((path, entry) => {
      if (!entry.dir && IMG.has(path.split('.').pop().toLowerCase())) files.push({ path, entry });
    });
    files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric:true }));
    const MIMES = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png',
                    gif:'image/gif',  webp:'image/webp', bmp:'image/bmp' };
    const slides = [];
    for (let i = 0; i < files.length; i++) {
      onProgress(Math.round((i / files.length) * 82), `Extrayendo imagen ${i + 1}/${files.length}…`);
      const ext = files[i].path.split('.').pop().toLowerCase();
      const b64 = await files[i].entry.async('base64');
      slides.push({ id:`${presentationId}_${i}`, presentationId, slideIndex:i,
        image:`data:${MIMES[ext]||'image/png'};base64,${b64}`, createdAt:new Date().toISOString() });
    }
    return slides;
  }

  // ══════════════════════════════════════════════════════
  //  Imagen individual
  // ══════════════════════════════════════════════════════
  _processSingleImage(file, presentationId, onProgress) {
    return new Promise((resolve, reject) => {
      const reader  = new FileReader();
      reader.onload = e => resolve([{
        id:`${presentationId}_0`, presentationId, slideIndex:0,
        image:e.target.result, createdAt:new Date().toISOString()
      }]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // ── Slide de error visual ─────────────────────────────
  _errorSlide(w, h, num, msg) {
    const c   = document.createElement('canvas');
    c.width   = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0,0,w,h);
    ctx.fillStyle = '#ef4444';
    ctx.font = `bold ${Math.round(h*0.05)}px Arial`;
    ctx.textAlign = 'center';
    ctx.fillText(`Slide ${num} — Error`, w/2, h/2 - 20);
    ctx.fillStyle = '#64748b';
    ctx.font = `${Math.round(h*0.025)}px Arial`;
    ctx.fillText(String(msg||'').slice(0,90), w/2, h/2 + 20);
    return c.toDataURL('image/jpeg', 0.85);
  }
}

window.PresentationEngine = PresentationEngine;