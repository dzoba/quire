/**
 * Observe document edits without relying on PDF.js's clean-to-dirty callback.
 * PDF.js resets that callback's flag after saveDocument/extractPages completes,
 * so it cannot detect edits made while a previous snapshot is being saved.
 *
 * Install once the document's annotation editor UI manager exists. Dispose when
 * that PDFDocumentProxy is replaced (including native merge/save-and-load).
 * Keep the existing onSetModified callback for PDF.js's own title state.
 *
 * Example:
 *   tracker = trackDocumentChanges({
 *     pdfDocument: app.pdfDocument,
 *     editorUIManager: app.pdfViewer._layerProperties.annotationEditorUIManager,
 *     eventTarget: document,
 *     isCurrent: doc => current?.id === id && app.pdfDocument === doc,
 *     onChange: () => markChanged(),
 *   });
 *
 * Before snapshotting, call tracker.capture() synchronously, then call
 * saveDocument()/extractPages() without an intervening await. capture() commits
 * live FreeText/drawing edits BEFORE returning the version. After writing the
 * snapshot to IndexedDB, use unchangedSince(token) to decide whether "saved"
 * is accurate; if false, keep dirty state and enqueue another snapshot.
 * A metadata-only write must never advance the saved content revision.
 *
 * This module does not save anything, acquire a document lock, commit unfinished
 * modal dialogs, or handle structural page edits. Keep the pagesedited handler
 * and serialize open/close/merge with persistence in the app lifecycle.
 */
export function trackDocumentChanges({
  pdfDocument,
  editorUIManager = null,
  eventTarget = null,
  isCurrent = () => true,
  onChange,
}) {
  if (!pdfDocument?.annotationStorage || typeof onChange !== 'function') {
    throw new TypeError('A PDF document and onChange callback are required.');
  }
  const storage = pdfDocument.annotationStorage;
  const restorers = [];
  let version = 0;
  let disposed = false;

  function active() {
    return !disposed && isCurrent(pdfDocument);
  }
  function changed(reason) {
    if (!active()) return;
    version += 1;
    onChange({pdfDocument, version, reason});
  }
  function wrap(target, name, before, shouldNotify = () => true) {
    if (!target || typeof target[name] !== 'function') return;
    const original = target[name];
    const ownDescriptor = Object.getOwnPropertyDescriptor(target, name);
    function wrapped(...args) {
      const state = before?.(this, args);
      const result = Reflect.apply(original, this, args);
      if (shouldNotify(state, result, args)) changed(name);
      return result;
    }
    // Fail explicitly if a future PDF.js build freezes these APIs. Silent
    // fallback to onSetModified would reintroduce the data-loss race.
    Object.defineProperty(target, name, {value: wrapped, writable: true, configurable: true});
    restorers.push(() => {
      if (target[name] !== wrapped) return;
      if (ownDescriptor) Object.defineProperty(target, name, ownDescriptor);
      else delete target[name];
    });
  }
  try {
    wrap(storage, 'setValue', (target, [key, value]) => {
      if (!target.has(key)) return true;
      const previous = target.getRawValue(key);
      // Editor instances may already be mutated by reference. A repeated
      // setValue for one is conservatively an edit even if references match.
      if (typeof value?.serialize === 'function') return true;
      return Object.entries(value).some(([field, next]) => previous?.[field] !== next);
    }, state => state);
    wrap(storage, 'remove', (target, [key]) => target.has(key), state => state);
    wrap(storage, 'updateEditor', undefined, (_state, result) => result === true);

    // Existing editor objects are mutated in place and aren't re-added to
    // annotationStorage. Editor commands cover text, geometry, styles and undo.
    for (const name of ['addCommands', 'undo', 'redo']) wrap(editorUIManager, name);

    if (eventTarget?.addEventListener) {
      const handleInput = event => {
        if (event.target?.closest?.('.annotationLayer, .annotationEditorLayer')) {
          changed('live-input');
        }
      };
      const handlePointerUp = event => {
        if (event.target?.closest?.('.annotationEditorLayer')) changed('editor-pointerup');
      };
      for (const type of ['input', 'change']) {
        eventTarget.addEventListener(type, handleInput, true);
        restorers.push(() => eventTarget.removeEventListener(type, handleInput, true));
      }
      eventTarget.addEventListener('pointerup', handlePointerUp, true);
      restorers.push(() => eventTarget.removeEventListener('pointerup', handlePointerUp, true));
    }
  } catch (error) {
    for (const restore of restorers.reverse()) restore();
    throw new Error('Unable to install PDF change tracking.', {cause: error});
  }

  return {
    get version() { return version; },
    capture() {
      if (!active()) throw new Error('This PDF is no longer the active document.');
      editorUIManager?.endCurrentEditing();
      return {pdfDocument, version};
    },
    unchangedSince(token) {
      return active() && token?.pdfDocument === pdfDocument && token.version === version;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const restore of restorers.reverse()) restore();
    },
  };
}
