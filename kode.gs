/***************************************************
 * CONFIGURASI SISTEM FISIKA
 ***************************************************/
const SHEET_ID = "1X2H4gyoWar9BAIit_dV-NeQYEYmKNVITZDleEo-uPn8";
const SH_ROOMS = "Rooms";
const SH_QUEST = "Questions";
const SH_ANSWERS = "Answers";
const SH_STUDENTS = "Students";

const ADMIN_PASSWORD_PLAIN = "gurufisika2025";
const CACHE_TTL_SEC = 300; // Ditingkatkan dari 180 ke 300 detik
const MAX_IMAGE_CHARS = 48000;

/***************************************************
 * INISIALISASI SHEETS & UTILITIES
 ***************************************************/
function SS() { return SpreadsheetApp.openById(SHEET_ID); }

function ensureSheet_(name, headers) {
  const ss = SS();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  
  const currentHeaders = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  
  if (sh.getLastRow() === 0 || currentHeaders.length !== headers.length) {
    if (sh.getLastRow() > 0) {
      sh.clear();
    }
    sh.appendRow(headers);
    sh.getRange(1, 1, 1, headers.length)
      .setBackground("#eef2ff").setFontWeight("bold")
      .setHorizontalAlignment("center");
    for (let i = 1; i <= headers.length; i++) sh.setColumnWidth(i, 160);
    sh.setFrozenRows(1);
  }
  return sh;
}

function ensureStudentsSheetReady_() {
  let sh = SS().getSheetByName(SH_STUDENTS);
  if (!sh) { sh = SS().insertSheet(SH_STUDENTS); }
  if (sh.getLastRow() === 0) {
    sh.appendRow(["timestamp", "room_id", "student_name", "answers", "correct", "score", "accuracy_pct", "last_submit"]);
    sh.getRange(1, 1, 1, 8).setBackground("#eef2ff").setFontWeight("bold").setHorizontalAlignment("center");
    for (let i = 1; i <= 8; i++) sh.setColumnWidth(i, 160);
    sh.setFrozenRows(1);
  }
  if (sh.getMaxColumns() < 8) {
    sh.insertColumnsAfter(sh.getMaxColumns(), 8 - sh.getMaxColumns());
  }
}

function init_() {
  ensureSheet_(SH_ROOMS, ["timestamp", "room_id", "room_name", "password_hash", "created_by"]);
  ensureSheet_(SH_QUEST, ["timestamp", "room_id", "question_id", "question_text", "options_json", "correct_index", "explanation", "image_url", "explanation_image_url"]);
  ensureSheet_(SH_ANSWERS, [
    "timestamp", "room_id", "question_id", "student_name", "question_text",
    "selected_index", "selected_text", "correct_index", "reason", "is_correct",
    "error_type", "score", "client_time",
    "ai_label", "ai_tag", "ai_analysis", "ai_hint", "ai_confidence"
  ]);
  ensureStudentsSheetReady_();
}

function ok_(obj) { return ContentService.createTextOutput(JSON.stringify({ success: true, ...obj })).setMimeType(ContentService.MimeType.JSON); }
function fail_(msg) { return ContentService.createTextOutput(JSON.stringify({ success: false, message: String(msg || "error") })).setMimeType(ContentService.MimeType.JSON); }

function sha256Hex_(s) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return raw.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
}
const ADMIN_PASSWORD_HASH = sha256Hex_(ADMIN_PASSWORD_PLAIN);

/***************************************************
 * SISTEM CACHE UNTUK OPTIMASI
 ***************************************************/
function cache_() { return CacheService.getScriptCache(); }
function cacheGetJson_(key) { const t = cache_().get(key); return t ? JSON.parse(t) : null; }
function cachePutJson_(key, val, ttl = CACHE_TTL_SEC) { try { cache_().put(key, JSON.stringify(val), ttl); } catch (e) { } }
function cacheDel_(key) { try { cache_().remove(key); } catch (e) { } }

/***************************************************
 * HANDLER HTTP REQUEST DENGAN HEALTH CHECK
 ***************************************************/
function doGet(e) {
  try {
    // ✅ HEALTH CHECK ENDPOINT - SUDAH ADA
    if (e.parameter && e.parameter.action === "health") {
      const cache = CacheService.getScriptCache();
      cache.put('last_health_check', new Date().toString(), 600);
      console.log('Health check: ' + new Date());
      // PERBAIKAN: Return JSON bukan TEXT
      return ContentService.createTextOutput(
        JSON.stringify({ 
          success: true, 
          status: "OK", 
          timestamp: new Date().toISOString() 
        })
      ).setMimeType(ContentService.MimeType.JSON);
    }
    
    // ✅ TAMBAHKAN KEEP ALIVE ENDPOINT - INI YANG BELUM ADA
    if (e.parameter && e.parameter.action === "keepAlive") {
      const cache = CacheService.getScriptCache();
      cache.put('last_activity', new Date().toString(), 21600); // 6 jam
      console.log('Keep alive ping: ' + new Date());
      
      return ContentService.createTextOutput(
        JSON.stringify({ 
          success: true, 
          message: "Alive", 
          timestamp: new Date().toISOString() 
        })
      ).setMimeType(ContentService.MimeType.JSON);
    }
    
    init_();
    const action = (e.parameter && e.parameter.action) || "";
    if (action === "getQuestions") return handleGetQuestions_(e);
    if (action === "getLeaderboard") return handleGetLeaderboard_(e);
    if (action === "getStudentProgress") return handleGetStudentProgress_(e);
    if (action === "getRoomStats") return handleGetRoomStats_(e);
    return ok_({ message: "Sistem Evaluasi Fisika Aktif" });
  } catch (err) { return fail_(err && err.message); }
}

function parseBody_(e) {
  let data = {};
  try {
    if (e && e.postData && e.postData.contents) {
      try { data = JSON.parse(e.postData.contents); }
      catch (_) {
        if (e.parameter && e.parameter.payload) {
          try { data = JSON.parse(e.parameter.payload); } catch (__) { }
        }
      }
    } else if (e && e.parameter && e.parameter.payload) {
      try { data = JSON.parse(e.parameter.payload); } catch (__) { }
    }
    if (!data || !data.action) {
      data = Object.assign({}, e && e.parameter ? e.parameter : {});
      if (data.payload && !data.action) { try { data = JSON.parse(data.payload); } catch (__) { } }
    }
  } catch (_) { }
  return data || {};
}

function doPost(e) {
  try {
    init_();
    const data = parseBody_(e);
    const action = data.action || "";

    if (action === "createRoom") return handleCreateRoom_(data);
    if (action === "addQuestion") return handleAddQuestion_(data);
    if (action === "submitAnswer") return handleSubmitAnswer_(data);
    if (action === "analyzeReasonGemini") return handleAnalyzeReasonGemini_(data);
    if (action === "resetQuestions") return handleResetQuestions_(data);
    if (action === "updateQuestion") return handleUpdateQuestion_(data);
    if (action === "deleteQuestion") return handleDeleteQuestion_(data);
    if (action === "updateRoom") return handleUpdateRoom_(data);
    return fail_("Aksi tidak dikenali: " + action);
  } catch (err) { return fail_(err && err.message); }
}

/***************************************************
 * AKSES DATA ROOM DAN QUESTIONS
 ***************************************************/
function requireAdmin_(adminHash) {
  if (!adminHash) throw new Error("Password admin diperlukan");
  if (adminHash !== ADMIN_PASSWORD_HASH) throw new Error("Password admin tidak valid");
}

function findRoom_(roomId) {
  const key = `room:${roomId}`;
  let room = cacheGetJson_(key);
  if (room) return room;

  const sh = SS().getSheetByName(SH_ROOMS);
  const last = sh.getLastRow();
  if (last < 2) return null;
  const vals = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  for (const r of vals) {
    if (r[1] === roomId) {
      room = { room_id: r[1], room_name: r[2], password_hash: r[3], created_by: r[4] };
      cachePutJson_(key, room);
      return room;
    }
  }
  return null;
}

function getQuestions_(roomId) {
  const key = `questions:${roomId}`;
  let qs = cacheGetJson_(key);
  if (qs) return qs;

  const sh = SS().getSheetByName(SH_QUEST);
  const last = sh.getLastRow();
  if (last < 2) { cachePutJson_(key, []); return []; }
  const vals = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  qs = vals
    .filter(r => r[1] === roomId)
    .map(r => ({
      questionId: r[2],
      questionText: r[3],
      options: JSON.parse(r[4] || "[]"),
      correctIndex: Number(r[5] || 0),
      explanation: r[6] || "",
      imageUrl: r[7] || "",
      explanationImageUrl: r[8] || ""
    }));
  cachePutJson_(key, qs);
  return qs;
}

/***************************************************
 * HANDLER UTAMA UNTUK OPERASI SISTEM
 ***************************************************/
function handleCreateRoom_(data) {
  const { roomName, passwordHash, createdBy, adminHash } = data;
  if (!roomName || !passwordHash || !createdBy) return fail_("Data tidak lengkap");
  requireAdmin_(adminHash);

  const roomId = ("ROOM-" + Utilities.getUuid()).slice(0, 12);
  SS().getSheetByName(SH_ROOMS).appendRow([new Date(), roomId, roomName, passwordHash, createdBy]);
  cacheDel_(`room:${roomId}`);
  return ok_({ roomId });
}

function handleAddQuestion_(data) {
  const { roomId, passwordHash, questionText, options, correctIndex, adminHash, imageDataUrl, explanation, explanationImageDataUrl } = data;
  if (!roomId || !passwordHash || !questionText || !options || options.length < 2) return fail_("Data pertanyaan tidak lengkap");
  requireAdmin_(adminHash);

  const room = findRoom_(roomId);
  if (!room) return fail_("Ruangan tidak ditemukan");
  if (room.password_hash !== passwordHash) return fail_("Password ruangan salah");

  const img = imageDataUrl || "";
  const explanationImg = explanationImageDataUrl || "";
  
  if (img && img.length > MAX_IMAGE_CHARS) return fail_("GAMBAR_TERLALU_BESAR");
  if (explanationImg && explanationImg.length > MAX_IMAGE_CHARS) return fail_("GAMBAR_PENJELASAN_TERLALU_BESAR");

  const qid = ("Q-" + Utilities.getUuid()).slice(0, 10);
  SS().getSheetByName(SH_QUEST).appendRow([
    new Date(), roomId, qid, questionText, JSON.stringify(options),
    Number(correctIndex), (explanation || ""), img, explanationImg
  ]);

  cacheDel_(`questions:${roomId}`);
  const questions = getQuestions_(roomId);
  return ok_({ questionId: qid, questions });
}

function handleGetQuestions_(e) {
  const roomId = e.parameter.roomId;
  const passwordHash = e.parameter.passwordHash;
  if (!roomId || !passwordHash) return fail_("Parameter tidak lengkap");

  const room = findRoom_(roomId);
  if (!room) return fail_("Ruangan tidak ditemukan");
  if (room.password_hash !== passwordHash) return fail_("Password salah");

  const questions = getQuestions_(roomId);
  return ok_({ questions, roomName: room.room_name });
}

function handleSubmitAnswer_(data) {
  const {
    roomId, questionId, questionText, selectedIndex, selectedText, correctIndex,
    studentName, reason, isCorrect, errorType, score, clientTime,
    ai_label, ai_tag, ai_analysis, ai_hint, ai_confidence
  } = data;

  if (!roomId || !questionId || !studentName) return fail_("Data jawaban tidak lengkap");

  const shA = SS().getSheetByName(SH_ANSWERS);

  shA.appendRow([
    new Date(), roomId, questionId, studentName, questionText || "",
    Number(selectedIndex), selectedText || "", Number(correctIndex || 0),
    reason || "", Boolean(isCorrect), errorType || "", Number(score || 0), clientTime || "",
    ai_label || "", ai_tag || "", ai_analysis || "", ai_hint || "", Number(ai_confidence || 0)
  ]);

  const last = shA.getLastRow();
  const dataRows = last - 1;
  if (dataRows >= 2) {
    shA.getRange(2, 1, dataRows, shA.getLastColumn())
      .sort([{ column: 1, ascending: false }]);
  }

  try {
    ensureStudentsSheetReady_();
    upsertStudent_(roomId, studentName, Boolean(isCorrect), Number(score || 0), clientTime || "");
  } catch (err) {
    const shS = SS().getSheetByName(SH_STUDENTS) || SS().insertSheet(SH_STUDENTS);
    if (shS.getLastRow() === 0) {
      shS.appendRow(["timestamp", "room_id", "student_name", "answers", "correct", "score", "accuracy_pct", "last_submit"]);
    }
    shS.appendRow([new Date(), roomId, studentName, 1, isCorrect ? 1 : 0, Number(score || 0), isCorrect ? 100 : 0, clientTime || ""]);
    console.error("ERROR_UPSERT_SISWA:", err && err.message);
  }

  SpreadsheetApp.flush();
  return ok_({});
}

function upsertStudent_(roomId, studentName, isCorrect, scoreDelta, lastSubmit) {
  ensureStudentsSheetReady_();
  const shS = SS().getSheetByName(SH_STUDENTS);
  if (shS.getMaxColumns() < 8) {
    shS.insertColumnsAfter(shS.getMaxColumns(), 8 - shS.getMaxColumns());
  }

  const last = shS.getLastRow();
  if (last >= 2) {
    const vals = shS.getRange(2, 1, last - 1, 8).getValues();
    for (let i = 0; i < vals.length; i++) {
      const r = vals[i];
      if (String(r[1]) === String(roomId) && String(r[2]) === String(studentName)) {
        const answers = Number(r[3] || 0) + 1;
        const correct = Number(r[4] || 0) + (isCorrect ? 1 : 0);
        const score = Number(r[5] || 0) + Number(scoreDelta || 0);
        const acc = answers ? Math.round((correct / answers) * 100) : 0;
        const rowIdx = i + 2;
        shS.getRange(rowIdx, 1, 1, 8).setValues([[new Date(), roomId, studentName, answers, correct, score, acc, lastSubmit]]);
        return;
      }
    }
  }
  const acc = isCorrect ? 100 : 0;
  shS.appendRow([new Date(), roomId, studentName, 1, isCorrect ? 1 : 0, Number(scoreDelta || 0), acc, lastSubmit]);
}

/***************************************************
 * OPERASI TAMBAHAN UNTUK ADMIN
 ***************************************************/
function handleUpdateQuestion_(data) {
  const { roomId, questionId, passwordHash, questionText, options, correctIndex, adminHash, explanation } = data;
  if (!roomId || !questionId || !passwordHash || !questionText || !options || options.length < 2) return fail_("Data pertanyaan tidak lengkap");
  requireAdmin_(adminHash);

  const room = findRoom_(roomId);
  if (!room) return fail_("Ruangan tidak ditemukan");
  if (room.password_hash !== passwordHash) return fail_("Password ruangan salah");

  const shQ = SS().getSheetByName(SH_QUEST);
  const last = shQ.getLastRow();
  if (last < 2) return fail_("Tidak ada soal ditemukan");

  const vals = shQ.getRange(2, 1, last - 1, shQ.getLastColumn()).getValues();
  for (let i = 0; i < vals.length; i++) {
    const r = vals[i];
    if (r[1] === roomId && r[2] === questionId) {
      const rowIdx = i + 2;
      shQ.getRange(rowIdx, 4, 1, 4).setValues([[questionText, JSON.stringify(options), Number(correctIndex), explanation || ""]]);
      cacheDel_(`questions:${roomId}`);
      return ok_({ success: true, message: "Soal berhasil diupdate" });
    }
  }
  return fail_("Soal tidak ditemukan");
}

function handleDeleteQuestion_(data) {
  const { roomId, questionId, passwordHash, adminHash } = data;
  if (!roomId || !questionId || !passwordHash) return fail_("Data tidak lengkap");
  requireAdmin_(adminHash);

  const room = findRoom_(roomId);
  if (!room) return fail_("Ruangan tidak ditemukan");
  if (room.password_hash !== passwordHash) return fail_("Password ruangan salah");

  const shQ = SS().getSheetByName(SH_QUEST);
  const last = shQ.getLastRow();
  if (last < 2) return fail_("Tidak ada soal ditemukan");

  const vals = shQ.getRange(2, 1, last - 1, shQ.getLastColumn()).getValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    const r = vals[i];
    if (r[1] === roomId && r[2] === questionId) {
      shQ.deleteRow(i + 2);
      cacheDel_(`questions:${roomId}`);
      return ok_({ success: true, message: "Soal berhasil dihapus" });
    }
  }
  return fail_("Soal tidak ditemukan");
}

function handleUpdateRoom_(data) {
  const { roomId, newRoomName, newPasswordHash, adminHash } = data;
  if (!roomId || !newRoomName || !newPasswordHash) return fail_("Data tidak lengkap");
  requireAdmin_(adminHash);

  const shR = SS().getSheetByName(SH_ROOMS);
  const last = shR.getLastRow();
  if (last < 2) return fail_("Tidak ada ruangan ditemukan");

  const vals = shR.getRange(2, 1, last - 1, shR.getLastColumn()).getValues();
  for (let i = 0; i < vals.length; i++) {
    const r = vals[i];
    if (r[1] === roomId) {
      const rowIdx = i + 2;
      shR.getRange(rowIdx, 3, 1, 2).setValues([[newRoomName, newPasswordHash]]);
      cacheDel_(`room:${roomId}`);
      return ok_({ success: true, message: "Ruangan berhasil diupdate" });
    }
  }
  return fail_("Ruangan tidak ditemukan");
}

/***************************************************
 * RESET QUESTIONS DAN DATA
 ***************************************************/
function handleResetQuestions_(data) {
  const { roomId, passwordHash, adminHash, alsoAnswers } = data;
  if (!roomId || !passwordHash) return fail_("Parameter tidak lengkap");
  requireAdmin_(adminHash);

  const room = findRoom_(roomId);
  if (!room) return fail_("Ruangan tidak ditemukan");
  if (room.password_hash !== passwordHash) return fail_("Password ruangan salah");

  const shQ = SS().getSheetByName(SH_QUEST);
  const shA = SS().getSheetByName(SH_ANSWERS);
  const shS = SS().getSheetByName(SH_STUDENTS);

  let deletedQuestions = 0;
  let deletedAnswers = 0;
  let deletedStudents = 0;

  if (shQ.getLastRow() > 1) {
    const qData = shQ.getRange(2, 1, shQ.getLastRow() - 1, shQ.getLastColumn()).getValues();
    const toDelete = [];

    for (let i = qData.length - 1; i >= 0; i--) {
      if (qData[i][1] === roomId) {
        toDelete.push(i + 2);
      }
    }

    toDelete.forEach(row => {
      shQ.deleteRow(row);
      deletedQuestions++;
    });
  }

  if (alsoAnswers) {
    if (shA.getLastRow() > 1) {
      const aData = shA.getRange(2, 1, shA.getLastRow() - 1, shA.getLastColumn()).getValues();
      const toDeleteA = [];

      for (let i = aData.length - 1; i >= 0; i--) {
        if (aData[i][1] === roomId) {
          toDeleteA.push(i + 2);
        }
      }

      toDeleteA.forEach(row => {
        shA.deleteRow(row);
        deletedAnswers++;
      });
    }

    if (shS.getLastRow() > 1) {
      const sData = shS.getRange(2, 1, shS.getLastRow() - 1, shS.getLastColumn()).getValues();
      const toDeleteS = [];

      for (let i = sData.length - 1; i >= 0; i--) {
        if (sData[i][1] === roomId) {
          toDeleteS.push(i + 2);
        }
      }

      toDeleteS.forEach(row => {
        shS.deleteRow(row);
        deletedStudents++;
      });
    }
  }

  cacheDel_(`questions:${roomId}`);
  SpreadsheetApp.flush();
  
  return ok_({
    deletedQuestions,
    deletedAnswers: alsoAnswers ? deletedAnswers : 0,
    deletedStudents: alsoAnswers ? deletedStudents : 0
  });
}

/***************************************************
 * LEADERBOARD DAN STATISTIK
 ***************************************************/
function handleGetLeaderboard_(e) {
  const roomId = e.parameter.roomId;
  if (!roomId) return fail_("Parameter roomId diperlukan");
  const shS = SS().getSheetByName(SH_STUDENTS);
  const last = shS.getLastRow();
  if (last < 2) return ok_({ leaderboard: [] });
  const rows = shS.getRange(2, 1, last - 1, shS.getLastColumn()).getValues();
  const list = rows
    .filter(r => r[1] === roomId)
    .map(r => ({ 
      studentName: r[2], 
      answers: r[3], 
      correct: r[4], 
      score: r[5], 
      accuracy: r[6], 
      lastSubmit: r[7] 
    }))
    .sort((a, b) => b.score - a.score);
  return ok_({ leaderboard: list });
}

function handleGetStudentProgress_(e) {
  const roomId = e.parameter.roomId;
  const studentName = e.parameter.studentName;
  if (!roomId || !studentName) return fail_("Parameter roomId dan studentName diperlukan");

  const shA = SS().getSheetByName(SH_ANSWERS);
  const last = shA.getLastRow();
  if (last < 2) return ok_({ progress: [] });

  const rows = shA.getRange(2, 1, last - 1, shA.getLastColumn()).getValues();
  const progress = rows
    .filter(r => r[1] === roomId && r[3] === studentName)
    .map(r => ({
      timestamp: r[0],
      questionId: r[2],
      questionText: r[4],
      selectedIndex: r[5],
      correctIndex: r[7],
      isCorrect: r[9],
      score: r[11],
      ai_label: r[13],
      ai_analysis: r[15]
    }))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  return ok_({ progress });
}

function handleGetRoomStats_(e) {
  const roomId = e.parameter.roomId;
  if (!roomId) return fail_("Parameter roomId diperlukan");

  const shS = SS().getSheetByName(SH_STUDENTS);
  const shA = SS().getSheetByName(SH_ANSWERS);
  const shQ = SS().getSheetByName(SH_QUEST);

  let totalStudents = 0;
  let totalAnswers = 0;
  let totalCorrect = 0;
  let avgAccuracy = 0;

  if (shS.getLastRow() > 1) {
    const sRows = shS.getRange(2, 1, shS.getLastRow() - 1, shS.getLastColumn()).getValues();
    const roomStudents = sRows.filter(r => r[1] === roomId);
    totalStudents = roomStudents.length;
    
    if (totalStudents > 0) {
      roomStudents.forEach(r => {
        totalAnswers += Number(r[3] || 0);
        totalCorrect += Number(r[4] || 0);
        avgAccuracy += Number(r[6] || 0);
      });
      avgAccuracy = Math.round(avgAccuracy / totalStudents);
    }
  }

  let misconceptionCount = 0;
  let correctCount = 0;
  let wrongCount = 0;

  if (shA.getLastRow() > 1) {
    const aRows = shA.getRange(2, 1, shA.getLastRow() - 1, shA.getLastColumn()).getValues();
    const roomAnswers = aRows.filter(r => r[1] === roomId);
    
    roomAnswers.forEach(r => {
      if (r[9] === true) correctCount++;
      else wrongCount++;
      
      if (r[13] && r[13].includes("MISKONSEPSI")) misconceptionCount++;
    });
  }

  const questionCount = getQuestions_(roomId).length;

  return ok_({
    roomId,
    totalStudents,
    totalAnswers,
    totalCorrect,
    avgAccuracy,
    questionCount,
    misconceptionCount,
    correctCount,
    wrongCount,
    overallAccuracy: totalAnswers > 0 ? Math.round((totalCorrect / totalAnswers) * 100) : 0
  });
}

/***************************************************
 * SISTEM AI UNTUK ANALISIS FISIKA - GROQ ONLY
 ***************************************************/
function getProvider_() {
  return "GROQ";
}

/***************************************************
 * GROQ AI PROVIDER
 ***************************************************/
const GROQ_CHAT_MODELS = [
  "llama-3.1-8b-instant",
  "gemma2-9b-it", 
  "mixtral-8x7b-32768"
];

function getGroqKey_() {
  const k = PropertiesService.getScriptProperties().getProperty("GROQ_API_KEY");
  if (!k) throw new Error("GROQ_API_KEY belum diset di Script Properties.");
  return k.trim();
}

function callGroq_(prompt) {
  const key = getGroqKey_();
  let lastError = "";
  for (const model of GROQ_CHAT_MODELS) {
    const url = "https://api.groq.com/openai/v1/chat/completions";
    const payload = {
      model,
      messages: [
        { role: "system", content: "Anda hanya merespons dengan JSON satu baris sesuai skema yang diminta." },
        { role: "user", content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 400
    };
    const res = UrlFetchApp.fetch(url, {
      method: "post",
      muteHttpExceptions: true,
      contentType: "application/json",
      headers: { Authorization: "Bearer " + key },
      payload: JSON.stringify(payload),
      timeout: 30000
    });
    const code = res.getResponseCode();
    const body = res.getContentText();
    if (code >= 200 && code < 300) {
      const data = JSON.parse(body || "{}");
      const text = data?.choices?.[0]?.message?.content || "";
      const cleaned = (text || "").replace(/```json\s*|\s*```/g, "").trim();
      if (!cleaned) throw new Error(`Respons kosong dari GROQ (${model})`);
      return tryParseResultJson_(cleaned);
    }
    lastError = `(${model}) ${code}: ${body.slice(0, 600)}`;
    if ([404, 429, 500, 502, 503].includes(code)) continue;
  }
  throw new Error("Semua model GROQ gagal: " + lastError);
}

function tryParseResultJson_(raw) {
  try { return JSON.parse(raw); } catch (_) { }
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    const s = m[0].replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    try { return JSON.parse(s); } catch (_) { }
  }
  return {
    analysis: "Perlu memperdalam pemahaman konsep fisika.",
    correction_steps: ["Pelajari konsep dasar fisika yang relevan"],
    hint: "Fokus pada pemahaman konsep, bukan menghafal jawaban"
  };
}

/***************************************************
 * DETEKSI ALASAN TIDAK RELEVAN
 ***************************************************/
function isReasonIrrelevant_(reason, expectedReason = "") {
  const reasonText = String(reason || "").toLowerCase().trim();
  const expectedText = String(expectedReason || "").toLowerCase().trim();
  
  if (reasonText.length < 2) return true;
  
  if (/^[\s\W_]+$/.test(reasonText)) {
    return true;
  }

  const alwaysIrrelevantPatterns = [
    "ngasal", "tebak", "random", "gak tau", "ga tau", "tidak tahu", "ngawur",
    "asal", "coba", "mungkin", "kayaknya", "entah", "saya rasa", "hmmm", 
    "sepertinya", "kira", "idk", "nothing", "tdk tau", "gatau", 
    "insting", "feeling", "perasaan", "coba2", "coba-coba",
    "kontol", "sialan", "bajingan", "pantek", "najis", "begadu", "tolol",
    "bangsat", "babi", "setan", "iblis", "goblok", "bodoh", "dungu",
    "fuck", "fucking", "motherfucker", "shit", "bitch", "cunt", "asshole",
    "bastard", "dick", "pussy", "damn", "hell", "crap", "wanker", "slut",
    "stupid", "idiot", "moron", "dumbass", "bloody", "bugger",
    "wkwk", "haha", "hehe", "lucu", "garing", "bosan", "capek", "lelah",
    "pusing", "bingung", "susah", "sulit", "males", "malas", "ngantuk",
    "lapar", "haus", "senang", "sedih", "marah", "kesal", "jengkel",
    "aaaa", "bbbb", "cccc", "dddd", "eeee", "asdfghjkl", "qwerty",
    "123", "1234", "12345", "111", "222", "333", "zzz", "xxx", "hhh", "mmm",
    "anjay keren banget", "archimedes", "kontrol gravitası", "tentu saja iya"
  ];

  if (alwaysIrrelevantPatterns.some(pattern => reasonText.includes(pattern))) {
    return true;
  }

  const physicsFormulas = [
    "f = m × a", "f=m×a", "f = m * a", "f=m*a", "f=ma",
    "t = 1/f", "t=1/f", "1/f",
    "q = m × l", "q=m×l", "q = m * l", "q=m*l",
    "i = v/r", "i=v/r", "v/r",
    "w = f × s", "w=f×s", "usaha = gaya × perpindahan"
  ];

  const containsPhysicsFormula = physicsFormulas.some(formula => 
    reasonText.includes(formula.toLowerCase())
  );

  if (containsPhysicsFormula) {
    return false;
  }

  const validPhysicsConcepts = [
    "karena tembok tidak bergerak", "tidak ada perpindahan", "perpindahan = 0",
    "aksi-reaksi", "dayung mendorong air", "air mendorong perahu",
    "hukum newton", "hukum iii newton", "hukum 3 newton"
  ];

  const containsValidConcept = validPhysicsConcepts.some(concept => 
    reasonText.includes(concept.toLowerCase())
  );

  if (containsValidConcept) {
    return false;
  }

  return false;
}

/***************************************************
 * SEMANTIC SIMILARITY KHUSUS FISIKA
 ***************************************************/
function semanticSimilarity_(studentReason, expectedReason) {
  const student = studentReason.toLowerCase().trim();
  const expected = expectedReason.toLowerCase().trim();

  console.log(`DEBUG SEMANTIC: student="${student}", expected="${expected}"`);

  const physicsFormulas = {
    newton: ["f = m × a", "f=m×a", "f = m * a", "f=m*a", "f=ma", "a = f/m", "a=f/m"],
    usaha: ["w = f × s", "w=f×s", "w = f * s", "w=f*s", "usaha = gaya × perpindahan"],
    energi: ["ek = ½ m v²", "ep = m g h", "e = ½ k x²"],
    getaran: ["t = 1/f", "t=1/f", "f = 1/t", "f=1/t"],
    listrik: ["i = v/r", "i=v/r", "v = i × r", "v=i×r"]
  };

  for (const [formulaType, formulas] of Object.entries(physicsFormulas)) {
    const studentHasFormula = formulas.some(formula => student.includes(formula));
    const expectedHasFormula = formulas.some(formula => expected.includes(formula));
    
    if (studentHasFormula && expectedHasFormula) {
      console.log(`DEBUG: Match found for ${formulaType} formula`);
      return true;
    }
  }

  if (student.includes("f = m × a") || student.includes("f=m×a") || student.includes("f=ma")) {
    if (expected.includes("newton") || expected.includes("f = m × a") || expected.includes("f=ma")) {
      console.log("DEBUG: Newton formula with calculation - MATCH");
      return true;
    }
  }

  const normalize = (text) => text.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const studentNorm = normalize(student);
  const expectedNorm = normalize(expected);

  const studentWords = new Set(studentNorm.split(' '));
  const expectedWords = new Set(expectedNorm.split(' '));
  let matches = 0;
  
  for (const word of studentWords) {
    if (expectedWords.has(word) && word.length > 2) {
      matches++;
    }
  }
  
  const similarity = matches / Math.max(studentWords.size, expectedWords.size);
  console.log(`DEBUG: Similarity score: ${similarity}`);
  
  return similarity > 0.3;
}

/***************************************************
 * SISTEM 4 KATEGORI - VERSI SEDERHANA
 ***************************************************/
function determineCorrectClassification_(isCorrectChoice, reason, expectedReason) {
  const hasSemanticSimilarity = semanticSimilarity_(reason, expectedReason);

  console.log(`=== DEBUG CLASSIFICATION ===`);
  console.log(`Alasan: "${reason}"`);
  console.log(`Expected: "${expectedReason}"`);
  console.log(`isCorrectChoice: ${isCorrectChoice}`);
  console.log(`hasSemanticSimilarity: ${hasSemanticSimilarity}`);

  // ATURAN 4 KATEGORI SEDERHANA
  if (isCorrectChoice && hasSemanticSimilarity) {
    console.log(`Classification: MEMAHAMI_KONSEP`);
    return "MEMAHAMI_KONSEP";
  } else if (isCorrectChoice && !hasSemanticSimilarity) {
    console.log(`Classification: MENEBAK_PEMAHAMAN_TIDAK_LENGKAP`);
    return "MENEBAK_PEMAHAMAN_TIDAK_LENGKAP";
  } else if (!isCorrectChoice && hasSemanticSimilarity) {
    console.log(`Classification: MISKONSEPSI`);
    return "MISKONSEPSI";
  } else {
    console.log(`Classification: TIDAK_PAHAM_KONSEP`);
    return "TIDAK_PAHAM_KONSEP";
  }
}

/***************************************************
 * GENERATE STATUS MESSAGE - 4 KATEGORI
 ***************************************************/
function generateStatusMessage_(classification) {
  switch (classification) {
    case "MEMAHAMI_KONSEP":
      return "Excellent! Jawaban dan alasan kamu sudah tepat.";
    case "MENEBAK_PEMAHAMAN_TIDAK_LENGKAP":
      return "Perlu Perbaikan - Jawaban benar tapi alasannya salah.";
    case "MISKONSEPSI":
      return "Miskonsepsi Terdeteksi - Jawaban salah tapi alasannya benar.";
    case "TIDAK_PAHAM_KONSEP":
      return "Tidak Paham Konsep - Jawaban dan alasan salah.";
    default:
      return "Perlu evaluasi lebih lanjut.";
  }
}

/***************************************************
 * GENERATE ANALYSIS - 4 KATEGORI
 ***************************************************/
function generateAnalysis_(classification, isCorrectChoice, reason, expectedReason) {
  switch (classification) {
    case "MEMAHAMI_KONSEP":
      return `Siswa telah memahami konsep "${expectedReason}" dengan baik. Alasan "${reason}" tepat dan sesuai dengan konsep fisika.`;
    
    case "MENEBAK_PEMAHAMAN_TIDAK_LENGKAP":
      return `Siswa memilih jawaban benar tetapi alasan "${reason}" salah. Konsep yang benar: "${expectedReason}".`;
    
    case "MISKONSEPSI":
      return `Siswa memiliki pemahaman yang keliru. Meskipun alasan "${reason}" tampak benar, jawaban yang dipilih salah. Konsep yang benar: "${expectedReason}".`;
    
    case "TIDAK_PAHAM_KONSEP":
      return `Siswa belum memahami konsep dasar. Jawaban dan alasan "${reason}" salah. Konsep yang benar: "${expectedReason}".`;
    
    default:
      return `Perlu memperdalam pemahaman konsep: "${expectedReason}".`;
  }
}

/***************************************************
 * GET MISCONCEPTION TAG - 4 KATEGORI
 ***************************************************/
function getMisconceptionTag_(expectedReason, classification) {
  const reason = expectedReason.toLowerCase();
  
  if (classification === "MEMAHAMI_KONSEP") {
    return "excellent";
  } else if (classification === "MENEBAK_PEMAHAMAN_TIDAK_LENGKAP") {
    return "guessing";
  } else if (classification === "MISKONSEPSI") {
    return "misconception";
  } else {
    return "no_understanding";
  }
}

/***************************************************
 * GENERATE CORRECTION STEPS - 4 KATEGORI
 ***************************************************/
function generateCorrectionSteps_(classification, expectedReason) {
  const steps = [];
  
  if (classification === "TIDAK_PAHAM_KONSEP") {
    steps.push("Pahami konsep dasar fisika yang relevan dengan soal");
    steps.push("Baca materi konsep dasar dari sumber yang terpercaya");
    steps.push("Minta bantuan guru untuk penjelasan lebih detail");
  }
  
  if (classification === "MISKONSEPSI") {
    steps.push(`Identifikasi kesalahan pemahaman: ${expectedReason}`);
    steps.push("Pelajari kembali konsep yang benar dengan contoh-contoh");
    steps.push("Latihan soal dengan variasi yang berbeda");
  }
  
  if (classification === "MENEBAK_PEMAHAMAN_TIDAK_LENGKAP") {
    steps.push("Perbaiki pemahaman konsep meskipun pilihan benar");
    steps.push(`Pelajari: ${expectedReason}`);
    steps.push("Jangan hanya menghafal jawaban, pahami alasannya");
  }
  
  if (classification === "MEMAHAMI_KONSEP") {
    steps.push("Pertahankan pemahaman konsep yang baik");
    steps.push("Terus latihan soal dengan variasi yang berbeda");
  }
  
  if (steps.length === 0) {
    steps.push("Perdalam pemahaman konsep fisika melalui latihan soal");
  }
  
  return steps;
}

/***************************************************
 * GENERATE HINT - 4 KATEGORI
 ***************************************************/
function generateHint_(classification) {
  switch (classification) {
    case "MEMAHAMI_KONSEP":
      return "Pertahankan pemahaman konsep fisika yang baik!";
    case "MENEBAK_PEMAHAMAN_TIDAK_LENGKAP":
      return "Perbaiki pemahaman konsep meskipun pilihan benar.";
    case "MISKONSEPSI":
      return "Pelajari kembali konsep dasar fisika yang relevan.";
    case "TIDAK_PAHAM_KONSEP":
      return "Fokus pada pemahaman konsep fisika dasar.";
    default:
      return "Perdalam pemahaman konsep fisika melalui latihan.";
  }
}

/***************************************************
 * ANALYZE REASON - SISTEM 4 KATEGORI
 ***************************************************/
function handleAnalyzeReasonGemini_(data) {
  const { questionText, options, correctIndex, selectedIndex, reason, expectedReason } = data || {};
  if (!questionText || !options || typeof selectedIndex !== "number" || typeof correctIndex !== "number" || !reason || !expectedReason) {
    return fail_("Data analisis tidak lengkap");
  }

  const isCorrectChoice = selectedIndex === correctIndex;
  
  console.log(`DEBUG: selectedIndex=${selectedIndex}, correctIndex=${correctIndex}, isCorrectChoice=${isCorrectChoice}`);
  console.log(`DEBUG: reason="${reason}", expectedReason="${expectedReason}"`);

  const classification = determineCorrectClassification_(isCorrectChoice, reason, expectedReason);
  const misconceptionTag = getMisconceptionTag_(expectedReason, classification);
  const statusMessage = generateStatusMessage_(classification);
  
  console.log(`DEBUG: Final Classification="${classification}"`);

  try {
    const prompt = [
      "ANDA ADALAH GURU FISIKA YANG KETAT. Tolak alasan yang tidak relevan dengan fisika.",
      "KRITERIA KETAT:",
      "- Alasan harus berhubungan dengan konsep fisika",
      "- Tolak alasan yang mengandung nama orang, kata sapaan, atau hal tidak relevan",
      "- Tolak alasan yang asal-asalan atau tidak bermakna",
      "",
      `SOAL: ${questionText}`,
      `PILIHAN SISWA: ${String.fromCharCode(65 + selectedIndex)}. ${options[selectedIndex]}`,
      `PILIHAN BENAR: ${String.fromCharCode(65 + correctIndex)}. ${options[correctIndex]}`,
      `ALASAN SISWA: "${reason}"`,
      `KONSEP YANG DIHARAPKAN: "${expectedReason}"`,
      `STATUS EVALUASI: ${classification}`,
      `STATUS MESSAGE: ${statusMessage}`,
      "",
      "TUGAS ANDA:",
      "1. Jika alasan tidak relevan dengan fisika, berikan analysis yang MENEGASKAN kesalahan konsep",
      "2. Berikan langkah koreksi yang spesifik",
      "3. Tekankan pentingnya memahami konsep fisika, bukan menebak",
      "",
      "KELUARKAN JSON:",
      "{",
      '  "analysis": "analysis disini",',
      '  "correction_steps": ["langkah1", "langkah2"],',
      '  "hint": "hint disini"',
      "}"
    ].join("\n");

    const provider = getProvider_();
    let out = callGroq_(prompt);

    return ok_({
      classification: classification,
      analysis: out.analysis || generateAnalysis_(classification, isCorrectChoice, reason, expectedReason),
      status_message: statusMessage,
      misconception_tag: misconceptionTag,
      evidence: reason,
      correction_steps: Array.isArray(out.correction_steps) ? out.correction_steps : generateCorrectionSteps_(classification, expectedReason),
      hint: out.hint || generateHint_(classification),
      confidence: 0.95,
      is_correct_choice: isCorrectChoice,
      correct_answer: `${String.fromCharCode(65 + correctIndex)}. ${options[correctIndex]}`
    });

  } catch (err) {
    console.error("ERROR_AI_ANALYSIS:", err && err.message);

    return ok_({
      classification: classification,
      analysis: generateAnalysis_(classification, isCorrectChoice, reason, expectedReason),
      status_message: statusMessage,
      misconception_tag: misconceptionTag,
      evidence: reason,
      correction_steps: generateCorrectionSteps_(classification, expectedReason),
      hint: generateHint_(classification),
      confidence: 0.9,
      is_correct_choice: isCorrectChoice,
      correct_answer: `${String.fromCharCode(65 + correctIndex)}. ${options[correctIndex]}`
    });
  }
}

/***************************************************
 * FUNGSI UNTUK MENJAGA APPS SCRIPT TETAP AKTIF
 ***************************************************/

// Fungsi yang akan dipanggil secara otomatis setiap 30 menit
function keepAlive() {
  console.log('Script tetap aktif: ' + new Date());
  
  // Lakukan operasi ringan
  const cache = CacheService.getScriptCache();
  cache.put('last_alive', new Date().toString(), 21600); // 6 jam
  
  // Tambahkan log ke sheet untuk monitoring
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let logSheet = ss.getSheetByName('Logs');
    if (!logSheet) {
      logSheet = ss.insertSheet('Logs');
      logSheet.appendRow(['Timestamp', 'Event']);
      logSheet.getRange(1, 1, 1, 2).setBackground("#eef2ff").setFontWeight("bold");
    }
    
    logSheet.appendRow([new Date(), 'KeepAlive Trigger']);
    
    // Hapus log lama (lebih dari 100 baris)
    if (logSheet.getLastRow() > 100) {
      logSheet.deleteRow(2);
    }
  } catch(e) {
    // Biarkan error, tidak penting
  }
}

// Setup trigger - JALANKAN SEKALI SAJA
function setupTrigger() {
  // Hapus trigger lama
  deleteTriggers();
  
  // Buat trigger baru setiap 30 menit
  ScriptApp.newTrigger('keepAlive')
    .timeBased()
    .everyMinutes(30)    // Lebih sering dari 1 jam
    .create();
  
  console.log('Trigger keepAlive berhasil dibuat');
  
  // Langsung jalankan sekali
  keepAlive();
}

// Hapus trigger
function deleteTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === 'keepAlive') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}