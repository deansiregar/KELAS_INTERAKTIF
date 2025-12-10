/*********************************************************
 * KONFIGURASI
 *********************************************************/
const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbxzx-R6DOUlfrF86yyjf7UbJArEPtT_qBO401Kpx_GXDI5sXgo7jhLBPdTJ9R4OshkRAA/exec";
const SPREADSHEET_URL = "https://docs.google.com/spreadsheets/d/1X2H4gyoWar9BAIit_dV-NeQYEYmKNVITZDleEo-uPn8/edit?usp=sharing";
const MAX_DATAURL_CHARS = 45000;
const PING_INTERVAL = 15 * 60 * 1000; // 15 menit
const KEEP_ALIVE_INTERVAL = 10 * 60 * 1000; // 10 menit

function startKeepAlive() {
  setInterval(async () => {
    try {
      await fetch(`${WEB_APP_URL}?action=keepAlive&t=${Date.now()}`);
    } catch (e) {
      console.log('Keep alive ping failed:', e.message);
    }
  }, KEEP_ALIVE_INTERVAL);
}
/*********************************************************
 * STATE
 *********************************************************/
let state = {
  teacher: { name: "", isAdmin: false, adminHash: "", roomId: null },
  student: { name: "", roomId: "", password: "", passwordHash: "" },
  questions: [],
  currentIndex: 0,
  timer: 0, 
  timerId: null,
  studentAnswers: {}
};

/*********************************************************
 * UTILITIES
 *********************************************************/
const $  = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

function show(id){
  ["#pageHome","#pageTeacher","#pageStudent"].forEach(s=>$(s).classList.add("hidden"));
  $(id).classList.remove("hidden");
  
  if (id === "#pageHome") {
    $("#refreshAppBtn").classList.remove("hidden");
  } else {
    $("#refreshAppBtn").classList.add("hidden");
  }
}

function startTimer(){
  stopTimer(); 
  state.timer=0;
  state.timerId=setInterval(()=>{
    state.timer++;
    $("#timer").textContent =
      `Waktu: ${String(Math.floor(state.timer/60)).padStart(2,'0')}:${String(state.timer%60).padStart(2,'0')}`;
  },1000);
}

function stopTimer(){ 
  if(state.timerId){ 
    clearInterval(state.timerId); 
    state.timerId=null; 
  } 
}

async function sha256Hex(text){
  const enc=new TextEncoder();
  const buf=await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

function toast(msg){ 
  const toast = document.createElement('div');
  toast.textContent = msg;
  toast.className = 'toast';
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

async function postPayload(obj){
  const fd = new FormData();
  fd.append("payload", JSON.stringify(obj));
  let res;
  try { 
    res = await fetch(WEB_APP_URL, { 
      method: "POST", 
      body: fd 
    }); 
  } catch { 
    return { success:false, message:"Tidak bisa terhubung ke Web App." }; 
  }
  const text = await res.text();
  try { return JSON.parse(text); } 
  catch { return { success:false, message:`Respon bukan JSON: ${text.slice(0,200)}` }; }
}

// PING FUNCTION UNTUK MENJAGA APPS SCRIPT TETAP AKTIF
async function pingWebApp() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(`${WEB_APP_URL}?action=health`, {
      signal: controller.signal,
      cache: 'no-store'
    });
    
    clearTimeout(timeoutId);
    
    if (response.ok) {
      console.log('Ping successful:', new Date().toLocaleTimeString());
      return true;
    }
    return false;
  } catch (error) {
    console.warn('Ping failed:', error.message);
    return false;
  }
}

function startPingService() {
  // Ping pertama setelah 1 menit
  setTimeout(() => pingWebApp(), 60000);
  
  // Kemudian setiap 15 menit
  setInterval(() => {
    pingWebApp();
  }, PING_INTERVAL);
}

async function analyzeReasonAI({ questionText, options, correctIndex, selectedIndex, reason, expectedReason }){
  const fd = new FormData();
  fd.append("payload", JSON.stringify({
    action: "analyzeReasonGemini",
    questionText, 
    options, 
    correctIndex, 
    selectedIndex, 
    reason,
    expectedReason
  }));
  
  let res;
  try { 
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    
    res = await fetch(WEB_APP_URL, {
      method:"POST", 
      body: fd,
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
  } catch (err) { 
    return { success:false, message:"Gagal konek AI: " + err.message }; 
  }
  const text = await res.text();
  try { return JSON.parse(text); } 
  catch { return { success:false, message:"Respon AI tidak valid" }; }
}

function setLoading(btn, loading){
  if(!btn) return; 
  btn.disabled = !!loading;
  
  if(loading){ 
    btn.dataset._orig = btn.dataset._orig || btn.innerHTML; 
    btn.innerHTML = '⏳ Memproses...'; 
    btn.style.opacity = '0.7';
    btn.classList.add('loading');
  } else { 
    btn.innerHTML = btn.dataset._orig || btn.innerHTML; 
    btn.style.opacity = '1';
    btn.classList.remove('loading');
  }
}

function fileToDataUrl(file){
  return new Promise((resolve, reject)=>{
    const r = new FileReader(); 
    r.onload=()=>resolve(r.result); 
    r.onerror=reject; 
    r.readAsDataURL(file);
  });
}

async function drawToCanvas(dataUrl, maxW, maxH){
  const img = await new Promise((resolve, reject)=>{
    const i = new Image(); 
    i.onload=()=>resolve(i); 
    i.onerror=reject; 
    i.src=dataUrl;
  });
  let { width:w, height:h } = img;
  const ratio = Math.min(maxW / w, maxH / h, 1);
  const cw = Math.max(1, Math.round(w * ratio));
  const ch = Math.max(1, Math.round(h * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = cw; 
  canvas.height = ch;
  canvas.getContext("2d").drawImage(img, 0, 0, cw, ch);
  return canvas;
}

async function compressToLimit(file, {maxWList=[1280,960,720,512,384], qualityList=[0.8,0.7,0.6,0.5,0.4,0.35,0.3]}={}){
  const base = await fileToDataUrl(file);
  for(const maxW of maxWList){
    const canvas = await drawToCanvas(base, maxW, maxW);
    const preferJPEG = !file.type.includes("png");
    for(const q of qualityList){
      const dataUrl = canvas.toDataURL(preferJPEG ? "image/jpeg" : "image/png", preferJPEG ? q : 0.92);
      if(dataUrl.length <= MAX_DATAURL_CHARS) return { ok:true, dataUrl };
    }
  }
  const canvas = await drawToCanvas(base, 320, 320);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.28);
  if(dataUrl.length <= MAX_DATAURL_CHARS) return { ok:true, dataUrl };
  return { ok:false, dataUrl };
}

function escapeHtml(s){ 
  return s.replace(/[&<>\"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); 
}

/*********************************************************
 * EQUATION EDITOR FUNCTIONS - GURU
 *********************************************************/

let mathPreviewTimeout = null;
let studentMathPreviewTimeout = null;

function initEquationEditor() {
  // Toolbar event listeners untuk guru
  document.querySelectorAll('.btn-tool[data-latex]').forEach(button => {
    button.addEventListener('click', (e) => {
      e.preventDefault();
      const latex = button.getAttribute('data-latex');
      insertEquation(latex, "#qsExplanation", "#mathPreview");
    });
  });

  // Real-time preview dengan debounce untuk guru
  $("#qsExplanation").addEventListener('input', function() {
    clearTimeout(mathPreviewTimeout);
    mathPreviewTimeout = setTimeout(() => updateMathPreview("#qsExplanation", "#mathPreview"), 500);
  });

  // Juga update saat focus hilang
  $("#qsExplanation").addEventListener('blur', function() {
    updateMathPreview("#qsExplanation", "#mathPreview");
  });

  // Initial preview
  setTimeout(() => updateMathPreview("#qsExplanation", "#mathPreview"), 1000);
}

function initStudentEquationEditor() {
  // Toolbar event listeners untuk siswa
  document.querySelectorAll('.btn-tool-student[data-latex]').forEach(button => {
    button.addEventListener('click', (e) => {
      e.preventDefault();
      const latex = button.getAttribute('data-latex');
      insertEquation(latex, "#reason", "#studentMathPreview");
    });
  });

  // Real-time preview dengan debounce untuk siswa
  $("#reason").addEventListener('input', function() {
    clearTimeout(studentMathPreviewTimeout);
    studentMathPreviewTimeout = setTimeout(() => updateMathPreview("#reason", "#studentMathPreview"), 500);
  });

  // Juga update saat focus hilang
  $("#reason").addEventListener('blur', function() {
    updateMathPreview("#reason", "#studentMathPreview");
  });

  // Initial preview untuk siswa
  setTimeout(() => updateMathPreview("#reason", "#studentMathPreview"), 1000);
}

function insertEquation(latexCode, textareaId, previewId) {
  const textarea = $(textareaId);
  const startPos = textarea.selectionStart;
  const endPos = textarea.selectionEnd;
  const text = textarea.value;
  
  const selectedText = text.substring(startPos, endPos);
  let finalLatex = latexCode;
  
  if (selectedText && latexCode.includes('{}')) {
    finalLatex = latexCode.replace('{}', `{${selectedText}}`);
  }
  
  // PERBAIKAN: Hapus replace double backslash
  const equationToInsert = `$$${finalLatex}$$`;
  
  const newText = text.substring(0, startPos) + 
                 equationToInsert + 
                 text.substring(endPos);
  
  textarea.value = newText;
  
  const newCursorPos = startPos + equationToInsert.length;
  textarea.setSelectionRange(newCursorPos, newCursorPos);
  textarea.focus();
  
  updateMathPreview(textareaId, previewId);
}

function updateMathPreview(textareaId, previewId) {
  const preview = $(previewId);
  const content = $(textareaId).value.trim();
  
  if (!content) {
    preview.innerHTML = '<div style="text-align: center; padding: 20px; color: #9aa4b2;"><em>Ketik di area editor untuk melihat preview...</em></div>';
    return;
  }
  
  // Process content untuk math rendering - PERBAIKAN CRITICAL
  let processedContent = content;
  
  // Convert double backslash back to single backslash untuk MathJax
  processedContent = processedContent.replace(/\\\\/g, '\\');
  
  // Convert line breaks to paragraphs
  const paragraphs = processedContent.split('\n\n');
  processedContent = paragraphs.map(paragraph => {
    if (paragraph.trim() === '') return '';
    return `<p>${paragraph}</p>`;
  }).join('');
  
  // Convert single line breaks to <br>
  processedContent = processedContent.replace(/\n/g, '<br>');
  
  // Convert $$...$$ to math containers - FIXED
  processedContent = processedContent.replace(/\$\$(.*?)\$\$/g, 
    (match, equation) => {
      // Clean the equation - remove extra backslashes
      const cleanEquation = equation.replace(/\\\\/g, '\\');
      return `<span class="math-container">$$${cleanEquation}$$</span>`;
    }
  );
  
  preview.innerHTML = processedContent;
  
  // Render MathJax dengan error handling
  if (window.MathJax) {
    try {
      MathJax.typesetPromise([preview]).then(() => {
        console.log('MathJax rendered successfully');
      }).catch(err => {
        console.log('MathJax rendering issue:', err);
        // Fallback: show raw LaTeX code for debugging
        preview.innerHTML += `<div style="margin-top: 20px; padding: 10px; background: rgba(239,68,68,.1); border-radius: 8px;">
          <strong>Debug Info:</strong><br>
          Content: ${content}<br>
          Error: ${err.message}
        </div>`;
      });
    } catch (err) {
      console.error('MathJax error:', err);
    }
  }
}

// Fungsi untuk membersihkan equation yang tidak valid
function cleanupInvalidEquations() {
  const preview = $("#mathPreview");
  const invalidEquations = preview.querySelectorAll('.math-container');
  
  invalidEquations.forEach(container => {
    const equation = container.textContent;
    // Jika equation mengandung karakter yang tidak valid, tampilkan sebagai teks biasa
    if (equation.includes('\\') && !isValidLatex(equation)) {
      container.innerHTML = `<code>${equation}</code>`;
    }
  });
}

// Validasi LaTeX sederhana
function isValidLatex(latex) {
  // Cek jika LaTeX mengandung command yang umum
  const validCommands = ['\\frac', '\\sqrt', '\\pi', '\\alpha', '\\beta', '\\theta', '\\Delta', '\\times', '\\cdot', '\\pm', '\\leq', '\\geq'];
  return validCommands.some(cmd => latex.includes(cmd));
}

/*********************************************************
 * LOCKDOWN MODE FUNCTIONS
 *********************************************************/

let violationCount = 0;
let lockdownEnabled = false;

function enableLockdownMode() {
  if (lockdownEnabled) return;
  
  lockdownEnabled = true;
  violationCount = 0;
  
  // Request fullscreen
  requestFullscreen();
  
  // Add event listeners
  document.addEventListener('fullscreenchange', handleFullscreenChange);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  document.addEventListener('keydown', handleLockdownKeydown);
  window.addEventListener('blur', handleWindowBlur);
  window.addEventListener('beforeunload', handleBeforeUnload);
  
  // Show lockdown warning
  $("#lockdownWarning").classList.remove("hidden");
  updateViolationDisplay();
  
  toast("🔒 Lockdown mode diaktifkan! Jangan keluar dari halaman ini.");
}

function disableLockdownMode() {
  lockdownEnabled = false;
  
  // Remove event listeners
  document.removeEventListener('fullscreenchange', handleFullscreenChange);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  document.removeEventListener('keydown', handleLockdownKeydown);
  window.removeEventListener('blur', handleWindowBlur);
  window.removeEventListener('beforeunload', handleBeforeUnload);
  
  // Hide lockdown warning
  $("#lockdownWarning").classList.add("hidden");
  
  // Exit fullscreen
  exitFullscreen();
}

function requestFullscreen() {
  const elem = document.documentElement;
  if (elem.requestFullscreen) {
    elem.requestFullscreen().catch(err => {
      console.log('Fullscreen error:', err);
    });
  }
}

function exitFullscreen() {
  if (document.exitFullscreen) {
    document.exitFullscreen();
  }
}

function handleFullscreenChange() {
  if (!document.fullscreenElement && lockdownEnabled) {
    violationCount++;
    updateViolationDisplay();
    showFullscreenWarning();
    
    setTimeout(requestFullscreen, 3000);
  }
}

function handleVisibilityChange() {
  if (document.hidden && lockdownEnabled) {
    violationCount++;
    updateViolationDisplay();
    toast("⚠️ Jangan buka tab/window lain selama ujian!");
  }
}

function handleWindowBlur() {
  if (lockdownEnabled) {
    violationCount++;
    updateViolationDisplay();
  }
}

function handleBeforeUnload(e) {
  if (lockdownEnabled) {
    e.preventDefault();
    e.returnValue = 'Anda sedang dalam ujian. Yakin ingin keluar?';
    return e.returnValue;
  }
}

function handleLockdownKeydown(e) {
  if (e.key === 'F12' || 
      (e.ctrlKey && e.shiftKey && e.key === 'I') || 
      (e.ctrlKey && e.shiftKey && e.key === 'J') ||
      (e.ctrlKey && e.key === 'u')) {
    e.preventDefault();
    violationCount++;
    updateViolationDisplay();
    toast("⚠️ Akses developer tools diblokir selama ujian!");
  }
}

function updateViolationDisplay() {
  const violationElement = $("#violationCount");
  if (violationElement) {
    violationElement.textContent = `Pelanggaran: ${violationCount}`;
    
    if (violationCount >= 3) {
      violationElement.style.color = '#ef4444';
      violationElement.style.fontWeight = 'bold';
    } else if (violationCount >= 1) {
      violationElement.style.color = '#f59e0b';
    }
  }
}

function showFullscreenWarning() {
  const overlay = document.createElement('div');
  overlay.className = 'fullscreen-overlay';
  overlay.innerHTML = `
    <h2>⛔ KEMBALI KE FULLSCREEN</h2>
    <p>Anda harus dalam mode fullscreen selama ujian.</p>
    <p>Kembali ke fullscreen dalam 3 detik...</p>
    <p style="margin-top: 20px; color: #d1d5db;">Pelanggaran: ${violationCount}</p>
  `;
  
  document.body.appendChild(overlay);
  
  setTimeout(() => {
    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
  }, 3000);
}

/*********************************************************
 * TOMBOL REFRESH APLIKASI DI HEADER
 *********************************************************/
function setupRefreshButton() {
  const refreshBtn = $("#refreshAppBtn");
  
  refreshBtn.onclick = () => {
    if (confirm('Refresh aplikasi? Semua progress yang belum disubmit akan hilang.')) {
      if ('caches' in window) {
        caches.keys().then(names => {
          names.forEach(name => caches.delete(name));
        });
      }
      localStorage.clear();
      sessionStorage.clear();
      
      toast('🔄 Aplikasi di-refresh...');
      setTimeout(() => {
        window.location.reload(true);
      }, 1000);
    }
  };
}

/*********************************************************
 * NAV
 *********************************************************/
$("#navHome").onclick = ()=>show("#pageHome");
$("#navTeacher").onclick = ()=>show("#pageTeacher");
$("#navStudent").onclick = ()=>show("#pageStudent");
$("#goTeacher").onclick = ()=>show("#pageTeacher");
$("#goStudent").onclick = ()=>show("#pageStudent");

/*********************************************************
 * LOGIN ADMIN
 *********************************************************/
$("#btnLoginAdmin").onclick = async ()=>{
  const name = $("#teacherName").value.trim();
  const adminPass = $("#adminPassword").value.trim();
  if(!name || !adminPass) return toast("Isi nama guru & admin password");
  
  setLoading($("#btnLoginAdmin"), true);
  try {
    const adminHash = await sha256Hex(adminPass);
    state.teacher = { name, isAdmin:true, adminHash, roomId:null };
    $("#adminInfo").classList.remove("hidden");
    $("#btnCreateRoom").disabled = false;
    $("#btnAddQuestion").disabled = false;
    if(SPREADSHEET_URL){
      const a=$("#sheetLink"); 
      a.href=SPREADSHEET_URL; 
      $("#sheetLinkWrap").classList.remove("hidden");
    }
    toast("Login admin berhasil!");
  } catch (err) {
    toast("Error: " + err.message);
  } finally {
    setLoading($("#btnLoginAdmin"), false);
  }
};

/*********************************************************
 * UPLOADER UI
 *********************************************************/
document.addEventListener("DOMContentLoaded", ()=>{
  // Uploader untuk gambar soal
  const pickBtn   = $("#btnPickImage");
  const clearBtn  = $("#btnClearImage");
  const fileInput = $("#qsImageFile");
  const fileName  = $("#fileName");
  const thumbWrap = $("#thumbWrap");
  const thumb     = $("#thumb");

  // Uploader untuk gambar penjelasan
  const pickExplanationBtn = $("#btnPickExplanationImage");
  const clearExplanationBtn = $("#btnClearExplanationImage");
  const explanationFileInput = $("#qsExplanationImageFile");
  const explanationFileName = $("#explanationFileName");
  const explanationThumbWrap = $("#explanationThumbWrap");
  const explanationThumb = $("#explanationThumb");

  function clearImageSelection(){
    if(fileInput) fileInput.value="";
    fileName.textContent="Belum ada file";
    thumbWrap.classList.add("hidden");
    thumb.removeAttribute("src");
  }

  function clearExplanationImageSelection(){
    if(explanationFileInput) explanationFileInput.value="";
    explanationFileName.textContent="Belum ada file";
    explanationThumbWrap.classList.add("hidden");
    explanationThumb.removeAttribute("src");
  }
  
  // Handler untuk gambar soal
  if(pickBtn && fileInput){
    pickBtn.onclick = ()=> fileInput.click();
    fileInput.onchange = ()=>{
      const f = fileInput.files && fileInput.files[0];
      if(!f){ clearImageSelection(); return; }
      fileName.textContent = `${f.name} (${Math.round(f.size/1024)} KB)`;
      const reader = new FileReader();
      reader.onload = e=>{ 
        thumb.src=e.target.result; 
        thumbWrap.classList.remove("hidden"); 
      };
      reader.readAsDataURL(f);
    };
  }
  
  if(clearBtn) clearBtn.onclick = clearImageSelection;

  // Handler untuk gambar penjelasan
  if(pickExplanationBtn && explanationFileInput){
    pickExplanationBtn.onclick = ()=> explanationFileInput.click();
    explanationFileInput.onchange = ()=>{
      const f = explanationFileInput.files && explanationFileInput.files[0];
      if(!f){ clearExplanationImageSelection(); return; }
      explanationFileName.textContent = `${f.name} (${Math.round(f.size/1024)} KB)`;
      const reader = new FileReader();
      reader.onload = e=>{ 
        explanationThumb.src=e.target.result; 
        explanationThumbWrap.classList.remove("hidden"); 
      };
      reader.readAsDataURL(f);
    };
  }
  
  if(clearExplanationBtn) clearExplanationBtn.onclick = clearExplanationImageSelection;
  
  // Initialize equation editor untuk guru
  initEquationEditor();
  
  // Initialize equation editor untuk siswa
  initStudentEquationEditor();
  
  // Setup tombol refresh
  setupRefreshButton();
  
  // Start ping service untuk menjaga Apps Script tetap aktif
  startPingService();

  startKeepAlive();
});

/*********************************************************
 * GURU — BUAT RUANGAN
 *********************************************************/
$("#btnCreateRoom").onclick = async ()=>{
  if(!state.teacher.isAdmin) return toast("Login admin dulu");
  const roomName = $("#roomName").value.trim();
  const roomPassword = $("#roomPassword").value.trim();
  if(!roomName || !roomPassword){ 
    return toast("Isi Nama Ruangan & Password Ruangan!"); 
  }

  setLoading($("#btnCreateRoom"), true);
  try{
    const passwordHash = await sha256Hex(roomPassword);
    const json = await postPayload({
      action:"createRoom", 
      roomName, 
      passwordHash,
      createdBy: state.teacher.name, 
      adminHash: state.teacher.adminHash
    });
    
    if(json.success && json.roomId){
      state.teacher.roomId = json.roomId;
      $("#qsRoomId").value = json.roomId;
      $("#qsRoomPassword").value = roomPassword;
      toast(`Ruangan berhasil dibuat! ID: ${json.roomId} • Nama: ${roomName}`);
    } else {
      toast(json.message || "Gagal membuat ruangan");
    }
  } catch(err) {
    toast("Error koneksi: " + err.message);
  } finally { 
    setLoading($("#btnCreateRoom"), false); 
  }
};

/*********************************************************
 * GURU — TAMBAH SOAL
 *********************************************************/
$("#btnAddQuestion").onclick = async ()=>{
  if(!state.teacher.isAdmin) return toast("Login admin dulu");
  
  const roomId = $("#qsRoomId").value.trim();
  const roomPass = $("#qsRoomPassword").value.trim();
  const qText = $("#qsText").value.trim();
  const opts = ["#optA","#optB","#optC","#optD","#optE"]
    .map(sel=>$(sel).value.trim()).filter(v=>v!=="");
  const answerIndex = parseInt($("#qsAnswer").value,10);
  const fileInput = $("#qsImageFile");
  const imgFile = fileInput && fileInput.files ? fileInput.files[0] : null;
  
  const explanationFileInput = $("#qsExplanationImageFile");
  const explanationImgFile = explanationFileInput && explanationFileInput.files ? explanationFileInput.files[0] : null;

  if(!roomId || !roomPass || !qText || opts.length<2)
    return toast("Lengkapi data soal (minimal 2 opsi)!");
  if(answerIndex<0 || answerIndex>=opts.length)
    return toast("Kunci jawaban harus sesuai jumlah opsi!");

  let imageDataUrl = "";
  let explanationImageDataUrl = "";

  // Kompres gambar soal
  if(imgFile){
    setLoading($("#btnAddQuestion"), true);
    const { ok, dataUrl } = await compressToLimit(imgFile);
    setLoading($("#btnAddQuestion"), false);
    if(!ok){ 
      toast("Gambar terlalu besar, soal disimpan TANPA gambar."); 
    } else {
      imageDataUrl = dataUrl;
    }
  }

  // Kompres gambar penjelasan
  if(explanationImgFile){
    setLoading($("#btnAddQuestion"), true);
    const { ok, dataUrl } = await compressToLimit(explanationImgFile);
    setLoading($("#btnAddQuestion"), false);
    if(!ok){ 
      toast("Gambar penjelasan terlalu besar, disimpan TANPA gambar penjelasan."); 
    } else {
      explanationImageDataUrl = dataUrl;
    }
  }

  setLoading($("#btnAddQuestion"), true);
  try{
    const passwordHash = await sha256Hex(roomPass);
    const qExplanation = $("#qsExplanation").value.trim();

    let payload = {
      action:"addQuestion", 
      roomId, 
      passwordHash,
      questionText:qText, 
      options:opts, 
      correctIndex:answerIndex,
      explanation: qExplanation,
      imageDataUrl, 
      explanationImageDataUrl,
      adminHash: state.teacher.adminHash
    };
    
    let json = await postPayload(payload);
    
    // Fallback jika gambar soal terlalu besar
    if(!json.success && imageDataUrl){ 
      payload.imageDataUrl = "";
      json = await postPayload(payload);
      if(json.success) toast("Soal ditambahkan tanpa gambar (terlalu besar).");
    }
    
    // Fallback jika gambar penjelasan terlalu besar
    if(!json.success && explanationImageDataUrl){ 
      payload.explanationImageDataUrl = "";
      json = await postPayload(payload);
      if(json.success) toast("Soal ditambahkan tanpa gambar penjelasan (terlalu besar).");
    }
    
    if(json.success){
      // Reset form
      $("#qsText").value="";
      ["#optA","#optB","#optC","#optD","#optE"].forEach(s=>$(s).value="");
      $("#qsExplanation").value = "";
      if(fileInput) fileInput.value="";
      $("#fileName").textContent="Belum ada file";
      $("#thumbWrap").classList.add("hidden");
      $("#thumb").removeAttribute("src");
      
      if(explanationFileInput) explanationFileInput.value="";
      $("#explanationFileName").textContent="Belum ada file";
      $("#explanationThumbWrap").classList.add("hidden");
      $("#explanationThumb").removeAttribute("src");
      
      if(json.questions) renderPreview(json.questions);
      toast("Soal berhasil ditambahkan!");
    } else {
      toast(json.message || "Gagal menambah soal");
    }
  } catch(err) {
    toast("Error koneksi: " + err.message);
  } finally { 
    setLoading($("#btnAddQuestion"), false); 
  }
};

$("#btnPreviewQuestions").onclick = async ()=>{
  const roomId = $("#qsRoomId").value.trim();
  const roomPass = $("#qsRoomPassword").value.trim();
  if(!roomId || !roomPass) return toast("Isi Room ID & Password");
  
  setLoading($("#btnPreviewQuestions"), true);
  try{
    const passwordHash = await sha256Hex(roomPass);
    const res = await fetch(
      `${WEB_APP_URL}?action=getQuestions&roomId=${encodeURIComponent(roomId)}&passwordHash=${passwordHash}`
    );
    const json = await res.json();
    if(json.success) {
      renderPreview(json.questions);
      toast("Preview soal berhasil dimuat!");
    } else {
      toast(json.message || "Gagal ambil soal");
    }
  } catch(err) {
    toast("Error koneksi: " + err.message);
  } finally {
    setLoading($("#btnPreviewQuestions"), false);
  }
};

function renderPreview(qs) {
  const box = $("#questionsPreview");
  if(!qs || !qs.length){ 
    box.innerHTML = "<em>Belum ada soal.</em>"; 
    return; 
  }
  
  box.innerHTML = qs.map((q,i)=>{
    // ✅ FIX: Clean the explanation for MathJax rendering
    let explanationHtml = q.explanation || "";
    
    // Convert $$...$$ to proper math containers
    explanationHtml = explanationHtml.replace(/\$\$(.*?)\$\$/g, 
      (match, equation) => {
        // Clean the equation - remove extra backslashes but keep one
        const cleanEquation = equation.replace(/\\\\/g, '\\');
        return `<span class="math-container">$$${cleanEquation}$$</span>`;
      }
    );
    
    // Convert line breaks to <br>
    explanationHtml = explanationHtml.replace(/\n/g, '<br>');
    
    return `
    <div class="card" style="margin:8px 0;">
      <strong>Soal ${i+1}:</strong> ${q.questionText}<br>
      ${q.imageUrl ? `<img src="${q.imageUrl}" class="q-image" alt="Gambar soal">` : ""}
      <ol type="A">${q.options.map(o=>`<li>${o}</li>`).join("")}</ol>
      <div>Kunci: <code>${String.fromCharCode(65 + q.correctIndex)}</code></div>
      ${q.explanation ? `<div class="math-explanation">Penjelasan Guru: ${explanationHtml}</div>` : ''}
      ${q.explanationImageUrl ? `<div><strong>Gambar Penjelasan:</strong><br><img src="${q.explanationImageUrl}" class="q-image" alt="Gambar penjelasan"></div>` : ''}
    </div>
    `;
  }).join("");
  
  // ✅ Re-render MathJax dengan delay yang cukup
  setTimeout(() => {
    if (window.MathJax) {
      MathJax.typesetPromise([box]).then(() => {
        console.log('MathJax rendered in preview');
      }).catch(err => {
        console.log('MathJax preview rendering issue:', err);
      });
    }
  }, 1000);
}

/*********************************************************
 * GURU — RESET SOAL
 *********************************************************/
$("#btnResetQuestions").onclick = async ()=>{
  if(!state.teacher.isAdmin) return toast("Login admin dulu");

  const roomId = $("#qsRoomId").value.trim();
  const roomPass = $("#qsRoomPassword").value.trim();
  if(!roomId || !roomPass) return toast("Isi Room ID & Password ruangan yang ingin di-reset.");

  if(!confirm(`Yakin ingin menghapus SEMUA soal di Room ${roomId}?`)) return;
  const confirmText = prompt(`Ketik ulang Room ID untuk konfirmasi hapus soal:`);
  if(confirmText !== roomId) return toast("Dibatalkan. Room ID tidak cocok.");

  const alsoAnswers = $("#resetAlsoAnswers").checked;

  try{
    setLoading($("#btnResetQuestions"), true);
    const passwordHash = await sha256Hex(roomPass);
    const json = await postPayload({
      action: "resetQuestions",
      roomId,
      passwordHash,
      alsoAnswers,
      adminHash: state.teacher.adminHash
    });

    if(json.success){
      toast(`Berhasil hapus: ${json.deletedQuestions||0} soal` + (alsoAnswers ? `, ${json.deletedAnswers||0} jawaban, ${json.deletedStudents||0} rekap.` : "."));
      const res = await fetch(`${WEB_APP_URL}?action=getQuestions&roomId=${encodeURIComponent(roomId)}&passwordHash=${passwordHash}`);
      const dat = await res.json();
      if(dat.success) renderPreview(dat.questions);
      else $("#questionsPreview").innerHTML = "<em>Belum ada soal.</em>";
    } else {
      toast(json.message || "Gagal reset soal");
    }
  } catch(e) {
    console.error(e);
    toast("Error koneksi saat reset: " + e.message);
  } finally {
    setLoading($("#btnResetQuestions"), false);
  }
};

/*********************************************************
 * SISWA — MASUK & KERJAKAN
 *********************************************************/
$("#btnEnterRoom").onclick = async ()=>{
  const name = $("#studentName").value.trim();
  const roomId = $("#studentRoomId").value.trim();
  const pass = $("#studentPassword").value.trim();
  if(!name || !roomId || !pass) return toast("Lengkapi data masuk siswa");

  setLoading($("#btnEnterRoom"), true);
  try{
    const passwordHash = await sha256Hex(pass);
    const res = await fetch(
      `${WEB_APP_URL}?action=getQuestions&roomId=${encodeURIComponent(roomId)}&passwordHash=${passwordHash}`
    );
    const json = await res.json();

    if(json.success){
      state.student = { name, roomId, password: pass, passwordHash };
      state.questions = json.questions || [];
      state.currentIndex = 0;
      state.studentAnswers = {};

      if(!state.questions.length) {
        toast("Belum ada soal di ruangan ini");
        return;
      }

      $("#studentLogin").classList.add("hidden");
      $("#studentTest").classList.remove("hidden");
      $("#lblStudentName").textContent = name;
      $("#lblRoomId").textContent = roomId;
      $("#totalNo").textContent = state.questions.length;
      
      // ENABLE LOCKDOWN MODE
      enableLockdownMode();
      startTimer();
      renderCurrentQuestion();
      toast("Berhasil masuk ruangan! Lockdown mode aktif.");
    } else {
      toast(json.message || "Room ID / Password salah");
    }
  } catch(err) {
    toast("Error koneksi: " + err.message);
  } finally { 
    setLoading($("#btnEnterRoom"), false); 
  }
};

let selectedIndex = null;

function renderCurrentQuestion() {
  const idx = state.currentIndex;
  const q = state.questions[idx];
  
  $("#currentNo").textContent = idx + 1;
  $("#questionText").textContent = q.questionText;

  const img = $("#questionImage");
  if (q.imageUrl) { 
    img.src = q.imageUrl; 
    img.classList.remove("hidden"); 
  } else { 
    img.classList.add("hidden"); 
    img.removeAttribute("src"); 
  }

  const box = $("#options"); 
  box.innerHTML = "";
  
  const existingAnswer = state.studentAnswers[q.questionId];
  const isSubmitted = existingAnswer && existingAnswer.submitted;
  
  q.options.forEach((opt, i) => {
    const div = document.createElement("div");
    div.className = "option";
    div.textContent = `${String.fromCharCode(65 + i)}. ${opt}`;
    
    if (isSubmitted && existingAnswer.selectedIndex === i) {
      div.classList.add("selected");
    }
    
    if (!isSubmitted) {
      div.onclick = () => selectOption(i);
    } else {
      div.style.opacity = "0.7";
      div.style.cursor = "not-allowed";
    }
    
    box.appendChild(div);
  });

  // Set nilai reason dari jawaban sebelumnya
  $("#reason").value = existingAnswer ? existingAnswer.reason : "";
  
  // Update preview equation untuk siswa
  updateMathPreview("#reason", "#studentMathPreview");
  
  if (isSubmitted) {
    $("#reason").disabled = true;
    $("#reason").style.opacity = "0.7";
    // Disable tombol toolbar untuk siswa
    document.querySelectorAll('.btn-tool-student').forEach(btn => {
      btn.disabled = true;
      btn.style.opacity = "0.5";
      btn.style.cursor = "not-allowed";
    });
    $("#btnSubmitAnswer").disabled = true;
    $("#btnSubmitAnswer").style.opacity = "0.5";
  } else {
    $("#reason").disabled = false;
    $("#reason").style.opacity = "1";
    // Enable tombol toolbar untuk siswa
    document.querySelectorAll('.btn-tool-student').forEach(btn => {
      btn.disabled = false;
      btn.style.opacity = "1";
      btn.style.cursor = "pointer";
    });
    $("#btnSubmitAnswer").disabled = selectedIndex === null;
    $("#btnSubmitAnswer").style.opacity = selectedIndex === null ? "0.5" : "1";
  }

  const feedback = $("#feedback");
  if (isSubmitted && existingAnswer.feedback) {
    feedback.innerHTML = existingAnswer.feedback;
    feedback.classList.remove("hidden");
    
    // ✅ Re-render MathJax untuk feedback yang mengandung rumus
    if (window.MathJax) {
      setTimeout(() => {
        MathJax.typesetPromise([feedback]).catch(err => {
          console.log('MathJax feedback rendering issue:', err);
        });
      }, 100);
    }
  } else {
    feedback.classList.add("hidden");
  }

  selectedIndex = existingAnswer ? existingAnswer.selectedIndex : null;

  $("#btnPrev").disabled = (idx === 0);
  $("#btnNext").disabled = (idx === state.questions.length - 1);
}

function selectOption(i) {
  const currentQ = state.questions[state.currentIndex];
  const existingAnswer = state.studentAnswers[currentQ.questionId];
  
  if (existingAnswer && existingAnswer.submitted) {
    return;
  }
  
  selectedIndex = i;
  $$(".option").forEach(el => el.classList.remove("selected"));
  $$(".option")[i].classList.add("selected");
  
  $("#btnSubmitAnswer").disabled = false;
  $("#btnSubmitAnswer").style.opacity = "1";
}

/*********************************************************
 * SISWA — KIRIM JAWABAN
 *********************************************************/
$("#btnSubmitAnswer").onclick = async () => {
  if (selectedIndex === null) return toast("Pilih jawaban dulu");
  const reason = $("#reason").value.trim();
  if (!reason) return toast("Tulis alasan dulu");

  const q = state.questions[state.currentIndex];
  
  if (state.studentAnswers[q.questionId] && state.studentAnswers[q.questionId].submitted) {
    return toast("Soal ini sudah dijawab!");
  }

  const isCorrectChoice = selectedIndex === q.correctIndex;
  
  setLoading($("#btnSubmitAnswer"), true);
  
  // ANALISIS AI DENGAN expectedReason DENGAN ERROR HANDLING
  let ai = null;
  try {
    ai = await analyzeReasonAI({
      questionText: q.questionText,
      options: q.options,
      correctIndex: q.correctIndex,
      selectedIndex,
      reason,
      expectedReason: q.explanation
    });
    
    if (!ai || !ai.success) {
      throw new Error("AI service tidak merespon dengan sukses");
    }
  } catch (err) {
    console.error("AI analysis failed:", err);
    ai = { 
      success: false, 
      message: "AI service unavailable atau gagal merespon" 
    };
  }

  let label = "TIDAK_PAHAM_KONSEP";
  let analysis = "Perlu memperdalam pemahaman konsep fisika.";
  let tag = "";
  let evidence = "";
  let steps = [];
  let hint = "";
  let conf = 0.0;
  let statusMessage = "";

  // JIKA AI GAGAL, GUNAKAN 4 KATEGORI MANUAL (FALLBACK)
  if (!ai || !ai.success) {
    // Fallback manual classification sederhana
    const reasonLower = reason.toLowerCase();
    const expectedLower = (q.explanation || "").toLowerCase();
    
    // Cek similarity sederhana (term matching)
    const reasonWords = reasonLower.split(/\s+/);
    const expectedWords = expectedLower.split(/\s+/);
    const matchingWords = reasonWords.filter(word => 
      word.length > 3 && expectedWords.includes(word)
    );
    const hasSemanticSimilarity = matchingWords.length > 0;
    
    // Sistem 4 kategori manual
    if (isCorrectChoice && hasSemanticSimilarity) {
      label = "MEMAHAMI_KONSEP";
      statusMessage = "Excellent! Jawaban dan alasan kamu sudah tepat.";
      analysis = `Siswa telah memahami konsep "${q.explanation || 'fisika'}" dengan baik. Alasan "${reason}" tepat dan sesuai dengan konsep fisika.`;
    } else if (isCorrectChoice && !hasSemanticSimilarity) {
      label = "MENEBAK_PEMAHAMAN_TIDAK_LENGKAP";
      statusMessage = "Perlu Perbaikan - Jawaban benar tapi alasannya salah.";
      analysis = `Siswa memilih jawaban benar tetapi alasan "${reason}" tidak tepat. Konsep yang benar: "${q.explanation || 'tidak tersedia'}".`;
    } else if (!isCorrectChoice && hasSemanticSimilarity) {
      label = "MISKONSEPSI";
      statusMessage = "Miskonsepsi Terdeteksi - Jawaban salah tapi alasannya benar.";
      analysis = `Siswa memiliki pemahaman yang keliru. Meskipun alasan "${reason}" tampak benar, jawaban yang dipilih salah. Konsep yang benar: "${q.explanation || 'tidak tersedia'}".`;
    } else {
      label = "TIDAK_PAHAM_KONSEP";
      statusMessage = "Tidak Paham Konsep - Jawaban dan alasan salah.";
      analysis = `Siswa belum memahami konsep dasar. Jawaban dan alasan "${reason}" salah. Konsep yang benar: "${q.explanation || 'tidak tersedia'}".`;
    }
    
    tag = label === "MISKONSEPSI" ? "misconception" : 
          label === "MEMAHAMI_KONSEP" ? "excellent" : 
          label === "MENEBAK_PEMAHAMAN_TIDAK_LENGKAP" ? "guessing" : "no_understanding";
    
    hint = label === "MEMAHAMI_KONSEP" ? "Pertahankan pemahaman konsep fisika yang baik!" :
           label === "MENEBAK_PEMAHAMAN_TIDAK_LENGKAP" ? "Perbaiki pemahaman konsep meskipun pilihan benar." :
           label === "MISKONSEPSI" ? "Pelajari kembali konsep dasar fisika yang relevan." :
           "Fokus pada pemahaman konsep fisika dasar.";
    
    steps = label === "TIDAK_PAHAM_KONSEP" ? 
            ["Pahami konsep dasar fisika yang relevan dengan soal", "Baca materi konsep dasar dari sumber yang terpercaya", "Minta bantuan guru untuk penjelasan lebih detail"] :
            label === "MISKONSEPSI" ? 
            [`Identifikasi kesalahan pemahaman: ${q.explanation || 'konsep fisika'}`, "Pelajari kembali konsep yang benar dengan contoh-contoh", "Latihan soal dengan variasi yang berbeda"] :
            label === "MENEBAK_PEMAHAMAN_TIDAK_LENGKAP" ?
            ["Perbaiki pemahaman konsep meskipun pilihan benar", `Pelajari: ${q.explanation || 'konsep yang benar'}`, "Jangan hanya menghafal jawaban, pahami alasannya"] :
            ["Pertahankan pemahaman konsep yang baik", "Terus latihan soal dengan variasi yang berbeda"];
    
    conf = 0.8; // Default confidence untuk fallback
  } else {
    // GUNAKAN RESPONSE AI JIKA BERHASIL
    if (ai && ai.success) {
      label = ai.classification || label;
      analysis = ai.analysis || analysis;
      tag = ai.misconception_tag || "";
      evidence = ai.evidence || "";
      steps = Array.isArray(ai.correction_steps) ? ai.correction_steps : [];
      hint = ai.hint || "";
      conf = typeof ai.confidence === "number" ? ai.confidence : 0;
      statusMessage = ai.status_message || "";
    }
  }

  // TAMPILAN FEEDBACK - 4 KATEGORI
  const f = $("#feedback");
  let html = '';
  
  // Tentukan badge class berdasarkan 4 kategori
  let badgeClass = "err";
  if (label === "MEMAHAMI_KONSEP") {
    badgeClass = "ok";
  } else if (label === "MENEBAK_PEMAHAMAN_TIDAK_LENGKAP" || label === "MISKONSEPSI") {
    badgeClass = "warn";
  } else if (label === "TIDAK_PAHAM_KONSEP") {
    badgeClass = "err";
  }
  
  html += `<span class="badge ${badgeClass}">${label}</span> `;
  
  if (statusMessage) {
    html += `<strong>${statusMessage}</strong><br>`;
  } else {
    // Pesan untuk 4 kategori
    if (label === "MEMAHAMI_KONSEP") {
      html += `✅ <strong>Memahami Konsep</strong> - Jawaban dan alasan benar.<br>`;
    } else if (label === "MENEBAK_PEMAHAMAN_TIDAK_LENGKAP") {
      html += `⚠️ <strong>Menebak/Pemahaman Tidak Lengkap</strong> - Jawaban benar, alasan salah.<br>`;
    } else if (label === "MISKONSEPSI") {
      html += `🔄 <strong>Miskonsepsi</strong> - Jawaban salah, alasan benar.<br>`;
    } else if (label === "TIDAK_PAHAM_KONSEP") {
      html += `❌ <strong>Tidak Paham Konsep</strong> - Jawaban dan alasan salah.<br>`;
    }
  }
  
  // Tambahkan warning jika AI gagal (informasi untuk debugging)
  if (!ai || !ai.success) {
    html += `<div style="margin-top:6px; padding:8px; background:rgba(245,158,11,0.15); border-radius:8px; border:1px solid rgba(245,158,11,0.3);">
              <small>⚠️ <em>Sistem AI sedang offline. Analisis menggunakan sistem fallback.</em></small>
            </div>`;
  }
  
  html += `<div style="margin-top:6px"><strong>Analisis:</strong> ${escapeHtml(analysis)}</div>`;
  
  if (evidence) {
    html += `<div style="margin-top:6px"><strong>Poin Analisis:</strong> "${escapeHtml(evidence)}"</div>`;
  }
  
  if (hint) {
    html += `<div style="margin-top:6px"><strong>Tips:</strong> ${escapeHtml(hint)}</div>`;
  }
  
  if (steps && steps.length > 0) {
    html += `<div style="margin-top:6px"><strong>Langkah perbaikan:</strong><ol style="margin:4px 0; padding-left:20px;">`;
    steps.forEach(step => {
      html += `<li>${escapeHtml(step)}</li>`;
    });
    html += `</ol></div>`;
  }
  
  html += `<div style="margin-top:6px"><strong>Jawaban benar:</strong> ${String.fromCharCode(65 + q.correctIndex)}. ${escapeHtml(q.options[q.correctIndex])}</div>`;
  
  if (conf) {
    html += `<div style="margin-top:6px"><small>Tingkat keyakinan AI: ${(conf * 100).toFixed(0)}%</small></div>`;
  }
  
  const guruExplanation = q.explanation || "";
  if (guruExplanation.trim() !== "") {
    // ✅ FIX: Process guru explanation for MathJax
    let guruExplanationHtml = guruExplanation;
    
    // Convert $$...$$ to proper math containers
    guruExplanationHtml = guruExplanationHtml.replace(/\$\$(.*?)\$\$/g, 
      (match, equation) => {
        const cleanEquation = equation.replace(/\\\\/g, '\\');
        return `<span class="math-container">$$${cleanEquation}$$</span>`;
      }
    );
    
    // Convert line breaks to <br>
    guruExplanationHtml = guruExplanationHtml.replace(/\n/g, '<br>');
    
    html += `<hr style="margin:12px 0; border-color:rgba(148,163,184,.2);">`;
    html += `<div style="margin-top:6px" class="guru-explanation"><strong>Penjelasan Guru:</strong> ${guruExplanationHtml}</div>`;
  }
  
  if (q.explanationImageUrl) {
    html += `<div style="margin-top:12px;"><strong>Gambar Penjelasan Guru:</strong><br>
             <img src="${q.explanationImageUrl}" class="q-image" alt="Gambar penjelasan" 
                  style="max-width:100%; height:auto; border-radius:12px; border:1px solid rgba(100,116,139,.35);"></div>`;
  }

  f.innerHTML = html;
  f.classList.remove("hidden");
  f.classList.remove("ok", "warn", "err");
  f.classList.add(badgeClass);

  setTimeout(() => {
    if (window.MathJax) {
      const guruExplanationElements = f.querySelectorAll('.guru-explanation');
      MathJax.typesetPromise(guruExplanationElements).then(() => {
        console.log('MathJax rendered guru explanation');
      }).catch(err => {
        console.log('MathJax guru explanation rendering issue:', err);
      });
    }
  }, 500);
  
  // SIMPAN KE STATE
  state.studentAnswers[q.questionId] = {
    selectedIndex,
    reason,
    submitted: true,
    feedback: html,
    isCorrect: isCorrectChoice,
    aiFailed: !ai || !ai.success // Flag untuk menandai AI gagal
  };

  // KIRIM KE SERVER
  const payload = {
    action: "submitAnswer",
    roomId: state.student.roomId,
    questionId: q.questionId,
    questionText: q.questionText,
    selectedIndex,
    selectedText: q.options[selectedIndex],
    correctIndex: q.correctIndex,
    studentName: state.student.name,
    reason,
    isCorrect: isCorrectChoice,
    errorType: (label === "MISKONSEPSI" ? "misconception" : (label === "MEMAHAMI_KONSEP" ? null : "concept_error")),
    score: isCorrectChoice ? 1 : 0,
    clientTime: new Date().toLocaleString("id-ID"),
    ai_label: label,
    ai_tag: tag,
    ai_analysis: analysis,
    ai_hint: hint,
    ai_confidence: conf,
    ai_fallback_used: !ai || !ai.success // Tambahkan flag apakah menggunakan fallback
  };
  
  try { 
    await postPayload(payload); 
    toast("Jawaban berhasil disimpan!");
  } catch (e) { 
    console.error(e);
    toast("Jawaban disimpan lokal, tapi gagal ke server.");
  }
  
  setLoading($("#btnSubmitAnswer"), false);
  
  // NONAKTIFKAN INPUT SETELAH SUBMIT
  $("#reason").disabled = true;
  // Disable tombol toolbar untuk siswa
  document.querySelectorAll('.btn-tool-student').forEach(btn => {
    btn.disabled = true;
    btn.style.opacity = "0.5";
    btn.style.cursor = "not-allowed";
  });
  $("#btnSubmitAnswer").disabled = true;
  $$(".option").forEach(opt => {
    opt.style.cursor = "not-allowed";
    opt.style.opacity = "0.7";
  });
};

/*********************************************************
 * NAVIGASI SOAL
 *********************************************************/
$("#btnNext").onclick = ()=>{
  if(state.currentIndex < state.questions.length-1){
    state.currentIndex++; 
    renderCurrentQuestion();
  }
};

$("#btnPrev").onclick = ()=>{
  if(state.currentIndex > 0){
    state.currentIndex--; 
    renderCurrentQuestion();
  }
};

$("#btnFinish").onclick = ()=>{
  stopTimer();
  disableLockdownMode();
  toast("Terima kasih, jawabanmu tersimpan & direkap di Google Sheet.");
  show("#pageHome");
  $("#studentLogin").classList.remove("hidden");
  $("#studentTest").classList.add("hidden");
};

function debugEquation() {
  const content = $("#qsExplanation").value;
  console.log('Raw content:', content);
  console.log('Processed content:', content.replace(/\\\\/g, '\\'));
  
  const equations = content.match(/\$\$(.*?)\$\$/g) || [];
  console.log('Equations found:', equations);
  
  equations.forEach((eq, index) => {
    console.log(`Equation ${index + 1}:`, eq);
    console.log(`Cleaned ${index + 1}:`, eq.replace(/\\\\/g, '\\'));
  });
}