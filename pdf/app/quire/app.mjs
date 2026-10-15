// Quire PDF for the web. Adapted from the Quire PDF Chrome extension's app.mjs.
// Differences from the extension: no chrome.* APIs, no remote-URL opening, no
// IndexedDB library or recovery copies (documents live only in this tab's memory),
// and Save can use the File System Access API where the browser offers it.
import {trackDocumentChanges} from './change-tracker.mjs';

const root = new URL('./', import.meta.url);
const $ = id => document.getElementById(id);
let app, current = null, revision = 0, exportedRevision = 0;
let busy = false, ready = false, tracker, pendingOpen = false;
function setBusy(value){busy=value;$('outerContainer').inert=value;for(const id of ['openButton','welcomeOpen','demoButton']){if($(id))$(id).disabled=value;}$('saveButton').disabled=value||!app?.pdfDocument;}
const MAX_BYTES = 100 * 1024 * 1024;

const icon = (name) => ({
  folder:'<path d="M3 7h7l2 2h9v11H3zM3 7V4h7l2 3"/>',
  open:'<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  moon:'<path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 4 3v2m-1 3h.01"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>'
}[name] || '');
const svg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon(name)}</svg>`;
function mount() {
  document.body.insertAdjacentHTML('afterbegin', `
    <header id="quireHeader">
      <button id="libraryButton" class="brand" title="Close document and return to the start"><img src="${root}icon32.png" alt=""><span>Quire <b>PDF</b></span></button>
      <div id="documentHeading"><span id="documentName">Your PDF workspace</span><span id="saveStatus" role="status">Files stay in this browser</span></div>
      <div class="headerActions"><button id="openButton" class="qButton">${svg('folder')}<span>Open</span></button><button id="themeButton" class="qIcon" title="Switch color theme" aria-label="Switch color theme">${svg('moon')}</button><button id="helpButton" class="qIcon" title="Help and shortcuts" aria-label="Help and shortcuts">${svg('help')}</button><button id="saveButton" class="qButton primary" disabled>${svg('download')}<span>Save a copy</span></button></div>
    </header>
    <main id="libraryView">
      <section class="welcome"><div class="welcomeCopy"><p class="welcomeNote">Nothing is uploaded. The PDF stays in this tab.</p><p class="welcomeTitle">Open a PDF<br>to get started.</p><p class="welcomeDescription">Read, highlight, comment, fill forms, sign, and reorder<br class="desktopBreak"> or combine pages. Then save an edited copy.</p><div class="welcomeActions"><button id="welcomeOpen" class="qButton primary large">${svg('open')}Open a PDF</button><button id="demoButton" class="qButton quiet">Try a sample ${svg('arrow')}</button></div><p class="dropHint">Or drop a file here · Up to 100 MB</p></div><div class="paperScene" aria-hidden="true"><div class="paperBack"></div><div class="samplePaper"><span class="sampleIssue">Field notes / 001</span><h2>Good ideas<br>leave a mark.</h2><div class="paperRule"></div><p>Find the thought worth keeping.</p><p><mark>Give it a little room to grow.</mark></p><div class="fakeLines"><i></i><i></i><i></i></div><span class="marginNote">Start here ↗</span><div class="paperFooter">QUIRE PDF <span>01</span></div></div><div class="sampleTag">${svg('check')}Your files. Your space.</div></div></section>
    </main>
    <footer id="workspaceFooter" hidden><span id="workspaceHint">Select text to highlight it, or choose a tool above.</span><span id="pageStatus"></span></footer>
    <input type="file" id="quireFilePicker" accept=".pdf,application/pdf" hidden>
    <div id="quireToast" role="status" hidden></div>
    <dialog id="helpDialog" class="qDialog"><form method="dialog"><button class="dialogClose" aria-label="Close help">×</button><h2>A better place for PDFs.</h2><p>Use the toolbar to highlight, comment, add text, draw, place an image, or add a typed or handwritten signature. Existing form fields are ready to fill.</p><h3>Make room for the right pages</h3><p>Open <strong>Pages</strong> to reorder, remove or export selected pages. Use its add-file button to bring another PDF into your document. Forms with matching field names cannot be combined. Page copy, cut and paste are unavailable; drag thumbnails to reorder.</p><h3>Keep your work</h3><p>Your PDF is processed in this browser tab and is never uploaded. Quire does not keep a copy, so use <strong>Save a copy</strong> to keep your edits. It does not overwrite the original unless you pick that file yourself in a save dialog.</p><dl><div><dt>Find</dt><dd>⌘ / Ctrl F</dd></div><div><dt>Open</dt><dd>⌘ / Ctrl O</dd></div><div><dt>Save a copy</dt><dd>⌘ / Ctrl S</dd></div><div><dt>Undo / redo</dt><dd>⌘ / Ctrl Z / Shift Z</dd></div></dl><p class="finePrint">Text tools add text; they do not replace original page text. Signatures are visual marks, not digital certificates. Quire does not provide secure redaction or OCR. XFA forms are not supported. PDF scripts are disabled.</p><button class="qButton primary">Got it</button></form></dialog>
  `);
  setTheme(localStorage.getItem('quire.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  document.body.classList.add('quireLibrary');
  for (const id of ['openButton','welcomeOpen']) $(id).onclick = () => $('quireFilePicker').click();
  $('quireFilePicker').onchange = async e => {const file=e.target.files[0]; e.target.value=''; if(file) await openFile(file);};
  $('saveButton').onclick = () => exportCopy();
  $('libraryButton').onclick = () => closeDocument();
  $('helpButton').onclick = () => $('helpDialog').showModal();
  $('themeButton').onclick = () => setTheme(document.documentElement.dataset.quireTheme==='dark'?'light':'dark');
  $('demoButton').onclick = async () => {
    try {const response=await fetch(new URL('sample.pdf',root));if(!response.ok) throw new Error('The sample could not be opened.'); await openFile(new File([await response.blob()],'Welcome to Quire.pdf',{type:'application/pdf'}));}catch(e){showError(e);}
  };
  document.addEventListener('dragover', e => {if(document.body.classList.contains('quireLibrary') && e.dataTransfer.types.includes('Files')){e.preventDefault();$('libraryView').classList.add('dragging');}});
  document.addEventListener('dragleave', e => {if(!e.relatedTarget)$('libraryView').classList.remove('dragging');});
  document.addEventListener('drop', e => {if(document.body.classList.contains('quireLibrary')){e.preventDefault();$('libraryView').classList.remove('dragging');if(e.dataTransfer.files[0])openFile(e.dataTransfer.files[0]);}});
  document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='o'){e.preventDefault();e.stopImmediatePropagation();$('quireFilePicker').click();}},true);
  // The landing page that embeds this viewer forwards files dropped on it.
  window.addEventListener('message', e => {
    if (e.origin !== location.origin || e.source !== window.parent || e.data?.type !== 'quire-open') return;
    if (e.data.file instanceof File) openFile(e.data.file);
  });
}
function setTheme(theme){document.documentElement.dataset.quireTheme=theme;document.documentElement.style.colorScheme=theme;localStorage.setItem('quire.theme',theme);}
function status(text,kind=''){ $('saveStatus').textContent=text;$('saveStatus').dataset.state=kind; }
let toastTimer;
function toast(text,error=false){const el=$('quireToast');el.textContent=text;el.dataset.error=error;el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.hidden=true,error?10000:4000);}
function showError(error){console.error('Quire:',error);toast(error?.message||'Something went wrong. Your original file has not been changed.',true);}
function safeName(name){return (name||'Untitled.pdf').replace(/[\x00-\x1f/\\]/g,'_').slice(0,180);}
const hasUnsavedEdits = () => Boolean(current && revision > exportedRevision);
function confirmDiscard(){return !hasUnsavedEdits() || confirm('This PDF has edits you have not saved. Discard them?');}

async function closeDocument(){
 if(busy||!ready)return;
 if(current&&!confirmDiscard())return;
 setBusy(true);
 try{tracker?.dispose();tracker=null;current=null;if(app.pdfDocument)await app.close();}
 finally{document.body.classList.add('quireLibrary');$('workspaceFooter').hidden=true;$('documentName').textContent='Your PDF workspace';status('Files stay in this browser');setBusy(false);$('saveButton').disabled=true;}
}
async function checkedBytes(file){
 if(file.size>MAX_BYTES)throw new Error('This file is larger than 100 MB. Try a smaller PDF.');
 const bytes=await file.arrayBuffer();
 if(!new TextDecoder().decode(bytes.slice(0,1024)).includes('%PDF-'))throw new Error('That does not look like a PDF. Choose a .pdf file.');
 return bytes;
}
async function openFile(file){
 if(busy||!ready)return;
 if(current&&!confirmDiscard())return;
 setBusy(true);
 try{
  const bytes=await checkedBytes(file);
  await loadRecord({name:safeName(file.name),bytes,page:1});
 }catch(e){showError(e);}finally{setBusy(false);}
}
async function loadRecord(record,{edited=false}={}){
 pendingOpen=true;if(app.pdfDocument)$('viewsManagerStatusUndoCloseButton')?.click();tracker?.dispose();tracker=null;current=record;
 revision=edited?1:0;exportedRevision=0;
 $('quireToast').hidden=true;clearTimeout(toastTimer);$('documentName').textContent=record.name;status('Opening…');$('saveButton').disabled=true;
 document.body.classList.remove('quireLibrary');$('workspaceFooter').hidden=false;
 try{await app.open({data:new Uint8Array(record.bytes.slice(0)),filename:record.name});await app.pdfViewer.firstPagePromise;
  app.pdfViewer.currentPageNumber=Math.min(record.page||1,app.pdfDocument.numPages);
  $('pageStatus').textContent=`Page ${app.pdfViewer.currentPageNumber} of ${app.pdfDocument.numPages}`;
  tracker=trackDocumentChanges({pdfDocument:app.pdfDocument,editorUIManager:app.pdfViewer._layerProperties.annotationEditorUIManager,eventTarget:document,isCurrent:d=>app.pdfDocument===d&&current===record,onChange:markChanged});
  status(edited?'Unsaved edits · save a copy to keep them':'Ready · nothing uploaded',edited?'pending':'');
 }catch(e){current=null;await app.close();document.body.classList.add('quireLibrary');$('documentName').textContent='Your PDF workspace';$('workspaceFooter').hidden=true;status('Could not open this PDF','error');throw e;}
 finally{pendingOpen=false;}
}
function markChanged(){if(!current||pendingOpen)return;revision++;status('Unsaved edits · save a copy to keep them','pending');}
// PDF.js extractPages() writes new annotations (placed by their on-screen page) but drops
// edited form-field values. Collect those values first, then set them on the extracted copy,
// matching each widget by field name and position, and save that copy.
async function formEdits(doc){
 const storage=doc.annotationStorage,out=[];
 if(storage.size===0)return out;
 const objs=await doc.getFieldObjects();
 for(const [name,list] of (objs instanceof Map?objs:Object.entries(objs||{}))){
  for(const w of list||[]){
   if(!w.id||!storage.has(w.id))continue;
   const raw=storage.getRawValue(w.id);
   if(!raw||typeof raw.serialize==='function')continue;
   out.push({name,rect:JSON.stringify(w.rect||null),value:{...raw}});
  }
 }
 return out;
}
async function extractWithEdits(pageInfos,copyLevels){
 const doc=app.pdfDocument;
 const edits=await formEdits(doc);
 const bytes=await doc.extractPages(pageInfos,copyLevels);
 if(!bytes||!edits.length)return bytes;
 const o=window.PDFViewerApplicationOptions;
 const task=globalThis.pdfjsLib.getDocument({data:bytes.slice(),isEvalSupported:false,useSystemFonts:false,enableXfa:false,
  cMapUrl:o.get('cMapUrl'),standardFontDataUrl:o.get('standardFontDataUrl'),wasmUrl:o.get('wasmUrl'),iccUrl:o.get('iccUrl')});
 try{
  const copy=await task.promise,objs=await copy.getFieldObjects();
  const fields=objs instanceof Map?objs:new Map(Object.entries(objs||{}));
  for(const edit of edits){
   const list=(fields.get(edit.name)||[]).filter(w=>w.id);
   const widget=list.find(w=>JSON.stringify(w.rect||null)===edit.rect)||(list.length===1?list[0]:null);
   if(widget)copy.annotationStorage.setValue(widget.id,edit.value);
  }
  return copy.annotationStorage.size?await copy.saveDocument():bytes;
 }finally{await task.destroy();}
}
async function bytesForCurrent(){
 if(!app.pdfDocument)throw new Error('Open a PDF first.');
 if(app.pdfThumbnailViewer?.hasStructuralChanges()){
  const {pageInfos,copyLevels}=app.pdfThumbnailViewer.getStructuralChanges();
  const data=await extractWithEdits(pageInfos,copyLevels);if(!data)throw new Error('The edited pages could not be saved. Your original is unchanged.');return data;
 }
 return app.pdfDocument.annotationStorage.size>0 ? app.pdfDocument.saveDocument() : app.pdfDocument.getData();
}
const baseName=name=>(name||'Document.pdf').replace(/\.pdf$/i,'').replace(/( \((edited|selected pages)\))+$/,'');
function editedName(name){return safeName(baseName(name)+' (edited).pdf');}
// Ask for a destination first, while the click's user activation is still valid.
// Returns a file handle, null to fall back to a normal download, or false if cancelled.
async function chooseDestination(name){
 if(typeof window.showSaveFilePicker!=='function')return null;
 try{return await window.showSaveFilePicker({suggestedName:name,types:[{description:'PDF document',accept:{'application/pdf':['.pdf']}}]});}
 catch(e){if(e?.name==='AbortError')return false;return null;}
}
async function writeBytes(target,data,name){
 if(target){const stream=await target.createWritable();await stream.write(data);await stream.close();return 'saved';}
 const url=URL.createObjectURL(new Blob([data],{type:'application/pdf'}));const a=document.createElement('a');a.href=url;a.download=safeName(name);document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);return 'download';
}
async function exportCopy(){
 if(busy||!app.pdfDocument)return;
 const name=editedName(current?.name||app._docFilename);
 const target=await chooseDestination(name);if(target===false)return;
 setBusy(true);status('Preparing your PDF…');
 try{tracker?.capture();const captured=revision;const data=await bytesForCurrent();const how=await writeBytes(target,data,name);exportedRevision=captured;
  if(revision===captured)status(how==='saved'?'Saved':'Download started');
  toast(how==='saved'?'Your edited PDF was saved.':'Your edited PDF download has started.');}
 catch(e){status('Could not save. Your original is unchanged.','error');showError(e);}finally{setBusy(false);}
}
async function rebuildPages(data){
 tracker?.capture();
 const bytes=await extractWithEdits(data.pageInfos,data.copyLevels);
 if(!bytes)throw new Error('The edited document could not be created.');
 if(bytes.byteLength>MAX_BYTES)throw new Error('The combined document exceeds 100 MB. Use fewer pages.');
 const record={...current,bytes:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),page:app.page};
 await loadRecord(record,{edited:true});
}
async function mergeFiles({files,insertAfter=app.page-1}){
 if(busy||!ready||!app.pdfDocument)return;
 setBusy(true);
 try{
  if(files.reduce((size,file)=>size+file.size,current.bytes.byteLength)>MAX_BYTES)throw new Error('The combined PDFs must fit within 100 MB.');
  const data=app.pdfThumbnailViewer.hasStructuralChanges()?app.pdfThumbnailViewer.getStructuralChanges():{pageInfos:[{document:null}],copyLevels:null};
  const fieldNames=new Set(fieldNamesOf(await app.pdfDocument.getFieldObjects()));
  for(const file of files){
   const bytes=new Uint8Array(await checkedBytes(file));
   // Preserve distinct form identities instead of silently merging duplicate names.
   const inspection=globalThis.pdfjsLib.getDocument({data:bytes.slice(),isEvalSupported:false,useSystemFonts:false});
   try{
    const incoming=await inspection.promise;
    for(const name of fieldNamesOf(await incoming.getFieldObjects())){
     if(fieldNames.has(name))throw new Error('These PDFs contain matching form field names. Combine non-overlapping forms, or flatten a copy of the form before adding it.');
     fieldNames.add(name);
    }
   }finally{await inspection.destroy();}
   data.pageInfos.push({document:bytes,insertAfter});
  }
  await rebuildPages(data);toast('Pages added. Save a copy to keep your combined PDF.');
 }catch(e){showError(e);}finally{$('viewsManagerAddFilePicker').value='';setBusy(false);}
}
function fieldNamesOf(fields){return fields instanceof Map?[...fields.keys()]:Object.keys(fields||{});}

mount();
document.addEventListener('webviewerloaded', async()=>{
 app=window.PDFViewerApplication;
 app.downloadOrSave=exportCopy;
 app.save=exportCopy;
 app.setTitle=()=>{document.title=current?`${current.name} · Quire PDF`:'Quire PDF';};
 app._hasChanges=()=>hasUnsavedEdits();
 app.onSaveAndLoad=async({data})=>{if(busy)return;setBusy(true);try{await rebuildPages(data);}catch(e){showError(e);}finally{setBusy(false);}};
 app.onSavePages=async({data:{pageInfos,copyLevels}})=>{
  if(busy||!app.pdfDocument)return;
  const name=safeName(baseName(current?.name)+' (selected pages).pdf');
  const target=await chooseDestination(name);if(target===false)return;
  setBusy(true);
  try{tracker?.capture();const data=await extractWithEdits(pageInfos,copyLevels);if(!data)throw new Error('Selected pages could not be exported.');const how=await writeBytes(target,data,name);toast(how==='saved'?'Selected pages saved.':'Selected pages download started.');}
  catch(e){showError(e);}finally{setBusy(false);}
 };
 await app.initializedPromise;
 ready=true;
 document.addEventListener('quirepageclipboardblocked',()=>toast('Page copy, cut, and paste are unavailable to protect form fields. Drag pages to reorder them.',true));
 document.addEventListener('quiremergefiles',e=>mergeFiles(e.detail));
 document.addEventListener('quireopenfile',e=>{if(e.detail)openFile(e.detail);});
 app.eventBus.on('pagesedited',markChanged);
 app.eventBus.on('pagechanging',({pageNumber})=>{if(current&&!pendingOpen)current.page=pageNumber;$('pageStatus').textContent=`Page ${pageNumber} of ${app.pdfViewer.pagesCount}`;});
 app.eventBus.on('documenterror',({message})=>{showError(new Error(message));});
 for(const [id,label] of [['viewsManagerToggleButton','Pages'],['editorHighlightButton','Highlight'],['editorFreeTextButton','Text'],['editorInkButton','Draw'],['editorStampButton','Image'],['editorCommentButton','Note'],['editorSignatureButton','Sign']]){
  const el=$(id);if(el){el.dataset.quireLabel=label;el.title=label;}
 }
 document.documentElement.dataset.quireReady='true';
});
window.addEventListener('beforeunload',e=>{if(hasUnsavedEdits()){e.preventDefault();e.returnValue='';}});
