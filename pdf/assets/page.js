// Landing page helpers for the embedded Quire PDF tool. Same-origin only; no network use.
(() => {
  const frame = document.getElementById('quireFrame');
  const full = document.getElementById('fullscreen');
  if (!frame) return;
  if (full && document.fullscreenEnabled && frame.requestFullscreen) {
    full.hidden = false;
    full.addEventListener('click', () => frame.requestFullscreen().catch(() => {}));
  }
  // A PDF dropped anywhere on the page (outside the tool) is handed to the tool.
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  document.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    document.body.classList.remove('dragging');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    frame.contentWindow.postMessage({type: 'quire-open', file}, location.origin);
    frame.scrollIntoView({behavior: 'smooth', block: 'start'});
  });
})();
