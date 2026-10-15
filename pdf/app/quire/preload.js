document.addEventListener('webviewerloaded', () => {
  window.PDFViewerApplicationOptions.setAll({
    defaultUrl: '', disablePreferences: true, enableScripting: false,
    isEvalSupported: false, enableXfa: false, enablePermissions: true,
    enableComment: true, enableSignatureEditor: true,
    enableMerge: true, enableSplitMerge: true,
    enableHighlightFloatingButton: true, enableAltTextModelDownload: false,
    enableGuessAltText: false, enableNewAltTextWhenAddingImage: false,
    enableNewBadge: false, disableHistory: true,
    defaultZoomValue: 'page-fit', externalLinkTarget: 2,
    maxCanvasPixels: 16777216
  });
}, {once: true});
