/* ============================================================
   RECITE — Memorization App
   Vanilla JS SPA with hash-based routing
   GitHub Pages / IndexedDB edition — no server required
   ============================================================ */

// ============================================================
// INDEXEDDB STORAGE LAYER
// Replaces the CGI-bin API with a fully client-side store.
// Public interface:  api(method, action, data)  — drop-in replacement.
// ============================================================

const DB_NAME = 'ReciteDB';
const DB_VERSION = 1;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      // texts store
      if (!db.objectStoreNames.contains('texts')) {
        db.createObjectStore('texts', { keyPath: 'id', autoIncrement: true });
      }
      // sessions store (one record per calendar day, value = date string)
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'date' });
      }
    };

    req.onsuccess = (e) => {
      _db = e.target.result;
      resolve(_db);
    };

    req.onerror = (e) => {
      reject(e.target.error);
    };
  });
}

// Promise-based wrappers around IDBObjectStore operations
function dbGetAll(storeName) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function dbGet(storeName, key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function dbPut(storeName, value) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(value);
    req.onsuccess = () => resolve(req.result); // returns the key
    req.onerror = () => reject(req.error);
  }));
}

function dbAdd(storeName, value) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).add(value);
    req.onsuccess = () => resolve(req.result); // returns the new auto-increment key
    req.onerror = () => reject(req.error);
  }));
}

function dbDelete(storeName, key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  }));
}

// ---- helpers ----

function todayStr() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

function computeMasteryLevel(line) {
  if (line.repetitions >= 3 && line.interval >= 21) return 'mastered';
  if (line.repetitions >= 1) return 'learning';
  return 'new';
}

function initLine(text, index) {
  const today = todayStr();
  return {
    id: `${text.id}_${index}`,
    text: text.text || '',
    translation: text.translation || '',
    interval: 0,
    repetitions: 0,
    easeFactor: 2.5,
    dueDate: today,
    masteryLevel: 'new'
  };
}

function annotateText(t) {
  const lines = t.lines || [];
  const total = lines.length;
  const mastered = lines.filter(l => l.masteryLevel === 'mastered').length;
  return {
    ...t,
    lineCount: total,
    masteryPercent: total > 0 ? Math.round((mastered / total) * 100) : 0
  };
}

// ---- streak calculation ----

async function computeStreak() {
  const sessions = await dbGetAll('sessions');
  if (sessions.length === 0) return 0;

  const dates = sessions.map(s => s.date).sort().reverse(); // newest first
  const today = todayStr();

  // Streak only counts if practiced today or yesterday
  if (dates[0] !== today) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().split('T')[0];
    if (dates[0] !== yStr) return 0;
  }

  let streak = 1;
  let prev = dates[0];
  for (let i = 1; i < dates.length; i++) {
    const d = new Date(prev);
    d.setDate(d.getDate() - 1);
    const expected = d.toISOString().split('T')[0];
    if (dates[i] === expected) {
      streak++;
      prev = dates[i];
    } else {
      break;
    }
  }
  return streak;
}

// ============================================================
// API — drop-in replacement for the CGI-bin version
// Same signature: api(method, action, data)
// ============================================================

async function api(method, action, data = null) {
  try {
    // Parse action string — may contain query params like 'getText&id=3'
    const [baseAction, ...qParts] = action.split('&');
    const params = {};
    qParts.forEach(p => {
      const [k, v] = p.split('=');
      if (k) params[k] = v;
    });
    const id = params.id !== undefined ? (isNaN(params.id) ? params.id : Number(params.id)) : undefined;

    // ---- GET actions ----

    if (baseAction === 'getTexts') {
      const texts = await dbGetAll('texts');
      return texts.map(annotateText);
    }

    if (baseAction === 'getText') {
      const textId = id !== undefined ? id : (data && data.id !== undefined ? Number(data.id) : undefined);
      if (textId === undefined) throw new Error('getText: missing id');
      const text = await dbGet('texts', textId);
      if (!text) throw new Error('Text not found');
      return annotateText(text);
    }

    if (baseAction === 'getDueLines') {
      const today = todayStr();
      const texts = await dbGetAll('texts');
      const dueLines = [];
      texts.forEach(t => {
        (t.lines || []).forEach(line => {
          if (!line.dueDate || line.dueDate <= today) {
            dueLines.push({
              ...line,
              textId: t.id,
              textTitle: t.title
            });
          }
        });
      });
      return { count: dueLines.length, lines: dueLines };
    }

    if (baseAction === 'getStats') {
      const texts = await dbGetAll('texts');
      let totalLines = 0, mastered = 0, learning = 0, newCount = 0;
      const textBreakdown = [];

      texts.forEach(t => {
        const lines = t.lines || [];
        let tMastered = 0;
        lines.forEach(l => {
          totalLines++;
          const ml = l.masteryLevel || computeMasteryLevel(l);
          if (ml === 'mastered') { mastered++; tMastered++; }
          else if (ml === 'learning') learning++;
          else newCount++;
        });
        if (lines.length > 0) {
          textBreakdown.push({
            title: t.title,
            percent: Math.round((tMastered / lines.length) * 100)
          });
        }
      });

      const streak = await computeStreak();

      return {
        totalTexts: texts.length,
        totalLines,
        mastered,
        learning,
        new: newCount,
        streak,
        textBreakdown
      };
    }

    // ---- POST actions ----

    if (baseAction === 'addText') {
      const { title, category, lines: rawLines } = data;
      const today = todayStr();

      // We need to add the record first to get the auto-increment id,
      // then update lines with proper ids.
      const placeholder = {
        title,
        category,
        dateAdded: today,
        lines: [] // will be filled after we have the id
      };

      const newId = await dbAdd('texts', placeholder);

      // Now build lines with proper ids
      const lines = (rawLines || []).map((l, index) => {
        return {
          id: `${newId}_${index}`,
          text: l.text || '',
          pronunciation: l.pronunciation || '',
          translation: l.translation || '',
          interval: 0,
          repetitions: 0,
          easeFactor: 2.5,
          dueDate: today,
          masteryLevel: 'new'
        };
      });

      const fullRecord = { id: newId, title, category, dateAdded: today, lines };
      await dbPut('texts', fullRecord);
      return annotateText(fullRecord);
    }

    if (baseAction === 'updateText') {
      const existing = await dbGet('texts', Number(data.id));
      if (!existing) throw new Error('Text not found');
      const updated = { ...existing, ...data, id: existing.id };
      await dbPut('texts', updated);
      return annotateText(updated);
    }

    if (baseAction === 'recordPractice') {
      const today = todayStr();
      await dbPut('sessions', { date: today });
      return { ok: true };
    }

    // ---- PUT actions ----

    if (baseAction === 'updateLine') {
      // data: { id: 'textId_lineIndex', interval, repetitions, easeFactor, dueDate, translation? }
      const lineId = data.id;
      if (!lineId) throw new Error('updateLine: missing line id');

      // Line id format: '<textId>_<lineIndex>'
      // textId may itself contain underscores? No — it's an auto-increment integer.
      // So the textId is everything before the LAST underscore.
      const lastUnderscore = String(lineId).lastIndexOf('_');
      const textId = Number(String(lineId).substring(0, lastUnderscore));
      const lineIndex = Number(String(lineId).substring(lastUnderscore + 1));

      const text = await dbGet('texts', textId);
      if (!text) throw new Error(`updateLine: text ${textId} not found`);

      const lines = text.lines || [];
      if (lineIndex < 0 || lineIndex >= lines.length) throw new Error('updateLine: invalid line index');

      const oldLine = lines[lineIndex];
      const updatedLine = { ...oldLine };

      // Apply only the fields present in data (except 'id')
      const { id: _discardId, ...fields } = data;
      Object.assign(updatedLine, fields);

      // Recompute masteryLevel based on updated SM2 values
      updatedLine.masteryLevel = computeMasteryLevel(updatedLine);

      lines[lineIndex] = updatedLine;
      await dbPut('texts', { ...text, lines });
      return { ok: true, line: updatedLine };
    }

    // ---- DELETE actions ----

    if (baseAction === 'deleteText') {
      const textId = id !== undefined ? id : Number(data && data.id);
      await dbDelete('texts', textId);
      return { ok: true };
    }

    throw new Error(`Unknown action: ${baseAction}`);

  } catch (e) {
    console.error('[API Error]', action, e);
    throw e;
  }
}

// ============================================================
// SM-2 ALGORITHM
// ============================================================

function sm2(quality, repetitions, interval, easeFactor) {
  if (quality >= 3) {
    if (repetitions === 0) interval = 1;
    else if (repetitions === 1) interval = 6;
    else interval = Math.round(interval * easeFactor);
    repetitions += 1;
  } else {
    repetitions = 0;
    interval = 1;
  }
  easeFactor = Math.max(1.3, easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + interval);
  return {
    interval,
    repetitions,
    easeFactor: Math.round(easeFactor * 1000) / 1000,
    dueDate: dueDate.toISOString().split('T')[0]
  };
}

async function updateLinesSM2(lines, quality) {
  const promises = lines.map(line => {
    const result = sm2(quality, line.repetitions || 0, line.interval || 0, line.easeFactor || 2.5);
    return api('PUT', 'updateLine', {
      id: line.id,
      interval: result.interval,
      repetitions: result.repetitions,
      easeFactor: result.easeFactor,
      dueDate: result.dueDate
    });
  });
  await Promise.all(promises).catch(e => console.error('SM2 update error', e));
}

// ============================================================
// UTILITIES
// ============================================================

function $(sel, ctx = document) { return ctx.querySelector(sel); }
function $$(sel, ctx = document) { return [...ctx.querySelectorAll(sel)]; }

function showToast(msg, type = '', duration = 2800) {
  const container = $('#toast-container');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toastOut 0.3s ease-in both';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

function loading() {
  return `<div class="loading-pulse">
    <div class="loading-dot"></div>
    <div class="loading-dot"></div>
    <div class="loading-dot"></div>
  </div>`;
}

// ============================================================
// ROUTER
// ============================================================

let currentHash = '';

function navigate(hash) {
  window.location.hash = hash;
}

function getHash() {
  return window.location.hash || '#home';
}

async function router() {
  const hash = getHash();
  if (hash === currentHash) return;
  currentHash = hash;

  const parts = hash.replace('#', '').split('/');
  const view = parts[0];

  // Update nav active state
  $$('.nav-btn').forEach(btn => btn.classList.remove('active'));
  if (view === 'home' || view === '') {
    $('[data-hash="#home"]')?.classList.add('active');
  } else if (view === 'guide') {
    $('[data-hash="#guide"]')?.classList.add('active');
  }

  // Show/hide bottom nav
  const hideNav = ['practice', 'complete'].includes(view);
  $('#bottom-nav').style.display = hideNav ? 'none' : '';

  // Show FAB only on home screen
  const fabBtn = $('#fab-btn');
  if (fabBtn) fabBtn.style.display = (view === 'home' || view === '') ? '' : 'none';

  switch (view) {
    case '':
    case 'home':
      await renderHome();
      break;
    case 'add':
      renderAdd();
      break;
    case 'text':
      await renderTextDetail(parts[1]);
      break;
    case 'practice':
      await renderPractice(parts[1], parts[2]);
      break;
    case 'progress':
      await renderProgress();
      break;
    case 'daily':
      await renderDaily();
      break;
    case 'guide':
      renderGuide();
      break;
    case 'complete':
      renderComplete(parts[1]);
      break;
    default:
      await renderHome();
  }
}

function setScreen(html) {
  const container = $('#screen-container');
  container.innerHTML = `<div class="screen">${html}</div>`;
}

// ============================================================
// PRE-LOAD: Seven-Line Prayer
// ============================================================

async function maybePreloadSevenLinePrayer() {
  try {
    const texts = await api('GET', 'getTexts');
    if (texts.length > 0) return; // Already has data

    const lines = [
      { text: "HUNG", pronunciation: "Er Hoong", translation: "" },
      { text: "Ogyen yulgyi nupchang tsam", pronunciation: "Uh-gen yool-gyi noob-chang tsam", translation: "In the north-west of the country of Uddiyana," },
      { text: "Pema kesar dongpo la", pronunciation: "Pay-ma kay-sar dong-po la", translation: "In the heart of a lotus flower," },
      { text: "Yamtsen chokgi ngodrup nye", pronunciation: "Yam-tsen chok-gi ngeu-drup nyeh", translation: "You are endowed with the supreme, wondrous siddhis," },
      { text: "Pema jungne shyesu drak", pronunciation: "Pay-ma Jung-neh shyeh-soo drak", translation: "And are renowned as the Lotus Born." },
      { text: "Khordu khandro mangpo kor", pronunciation: "Khor-doo khan-dro mang-peu kor", translation: "Surrounded by a host of many dakinis" },
      { text: "Chyechyi jesu dagdrup kyi", pronunciation: "Chyeh-chyi jeh-soo dak-drup kyee", translation: "I will practice by following your example." },
      { text: "Chingyi lapchir sheksu sol", pronunciation: "Ching-yee lap-cheer shek-soo sol", translation: "Please approach and grant your blessings!" },
      { text: "GURU PEMA SIDDHI HUNG", pronunciation: "Guru Pay-ma Siddhi Hoong", translation: "" },
      { text: "OM AH HUNG BENZAR GURU PEMA SIDDHI HUNG", pronunciation: "Om Ah Hoong Ben-zar Guru Pay-ma Sidd-hi Hoong", translation: "May the blessings of the Lotus-Born Guru bring spiritual accomplishment." },
      { text: "OM AH HUNG BENZAR GURU PEMA THOTRENG TSAL", pronunciation: "Om Ah Hoong Ben-zar Guru Pay-ma Tho-treng Tsal", translation: "Melody of Thotreng Tsal" },
      { text: "BENZAR SAMAYA DZA SIDDHI PHALA HUNG AH", pronunciation: "Ben-zar Sa-ma-ya Dza Sidd-hi Pa-la Hoong Ah", translation: "" }
    ];

    await api('POST', 'addText', {
      title: "Seven-Line Prayer & Vajra Guru Mantra",
      category: "Prayer",
      lines
    });
  } catch (e) {
    console.warn('Pre-load failed:', e);
  }
}

// ============================================================
// HOME SCREEN
// ============================================================

async function renderHome() {
  setScreen(loading());

  try {
    const [texts, dueData] = await Promise.all([
      api('GET', 'getTexts'),
      api('GET', 'getDueLines')
    ]);

    // Update due badge
    const dueCount = dueData.count || 0;
    const badge = $('#due-badge');
    if (dueCount > 0) {
      badge.textContent = dueCount;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    let content = `
      <div class="home-header">
        <span class="home-logo">Recite</span>
        <button class="home-progress-btn" onclick="navigate('#progress')" aria-label="Progress">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
          </svg>
        </button>
      </div>
      <div class="gold-divider"></div>
    `;

    if (dueCount > 0) {
      content += `
        <button class="daily-practice-btn" onclick="navigate('#daily')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"/>
          </svg>
          Daily Practice
          <span class="daily-count-pill">${dueCount} due</span>
        </button>
      `;
    }

    if (texts.length === 0) {
      content += `
        <div class="empty-state">
          <div class="empty-state-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
            </svg>
          </div>
          <p class="empty-state-title">Begin your journey.</p>
          <p class="empty-state-sub">Add your first text to memorize.</p>
        </div>
      `;
    } else {
      content += `<div class="section-label">Your Texts</div>`;
      content += `<div class="texts-list">`;
      texts.forEach(t => {
        const pct = t.masteryPercent || 0;
        const r = 22;
        const circ = 2 * Math.PI * r;
        const offset = circ - (pct / 100) * circ;
        content += `
          <div class="text-card" onclick="navigate('#text/${t.id}')">
            <div class="text-card-ring">
              <svg viewBox="0 0 52 52">
                <circle class="ring-bg" cx="26" cy="26" r="${r}"/>
                <circle class="ring-fill" cx="26" cy="26" r="${r}"
                  stroke-dasharray="${circ}"
                  stroke-dashoffset="${offset}"
                  data-offset="${offset}"
                  data-circ="${circ}"/>
              </svg>
              <div class="ring-percent">${pct}%</div>
            </div>
            <div class="text-card-info">
              <div class="text-card-title">${escHtml(t.title)}</div>
              <div class="text-card-meta">
                <span class="category-tag">${escHtml(t.category)}</span>
                <span class="line-count">${t.lineCount} line${t.lineCount !== 1 ? 's' : ''}</span>
              </div>
            </div>
            <div class="text-card-arrow">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </div>
          </div>
        `;
      });
      content += `</div>`;
    }

    setScreen(content);

    // Animate rings after render
    requestAnimationFrame(() => {
      $$('.ring-fill').forEach(ring => {
        const target = parseFloat(ring.dataset.offset);
        const circ = parseFloat(ring.dataset.circ);
        ring.style.strokeDashoffset = circ; // start from full
        requestAnimationFrame(() => {
          ring.style.strokeDashoffset = target;
        });
      });
    });

  } catch (e) {
    setScreen(`<div class="no-results">Could not load texts. ${e.message}</div>`);
  }
}

// ============================================================
// ADD TEXT SCREEN
// ============================================================

function renderAdd() {
  const categories = ['Prayer', 'Speech', 'Song', 'Poem', 'Script', 'Other'];
  let selectedCategory = 'Other';

  const html = `
    <div class="add-screen">
      <div class="screen-header">
        <button class="back-btn" onclick="history.back()">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <span class="screen-title">New Text</span>
      </div>

      <div class="add-form">
        <div class="form-field">
          <label class="form-label">Title</label>
          <input id="add-title" class="title-input" type="text" placeholder="Give your text a name…" autocomplete="off" />
        </div>

        <div class="form-field">
          <label class="form-label">Category</label>
          <div class="category-pills" id="category-pills">
            ${categories.map(c => `
              <button class="category-pill${c === selectedCategory ? ' active' : ''}"
                onclick="selectCategory('${c}')" data-cat="${c}">${c}</button>
            `).join('')}
          </div>
        </div>

        <div class="form-field">
          <label class="form-label">Text</label>
          <textarea id="add-text" class="text-textarea"
            placeholder="Paste or type your text here…&#10;Each line will become a memorizable unit."
            oninput="updatePreview()"></textarea>
        </div>

        <div class="form-field preview-section" id="preview-section" style="display:none">
          <label class="form-label">Preview</label>
          <div class="preview-lines" id="preview-lines"></div>
        </div>

        <div class="pronunciation-section" id="pronunciation-section" style="display:none">
          <button class="pronunciation-toggle" onclick="togglePronunciationSection()" id="pron-toggle">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" id="pron-toggle-icon">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
            Add Pronunciations (optional)
          </button>
          <div class="pronunciation-inputs" id="pronunciation-inputs" style="display:none"></div>
        </div>

        <button class="save-btn" id="save-btn" onclick="saveText()" disabled>Save Text</button>
      </div>
    </div>
  `;

  setScreen(html);

  // Expose selectCategory globally for this screen
  window.selectCategory = (cat) => {
    selectedCategory = cat;
    $$('#category-pills .category-pill').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.cat === cat);
    });
  };

  window.togglePronunciationSection = () => {
    const inputs = $('#pronunciation-inputs');
    const icon = $('#pron-toggle-icon');
    if (!inputs) return;
    const isOpen = inputs.style.display !== 'none';
    inputs.style.display = isOpen ? 'none' : '';
    if (icon) {
      icon.style.transform = isOpen ? '' : 'rotate(90deg)';
    }
  };

  window.updatePreview = () => {
    const text = $('#add-text')?.value || '';
    const lines = text.split('\n').filter(l => l.trim());
    const previewSection = $('#preview-section');
    const previewLines = $('#preview-lines');
    const saveBtn = $('#save-btn');
    const pronSection = $('#pronunciation-section');
    const pronInputs = $('#pronunciation-inputs');

    if (!previewSection || !previewLines) return;

    if (lines.length > 0) {
      previewSection.style.display = '';
      previewLines.innerHTML = lines.slice(0, 20).map((l, i) => `
        <div class="preview-line">
          <span class="preview-num">${i + 1}</span>
          <span class="preview-text">${escHtml(l)}</span>
        </div>
      `).join('') + (lines.length > 20 ? `<div class="preview-line"><span class="preview-num">…</span><span class="preview-text">${lines.length - 20} more lines</span></div>` : '');

      // Update pronunciation section
      if (pronSection) pronSection.style.display = '';
      if (pronInputs) {
        // Preserve existing values
        const existing = {};
        $$('.pron-line-input', pronInputs).forEach(inp => {
          existing[inp.dataset.idx] = inp.value;
        });
        pronInputs.innerHTML = lines.slice(0, 20).map((l, i) => `
          <div class="pronunciation-input-row">
            <span class="preview-num">${i + 1}</span>
            <input class="pron-line-input" type="text" data-idx="${i}"
              placeholder="${escHtml(l.substring(0, 30))}…"
              value="${escHtml(existing[i] || '')}"
              autocomplete="off" />
          </div>
        `).join('');
      }
    } else {
      previewSection.style.display = 'none';
      if (pronSection) pronSection.style.display = 'none';
    }

    if (saveBtn) saveBtn.disabled = !($('#add-title')?.value.trim()) || lines.length === 0;
  };

  // Also update preview when title changes
  $('#add-title')?.addEventListener('input', window.updatePreview);

  window.saveText = async () => {
    const title = $('#add-title')?.value.trim();
    const textVal = $('#add-text')?.value || '';
    const rawLines = textVal.split('\n').filter(l => l.trim());

    // Gather pronunciations
    const pronValues = {};
    $$('.pron-line-input').forEach(inp => {
      pronValues[parseInt(inp.dataset.idx)] = inp.value.trim();
    });

    const lines = rawLines.map((l, i) => ({
      text: l.trim(),
      translation: '',
      pronunciation: pronValues[i] || ''
    }));

    if (!title || lines.length === 0) {
      showToast('Please add a title and text', 'error');
      return;
    }

    const saveBtn = $('#save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    try {
      const result = await api('POST', 'addText', { title, category: selectedCategory, lines });
      showToast('Text saved', 'success');
      navigate('#text/' + result.id);
    } catch (e) {
      showToast('Save failed: ' + e.message, 'error');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Text'; }
    }
  };
}

// ============================================================
// TEXT DETAIL SCREEN
// ============================================================

async function renderTextDetail(id) {
  setScreen(loading());

  try {
    const text = await api('GET', `getText&id=${id}`);

    const masteryColors = { new: '#c0392b', learning: '#f39c12', mastered: '#27ae60' };

    let linesHtml = '';
    text.lines.forEach((line, idx) => {
      const ml = line.masteryLevel || 'new';
      linesHtml += `
        <div class="line-item" id="line-item-${line.id}">
          <span class="line-num">${idx + 1}</span>
          <div class="line-content">
            <div class="line-text">${escHtml(line.text)}</div>
            ${line.pronunciation ? `<div class="line-pronunciation">${escHtml(line.pronunciation)}</div>` : ''}
            ${line.translation ? `<div class="line-translation">${escHtml(line.translation)}</div>` : ''}
            <div class="line-actions-row">
              <div id="pronunciation-area-${line.id}">
                ${!line.pronunciation
                  ? `<span class="add-translation-link" onclick="showPronunciationInput('${line.id}')">+ add pronunciation</span>`
                  : `<span class="add-translation-link" onclick="showPronunciationInput('${line.id}')">edit pronunciation</span>`}
              </div>
              <div id="translation-area-${line.id}">
                ${!line.translation
                  ? `<span class="add-translation-link" onclick="showTranslationInput('${line.id}')">+ add translation</span>`
                  : `<span class="add-translation-link" onclick="showTranslationInput('${line.id}')">edit translation</span>`}
              </div>
            </div>
          </div>
          <div class="mastery-dot ${ml}" title="${ml}"></div>
        </div>
      `;
    });

    const modes = [
      { id: 1, icon: '👁', label: 'Hide' },
      { id: 2, icon: '✎', label: 'Fill' },
      { id: 3, icon: 'Aa', label: '1st Letter' },
      { id: 4, icon: '💭', label: 'Meaning' },
      { id: 5, icon: '◎', label: 'Recite' },
      { id: 6, icon: '🗣', label: 'Pronounce' }
    ];

    let selectedMode = 1;

    const html = `
      <div class="detail-header">
        <div style="display:flex;align-items:center;gap:12px;">
          <button class="back-btn" onclick="history.back()">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
        </div>
        <div class="detail-title">${escHtml(text.title)}</div>
        <div class="detail-meta">
          <span class="category-tag">${escHtml(text.category)}</span>
          <span class="line-count">${text.lines.length} lines</span>
        </div>
      </div>

      <div class="mastery-legend">
        <div class="legend-item"><div class="mastery-dot new"></div>New</div>
        <div class="legend-item"><div class="mastery-dot learning"></div>Learning</div>
        <div class="legend-item"><div class="mastery-dot mastered"></div>Mastered</div>
      </div>

      <div class="gold-divider"></div>

      <div class="lines-container">
        ${linesHtml}
      </div>

      <div class="practice-modes-wrap">
        <div class="practice-modes-label">Practice Mode</div>
        <div class="practice-modes-row" id="mode-btns">
          ${modes.map(m => `
            <button class="mode-btn ${m.id === 1 ? 'active' : ''}"
              onclick="selectMode(${m.id})"
              data-mode="${m.id}"
              title="Mode ${m.id}: ${m.label}">
              <span>${m.icon}</span>
              <span>${m.label}</span>
            </button>
          `).join('')}
        </div>
      </div>

      <button class="begin-practice-btn" id="begin-practice-btn"
        onclick="beginPractice('${text.id}', window._selectedMode || 1)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none"/>
        </svg>
        Begin Practice
      </button>

      <button class="delete-text-btn" onclick="deleteText('${text.id}', '${escHtml(text.title).replace(/'/g, "\\'")}')">\n        Delete Text
      </button>
      <div style="height: 24px"></div>
    `;

    setScreen(html);

    window._selectedMode = 1;

    window.selectMode = (modeId) => {
      window._selectedMode = modeId;
      $$('#mode-btns .mode-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.mode) === modeId);
      });
      // Update button handler
      $('#begin-practice-btn').onclick = () => beginPractice(text.id, modeId);
    };

    // ---- Pronunciation input ----
    window.showPronunciationInput = (lineId) => {
      const area = $(`#pronunciation-area-${lineId}`);
      if (!area) return;
      const line = text.lines.find(l => l.id === lineId);
      area.innerHTML = `
        <div class="translation-input-wrap">
          <input class="pronunciation-edit-input" type="text" placeholder="Phonetic pronunciation…"
            value="${escHtml(line?.pronunciation || '')}"
            id="pron-input-${lineId}" />
          <button class="translation-save-btn" onclick="savePronunciation('${lineId}')">Save</button>
        </div>
      `;
      $(`#pron-input-${lineId}`)?.focus();
    };

    window.savePronunciation = async (lineId) => {
      const val = $(`#pron-input-${lineId}`)?.value || '';
      try {
        await api('PUT', 'updateLine', { id: lineId, pronunciation: val });
        const line = text.lines.find(l => l.id === lineId);
        if (line) line.pronunciation = val;
        const area = $(`#pronunciation-area-${lineId}`);
        const lineItem = $(`#line-item-${lineId}`);
        if (lineItem) {
          const existing = lineItem.querySelector('.line-pronunciation');
          if (existing) {
            if (val) existing.textContent = val;
            else existing.remove();
          } else if (val) {
            const lineText = lineItem.querySelector('.line-text');
            const pronEl = document.createElement('div');
            pronEl.className = 'line-pronunciation';
            pronEl.textContent = val;
            lineText.insertAdjacentElement('afterend', pronEl);
          }
        }
        if (area) area.innerHTML = val
          ? `<span class="add-translation-link" onclick="showPronunciationInput('${lineId}')">edit pronunciation</span>`
          : `<span class="add-translation-link" onclick="showPronunciationInput('${lineId}')">+ add pronunciation</span>`;
        showToast('Pronunciation saved', 'success');
      } catch (e) {
        showToast('Failed to save', 'error');
      }
    };

    // ---- Translation input ----
    window.showTranslationInput = (lineId) => {
      const area = $(`#translation-area-${lineId}`);
      if (!area) return;
      const line = text.lines.find(l => l.id === lineId);
      area.innerHTML = `
        <div class="translation-input-wrap">
          <input class="translation-input" type="text" placeholder="Translation or meaning…"
            value="${escHtml(line?.translation || '')}"
            id="trans-input-${lineId}" />
          <button class="translation-save-btn" onclick="saveTranslation('${lineId}')">Save</button>
        </div>
      `;
      $(`#trans-input-${lineId}`)?.focus();
    };

    window.saveTranslation = async (lineId) => {
      const val = $(`#trans-input-${lineId}`)?.value || '';
      try {
        await api('PUT', 'updateLine', { id: lineId, translation: val });
        const line = text.lines.find(l => l.id === lineId);
        if (line) line.translation = val;
        const area = $(`#translation-area-${lineId}`);
        const lineItem = $(`#line-item-${lineId}`);
        if (lineItem) {
          const existingTrans = lineItem.querySelector('.line-translation');
          if (existingTrans) {
            if (val) existingTrans.textContent = val;
            else existingTrans.remove();
          } else if (val) {
            // Insert after pronunciation or line-text
            const pronEl = lineItem.querySelector('.line-pronunciation');
            const lineText = lineItem.querySelector('.line-text');
            const tranEl = document.createElement('div');
            tranEl.className = 'line-translation';
            tranEl.textContent = val;
            (pronEl || lineText).insertAdjacentElement('afterend', tranEl);
          }
        }
        if (area) area.innerHTML = val
          ? `<span class="add-translation-link" onclick="showTranslationInput('${lineId}')">edit translation</span>`
          : `<span class="add-translation-link" onclick="showTranslationInput('${lineId}')">+ add translation</span>`;
        showToast('Translation saved', 'success');
      } catch (e) {
        showToast('Failed to save', 'error');
      }
    };

    window.beginPractice = (textId, modeId) => {
      navigate(`#practice/${textId}/${modeId}`);
    };

    window.deleteText = async (textId, title) => {
      if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
      try {
        await api('DELETE', 'deleteText', { id: textId });
        showToast('Text deleted');
        navigate('#home');
      } catch (e) {
        showToast('Delete failed', 'error');
      }
    };

  } catch (e) {
    setScreen(`<div class="no-results">Could not load text. ${e.message}</div>`);
  }
}

// ============================================================
// PRACTICE SCREEN — router
// ============================================================

async function renderPractice(textId, modeStr) {
  const mode = parseInt(modeStr) || 1;
  setScreen(loading());

  try {
    const text = await api('GET', `getText&id=${textId}`);

    switch (mode) {
      case 1: renderMode1(text); break;
      case 2: renderMode2(text); break;
      case 3: renderMode3(text); break;
      case 4: renderMode4(text); break;
      case 5: renderMode5(text); break;
      case 6: renderMode6(text); break;
      default: renderMode1(text);
    }
  } catch (e) {
    setScreen(`<div class="no-results">Could not load practice. ${e.message}</div>`);
  }
}

function practiceHeader(text, modeName) {
  return `
    <div class="practice-header">
      <button class="back-btn" onclick="navigate('#text/${text.id}')">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
      </button>
      <div class="practice-title">${escHtml(text.title)}</div>
      <div class="practice-mode-label">${modeName}</div>
    </div>
  `;
}

// ============================================================
// MODE 1 — PROGRESSIVE HIDING
// ============================================================

function renderMode1(text) {
  const fullText = text.lines.map(l => l.text).join('\n');
  let words = [];
  let hiddenIndices = new Set();

  // Build word list from the full text preserving line breaks
  const htmlWords = text.lines.map((line, li) => {
    const lineWords = line.text.split(/(\s+)/);
    return lineWords.map((part, pi) => {
      if (/^\s+$/.test(part)) return part; // whitespace
      const idx = words.length;
      words.push(part);
      return `<span class="mode1-word" data-idx="${idx}">${escHtml(part)}</span>`;
    }).join('') + (li < text.lines.length - 1 ? '<br>' : '');
  }).join('');

  const html = `
    ${practiceHeader(text, 'Progressive')}
    <div class="practice-screen">
      <div class="mode1-content">
        <div class="mode1-text-area" id="mode1-text">${htmlWords}</div>
        <p class="mode1-hint">Hold anywhere to reveal all hidden words</p>
        <div class="mode1-controls">
          <button class="mode1-hide-btn" onclick="mode1HideMore()">Hide More</button>
          <button class="mode1-reset-btn" onclick="mode1Reset()">Reset</button>
        </div>
      </div>
    </div>
  `;
  setScreen(html);

  window.mode1HideMore = () => {
    const visibleIdxs = words.map((_, i) => i).filter(i => !hiddenIndices.has(i) && words[i].trim() !== '');
    if (visibleIdxs.length === 0) { showToast('All words hidden!'); return; }
    const count = Math.min(3, Math.ceil(visibleIdxs.length * 0.12));
    const toHide = shuffleArray(visibleIdxs).slice(0, count);
    toHide.forEach(idx => {
      hiddenIndices.add(idx);
      const span = $(`[data-idx="${idx}"]`);
      if (span) {
        span.textContent = '___';
        span.classList.add('hidden-word');
      }
    });
    if (hiddenIndices.size === words.filter(w => w.trim()).length) {
      showToast('All words hidden! Hold to peek.');
    }
  };

  window.mode1Reset = () => {
    hiddenIndices.clear();
    $$('.mode1-word').forEach(span => {
      const idx = parseInt(span.dataset.idx);
      span.textContent = escHtml(words[idx]);
      span.classList.remove('hidden-word');
    });
  };

  // Long press / hold to reveal
  let revealTimer = null;
  const textArea = $('#mode1-text');

  const startReveal = () => {
    revealTimer = setTimeout(() => {
      $$('.mode1-word.hidden-word').forEach(span => {
        const idx = parseInt(span.dataset.idx);
        span.style.opacity = '0.4';
        span.textContent = escHtml(words[idx]);
      });
    }, 300);
  };

  const endReveal = () => {
    if (revealTimer) clearTimeout(revealTimer);
    $$('.mode1-word.hidden-word').forEach(span => {
      const idx = parseInt(span.dataset.idx);
      span.style.opacity = '';
      span.textContent = '___';
    });
  };

  if (textArea) {
    textArea.addEventListener('touchstart', startReveal, { passive: true });
    textArea.addEventListener('touchend', endReveal, { passive: true });
    textArea.addEventListener('mousedown', startReveal);
    textArea.addEventListener('mouseup', endReveal);
    textArea.addEventListener('mouseleave', endReveal);
  }

  // Record practice
  api('POST', 'recordPractice', { textId: text.id, linesPracticed: text.lines.length }).catch(() => {});
}

// ============================================================
// MODE 2 — FILL IN THE BLANK
// ============================================================

function renderMode2(text) {
  const lines = text.lines.filter(l => l.text.trim());
  if (lines.length === 0) {
    setScreen('<div class="no-results">No lines to practice.</div>');
    return;
  }

  let currentLineIdx = 0;
  let blankWord = '';
  let blankPos = 0;
  let answeredLines = [];

  function renderCurrentLine() {
    if (currentLineIdx >= lines.length) {
      finishMode2();
      return;
    }

    const line = lines[currentLineIdx];
    const wordsArr = line.text.split(/\s+/).filter(Boolean);
    if (wordsArr.length === 0) { currentLineIdx++; renderCurrentLine(); return; }

    // Pick a "content" word if possible
    const contentIdxs = wordsArr.map((w, i) => i).filter(i => wordsArr[i].replace(/[^a-zA-Z]/g, '').length > 2);
    blankPos = contentIdxs.length > 0 ? contentIdxs[Math.floor(Math.random() * contentIdxs.length)] : Math.floor(Math.random() * wordsArr.length);
    blankWord = wordsArr[blankPos];

    const pct = Math.round((currentLineIdx / lines.length) * 100);
    const lineHtml = wordsArr.map((w, i) => {
      if (i === blankPos) return `<span class="mode2-blank"><input id="mode2-input" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" placeholder="___" style="width:${Math.max(80, blankWord.length * 14)}px" /></span>`;
      return `<span>${escHtml(w)}</span>`;
    }).join(' ');

    const html = `
      ${practiceHeader(text, 'Fill In')}
      <div class="practice-progress-bar">
        <div class="practice-progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="practice-screen">
        <div class="mode2-content">
          <div class="mode2-line-counter">${currentLineIdx + 1} / ${lines.length}</div>
          <div class="mode2-line-display">${lineHtml}</div>
          <div class="mode2-feedback" id="mode2-feedback"></div>
          <button class="mode2-submit-btn" onclick="mode2Check()">Check</button>
        </div>
      </div>
    `;
    setScreen(html);

    const input = $('#mode2-input');
    if (input) {
      input.focus();
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') mode2Check();
      });
    }
  }

  function finishMode2() {
    // Update SM2 for all practiced lines
    updateLinesSM2(lines, 3);
    api('POST', 'recordPractice', { textId: text.id, linesPracticed: lines.length }).catch(() => {});
    navigate(`#complete/${text.id}`);
  }

  window.mode2Check = () => {
    const input = $('#mode2-input');
    if (!input) return;
    const answer = input.value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const correct = blankWord.toLowerCase().replace(/[^a-z0-9]/g, '');
    const feedback = $('#mode2-feedback');

    if (answer === correct) {
      input.classList.add('correct');
      if (feedback) { feedback.textContent = 'Correct!'; feedback.className = 'mode2-feedback correct'; }
      answeredLines.push(lines[currentLineIdx]);
      setTimeout(() => {
        currentLineIdx++;
        renderCurrentLine();
      }, 700);
    } else {
      input.classList.add('wrong');
      if (feedback) { feedback.textContent = `"${blankWord}" — try again`; feedback.className = 'mode2-feedback wrong'; }
      setTimeout(() => {
        input.classList.remove('wrong');
        input.value = '';
        if (feedback) { feedback.textContent = ''; feedback.className = 'mode2-feedback'; }
        input.focus();
      }, 1200);
    }
  };

  renderCurrentLine();
}

// ============================================================
// MODE 3 — FIRST LETTER
// ============================================================

function renderMode3(text) {
  const lines = text.lines.filter(l => l.text.trim());
  if (lines.length === 0) {
    setScreen('<div class="no-results">No lines to practice.</div>');
    return;
  }

  let currentIdx = 0;
  let revealedCount = 0;

  function getFirstLetterDisplay(lineText, revealed = []) {
    return lineText.split(/\s+/).filter(Boolean).map((word, i) => {
      if (revealed.includes(i)) {
        return `<span class="mode3-word-token revealed">${escHtml(word)}</span>`;
      }
      const clean = word.replace(/[^a-zA-Z0-9]/g, '');
      const first = clean[0] || word[0];
      const rest = '_'.repeat(Math.max(0, clean.length - 1));
      return `<span class="mode3-word-token">${escHtml(first + rest)}</span>`;
    }).join(' ');
  }

  let revealedWords = [];

  function renderLine() {
    if (currentIdx >= lines.length) {
      updateLinesSM2(lines, 3);
      api('POST', 'recordPractice', { textId: text.id, linesPracticed: lines.length }).catch(() => {});
      navigate(`#complete/${text.id}`);
      return;
    }

    const line = lines[currentIdx];
    revealedWords = [];
    const pct = Math.round((currentIdx / lines.length) * 100);

    const html = `
      ${practiceHeader(text, 'First Letter')}
      <div class="practice-progress-bar">
        <div class="practice-progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="practice-screen">
        <div class="mode3-content">
          <div class="mode3-line-counter">${currentIdx + 1} / ${lines.length}</div>
          <div class="mode3-display" id="mode3-display">
            ${getFirstLetterDisplay(line.text, [])}
          </div>
          <div class="mode3-input-area">
            <input id="mode3-input" class="mode3-input" type="text"
              placeholder="Type the full line…" autocomplete="off" autocorrect="off" autocapitalize="off" />
            <div class="mode3-feedback" id="mode3-feedback"></div>
            <div class="mode3-btn-row">
              <button class="mode3-hint-btn" onclick="mode3Hint()">Hint</button>
              <button class="mode3-check-btn" onclick="mode3Check()">Check</button>
            </div>
          </div>
        </div>
      </div>
    `;
    setScreen(html);

    $('#mode3-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') mode3Check();
    });
  }

  window.mode3Hint = () => {
    const line = lines[currentIdx];
    const wordArr = line.text.split(/\s+/).filter(Boolean);
    const unrevealed = wordArr.map((_, i) => i).filter(i => !revealedWords.includes(i));
    if (unrevealed.length === 0) { showToast('All words revealed'); return; }
    const toReveal = unrevealed[0];
    revealedWords.push(toReveal);
    const display = $('#mode3-display');
    if (display) display.innerHTML = getFirstLetterDisplay(line.text, revealedWords);
  };

  window.mode3Check = () => {
    const input = $('#mode3-input');
    const feedback = $('#mode3-feedback');
    if (!input) return;

    const answer = input.value.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const correct = lines[currentIdx].text.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '');

    // Fuzzy check: 85% word match
    const aWords = answer.split(/\s+/).filter(Boolean);
    const cWords = correct.split(/\s+/).filter(Boolean);
    const matchCount = aWords.filter((w, i) => w === (cWords[i] || '')).length;
    const matchPct = cWords.length > 0 ? matchCount / cWords.length : 0;

    if (matchPct >= 0.85) {
      if (feedback) { feedback.textContent = 'Well done!'; feedback.className = 'mode3-feedback correct'; }
      setTimeout(() => { currentIdx++; renderLine(); }, 700);
    } else {
      if (feedback) { feedback.textContent = 'Not quite — use the Hint button'; feedback.className = 'mode3-feedback wrong'; }
      input.style.borderColor = 'var(--red)';
      setTimeout(() => { if (input) input.style.borderColor = ''; }, 1000);
    }
  };

  renderLine();
}

// ============================================================
// MODE 4 — MEANING RECALL (enhanced with pronunciation)
// ============================================================

function renderMode4(text) {
  // Include lines with translation OR pronunciation (or both)
  const lines = text.lines.filter(l => {
    if (!l.text.trim()) return false;
    const hasTrans = l.translation && l.translation.trim();
    const hasPron = l.pronunciation && l.pronunciation.trim();
    return hasTrans || hasPron;
  });

  if (lines.length === 0) {
    const html = `
      ${practiceHeader(text, 'Meaning')}
      <div class="practice-screen">
        <div class="mode4-content">
          <div class="mode4-no-translations">
            No translations or pronunciations found.<br><br>
            Add translations or pronunciations to your lines in the text detail view to use this mode.
          </div>
          <button class="mode4-compare-btn" onclick="navigate('#text/${text.id}')">
            Add Translations
          </button>
        </div>
      </div>
    `;
    setScreen(html);
    return;
  }

  let currentIdx = 0;

  function renderLine() {
    if (currentIdx >= lines.length) {
      updateLinesSM2(lines, 3);
      api('POST', 'recordPractice', { textId: text.id, linesPracticed: lines.length }).catch(() => {});
      navigate(`#complete/${text.id}`);
      return;
    }

    const line = lines[currentIdx];
    const pct = Math.round((currentIdx / lines.length) * 100);
    const hasTrans = line.translation && line.translation.trim();
    const hasPron = line.pronunciation && line.pronunciation.trim();

    // Build the "prompt" display
    let promptHtml = '';
    if (hasTrans) {
      promptHtml += `<div class="mode4-meaning-display">${escHtml(line.translation)}</div>`;
    }
    if (hasPron) {
      promptHtml += `<div class="mode4-pronunciation-hint">${escHtml(line.pronunciation)}</div>`;
    }
    if (!hasTrans && hasPron) {
      // Only pronunciation: show it as the main prompt
      promptHtml = `<div class="mode4-meaning-display mode4-pron-only">${escHtml(line.pronunciation)}</div>`;
    }

    const html = `
      ${practiceHeader(text, 'Meaning')}
      <div class="practice-progress-bar">
        <div class="practice-progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="practice-screen">
        <div class="mode4-content">
          <div class="mode4-line-counter">${currentIdx + 1} / ${lines.length}</div>
          ${promptHtml}
          <textarea id="mode4-input" class="mode4-input" rows="2"
            placeholder="Type the original line from memory…" autocorrect="off" autocapitalize="off"></textarea>
          <button class="mode4-compare-btn" onclick="mode4Compare()">Compare</button>
          <div class="mode4-reveal" id="mode4-reveal">
            ${escHtml(line.text)}
          </div>
          <div class="mode4-grade-row" id="mode4-grades" style="display:none">
            <button class="mode4-grade-btn grade-forgot" onclick="mode4Grade(0)">Forgot</button>
            <button class="mode4-grade-btn grade-hard" onclick="mode4Grade(2)">Hard</button>
            <button class="mode4-grade-btn grade-good" onclick="mode4Grade(3)">Good</button>
            <button class="mode4-grade-btn grade-perfect" onclick="mode4Grade(5)">Perfect</button>
          </div>
        </div>
      </div>
    `;
    setScreen(html);

    $('#mode4-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); mode4Compare(); }
    });
  }

  window.mode4Compare = () => {
    const reveal = $('#mode4-reveal');
    const grades = $('#mode4-grades');
    if (reveal) reveal.classList.add('visible');
    if (grades) grades.style.display = 'flex';
    const compareBtn = $('.mode4-compare-btn');
    if (compareBtn) compareBtn.style.display = 'none';
  };

  window.mode4Grade = async (quality) => {
    const line = lines[currentIdx];
    const result = sm2(quality, line.repetitions || 0, line.interval || 0, line.easeFactor || 2.5);
    await api('PUT', 'updateLine', { id: line.id, ...result }).catch(() => {});
    currentIdx++;
    renderLine();
  };

  renderLine();
}

// ============================================================
// MODE 5 — FULL RECITATION
// ============================================================

function renderMode5(text) {
  let elapsed = 0;
  let timerInterval = null;
  let revealed = false;

  function formatTime(s) {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  }

  const fullTextHtml = text.lines.map((l, i) =>
    `<div style="margin-bottom:6px"><span style="color:var(--gold);opacity:0.4;font-size:12px;margin-right:8px">${i + 1}</span>${escHtml(l.text)}</div>`
  ).join('');

  const html = `
    ${practiceHeader(text, 'Recitation')}
    <div class="practice-screen">
      <div class="mode5-content">
        <div class="mode5-title-display">${escHtml(text.title)}</div>
        <div class="mode5-timer" id="mode5-timer">00:00</div>
        <button class="mode5-reveal-btn" id="mode5-reveal-btn" onclick="mode5Reveal()">
          Reveal Text
        </button>
        <div class="mode5-text-reveal" id="mode5-text-reveal">
          <div class="mode5-text-inner">${fullTextHtml}</div>
        </div>
        <div class="mode5-grade-section" id="mode5-grades">
          <div class="mode5-grade-label">How did you do?</div>
          <div class="mode5-grade-row">
            <button class="mode4-grade-btn grade-forgot" onclick="mode5Grade(0)">Forgot</button>
            <button class="mode4-grade-btn grade-hard" onclick="mode5Grade(2)">Hard</button>
            <button class="mode4-grade-btn grade-good" onclick="mode5Grade(3)">Good</button>
            <button class="mode4-grade-btn grade-perfect" onclick="mode5Grade(5)">Perfect</button>
          </div>
        </div>
      </div>
    </div>
  `;
  setScreen(html);

  // Start timer
  timerInterval = setInterval(() => {
    elapsed++;
    const timerEl = $('#mode5-timer');
    if (timerEl) timerEl.textContent = formatTime(elapsed);
  }, 1000);

  window.mode5Reveal = () => {
    if (revealed) return;
    revealed = true;
    clearInterval(timerInterval);
    const reveal = $('#mode5-text-reveal');
    const grades = $('#mode5-grades');
    const revealBtn = $('#mode5-reveal-btn');
    if (reveal) reveal.classList.add('open');
    if (grades) grades.classList.add('visible');
    if (revealBtn) revealBtn.style.display = 'none';
  };

  window.mode5Grade = async (quality) => {
    // Update all lines with this quality
    await updateLinesSM2(text.lines, quality);
    await api('POST', 'recordPractice', { textId: text.id, linesPracticed: text.lines.length }).catch(() => {});
    navigate(`#complete/${text.id}`);
  };
}

// ============================================================
// MODE 6 — PRONUNCIATION PRACTICE
// ============================================================

function renderMode6(text) {
  // Only lines with pronunciation
  const lines = text.lines.filter(l => l.text.trim() && l.pronunciation && l.pronunciation.trim());

  if (lines.length === 0) {
    const html = `
      ${practiceHeader(text, 'Pronounce')}
      <div class="practice-screen">
        <div class="mode6-content">
          <div class="mode4-no-translations">
            No pronunciations found.<br><br>
            Add pronunciations to your lines in the text detail view to use this mode.
          </div>
          <button class="mode4-compare-btn" onclick="navigate('#text/${text.id}')">
            Add Pronunciations
          </button>
        </div>
      </div>
    `;
    setScreen(html);
    return;
  }

  let currentIdx = 0;
  let graded = false;

  function renderLine() {
    if (currentIdx >= lines.length) {
      finishMode6();
      return;
    }

    graded = false;
    const line = lines[currentIdx];
    const pct = Math.round((currentIdx / lines.length) * 100);

    const html = `
      ${practiceHeader(text, 'Pronounce')}
      <div class="practice-progress-bar">
        <div class="practice-progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="practice-screen">
        <div class="mode6-content">
          <div class="mode6-line-counter">${currentIdx + 1} / ${lines.length}</div>
          <div class="mode6-original">${escHtml(line.text)}</div>
          <div class="mode6-pronunciation">${escHtml(line.pronunciation)}</div>
          ${line.translation ? `<div class="mode6-translation">${escHtml(line.translation)}</div>` : ''}
          <div class="mode6-instruction">Say it aloud, then grade yourself</div>
          <div class="mode6-grade-row" id="mode6-grades">
            <button class="mode4-grade-btn grade-forgot" onclick="mode6Grade(0)">Forgot</button>
            <button class="mode4-grade-btn grade-hard" onclick="mode6Grade(2)">Hard</button>
            <button class="mode4-grade-btn grade-good" onclick="mode6Grade(3)">Good</button>
            <button class="mode4-grade-btn grade-perfect" onclick="mode6Grade(5)">Perfect</button>
          </div>
        </div>
      </div>
    `;
    setScreen(html);
  }

  function finishMode6() {
    updateLinesSM2(lines, 3);
    api('POST', 'recordPractice', { textId: text.id, linesPracticed: lines.length }).catch(() => {});
    navigate(`#complete/${text.id}`);
  }

  window.mode6Grade = async (quality) => {
    if (graded) return;
    graded = true;
    const line = lines[currentIdx];
    const result = sm2(quality, line.repetitions || 0, line.interval || 0, line.easeFactor || 2.5);
    await api('PUT', 'updateLine', { id: line.id, ...result }).catch(() => {});
    currentIdx++;
    renderLine();
  };

  renderLine();
}

// ============================================================
// PROGRESS SCREEN
// ============================================================

async function renderProgress() {
  setScreen(loading());

  try {
    const stats = await api('GET', 'getStats');

    const total = stats.totalLines || 0;
    const mastered = stats.mastered || 0;
    const learning = stats.learning || 0;
    const newCount = stats.new || 0;

    // Donut chart segments
    const r = 50;
    const cx = 60, cy = 60;
    const circ = 2 * Math.PI * r;

    function getDonutPath(color, offset, length) {
      return `<circle cx="${cx}" cy="${cy}" r="${r}"
        fill="none" stroke="${color}" stroke-width="16"
        stroke-dasharray="${circ}"
        stroke-dashoffset="${offset}"
        stroke-linecap="butt"/>`;
    }

    const masteredLen = total > 0 ? (mastered / total) * circ : 0;
    const learningLen = total > 0 ? (learning / total) * circ : 0;
    const newLen = total > 0 ? (newCount / total) * circ : circ;

    // Stacked: each segment offset = sum of previous lengths
    const masteredOffset = 0;
    const learningOffset = circ - masteredLen;
    const newOffset = circ - masteredLen - learningLen;

    const donutSvg = `
      <svg class="donut-svg" viewBox="0 0 120 120">
        <!-- Background -->
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--bg-elevated)" stroke-width="16"/>
        ${total > 0 ? `
          ${getDonutPath('#c0392b', newOffset, newLen)}
          ${getDonutPath('#f39c12', learningOffset, learningLen)}
          ${getDonutPath('#27ae60', masteredOffset, masteredLen)}
        ` : ''}
      </svg>
    `;

    const streakHtml = stats.streak > 0 ? `🔥` : `○`;

    const html = `
      <div class="progress-screen">
        <div class="progress-header">
          <button class="back-btn" onclick="navigate('#home')">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          <div class="progress-title">Progress</div>
        </div>

        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-value">${stats.totalTexts || 0}</div>
            <div class="stat-label">Texts</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${stats.totalLines || 0}</div>
            <div class="stat-label">Total Lines</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${mastered}</div>
            <div class="stat-label">Lines Mastered</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">
              <span class="flame-icon">${streakHtml}</span>
              ${stats.streak || 0}
            </div>
            <div class="stat-label">Day Streak</div>
          </div>
        </div>

        <div class="gold-divider"></div>

        <div class="section-label">Mastery Breakdown</div>
        <div class="donut-wrap">
          ${donutSvg}
          <div class="donut-legend">
            <div class="donut-legend-item">
              <div class="donut-dot" style="background:#27ae60"></div>
              Mastered (${mastered})
            </div>
            <div class="donut-legend-item">
              <div class="donut-dot" style="background:#f39c12"></div>
              Learning (${learning})
            </div>
            <div class="donut-legend-item">
              <div class="donut-dot" style="background:#c0392b"></div>
              New (${newCount})
            </div>
          </div>
        </div>

        ${stats.textBreakdown && stats.textBreakdown.length > 0 ? `
          <div class="gold-divider"></div>
          <div class="section-label">By Text</div>
          <div class="breakdown-list">
            ${stats.textBreakdown.map(t => `
              <div class="breakdown-item">
                <div class="breakdown-title">${escHtml(t.title)}</div>
                <div class="breakdown-bar-wrap">
                  <div class="breakdown-bar">
                    <div class="breakdown-bar-fill" style="width:0%" data-target="${t.percent}%"></div>
                  </div>
                  <div class="breakdown-pct">${t.percent}%</div>
                </div>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;

    setScreen(html);

    // Animate breakdown bars
    requestAnimationFrame(() => {
      $$('.breakdown-bar-fill').forEach(bar => {
        const target = bar.dataset.target;
        requestAnimationFrame(() => { bar.style.width = target; });
      });
    });

  } catch (e) {
    setScreen(`<div class="no-results">Could not load progress. ${e.message}</div>`);
  }
}

// ============================================================
// GUIDE SCREEN
// ============================================================

function renderGuide() {
  const sections = [
    {
      title: 'Getting Started',
      icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 16 12 12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
      items: [
        'Open this app in your phone\'s browser — it works on any device.',
        '<strong>Save to Home Screen (iPhone):</strong> In Safari, tap the Share button (square with arrow), then "Add to Home Screen." It\'ll look and feel like a real app.',
        'Recite helps you memorize any text using proven spaced repetition. Paste your text, practice with 6 different modes, and the app tracks your progress automatically.',
        '<strong>Your data is stored locally</strong> in your browser\'s IndexedDB — no account needed, and it works offline.'
      ]
    },
    {
      title: 'Adding Your First Text',
      icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
      items: [
        'Tap the gold <strong>+</strong> button on the home screen.',
        'Enter a title for your text.',
        'Choose a category: Prayer, Speech, Song, Poem, Script, or Other.',
        'Paste or type your text — each line becomes a memorizable unit.',
        'Optionally expand "Add Pronunciations" to add phonetic guides per line.',
        'Preview your numbered lines, then tap <strong>Save Text</strong>.'
      ]
    },
    {
      title: 'The 6 Practice Modes',
      icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
      items: [
        '<strong>Progressive Hiding</strong> — See the full text, then tap "Hide More" to blank out words one by one. Try to recall them. Long-press to peek.',
        '<strong>Fill in the Blank</strong> — One line at a time with a missing word. Type it in — green flash means correct, red means try again.',
        '<strong>First Letter</strong> — Each word is shown as just its first letter. Reconstruct the full text from memory. Use "Hint" if you get stuck.',
        '<strong>Meaning Recall</strong> — See a translation or meaning (and pronunciation hint if available), then type the original line. Perfect for foreign language texts.',
        '<strong>Full Recitation</strong> — A blank screen with just the title and a timer. Recite from memory, tap "Reveal" to check, then grade yourself.',
        '<strong>Pronounce</strong> — See the original text and its phonetic pronunciation. Say it aloud, then self-grade: Forgot, Hard, Good, or Perfect.'
      ]
    },
    {
      title: 'How Spaced Repetition Works',
      icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
      items: [
        'Recite uses the <strong>SM-2 algorithm</strong> to schedule your reviews intelligently.',
        'Each line is tracked independently — lines you struggle with appear more often.',
        'Mastered lines space out over days and weeks, so you don\'t waste time on what you already know.',
        'The home screen shows how many lines are <strong>due each day</strong>.',
        'Practice daily for the best results — your streak is tracked on the Progress screen.'
      ]
    },
    {
      title: 'Tracking Your Progress',
      icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
      items: [
        'The home screen shows a <strong>mastery ring</strong> for each text — the gold fill represents your percentage of mastered lines.',
        'The <strong>Progress</strong> tab shows total texts, total lines, lines mastered, and your practice streak.',
        'Each line has a colored dot: <span style="color:#c0392b">Red</span> = new, <span style="color:#f39c12">Yellow</span> = learning, <span style="color:#27ae60">Green</span> = mastered.',
        'Aim to turn all your dots green.'
      ]
    },
    {
      title: 'Tips for Success',
      icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
      items: [
        'Start with short texts (5–10 lines) and work up.',
        'Practice daily, even if just for 5 minutes.',
        'Use <strong>Progressive Hiding</strong> first to get familiar, then switch to harder modes.',
        'Add pronunciations for foreign language texts to unlock <strong>Pronounce</strong> mode.',
        'Add translations for foreign language texts to unlock <strong>Meaning Recall</strong> mode.',
        '<strong>Full Recitation</strong> is the ultimate test — use it when you feel ready.',
        'Trust the spaced repetition schedule — it\'s scientifically optimized for long-term retention.'
      ]
    }
  ];

  const html = `
    <div class="guide-screen">
      <div class="guide-header">
        <span class="guide-title">Guide</span>
      </div>
      <div class="gold-divider"></div>
      <p class="guide-intro">Memorize anything — prayers, speeches, songs, poems, scripts. Here's how to get the most out of Recite.</p>
      ${sections.map(s => `
        <div class="guide-section">
          <div class="guide-section-header">
            <span class="guide-section-icon">${s.icon}</span>
            <span class="guide-section-title">${s.title}</span>
          </div>
          <ul class="guide-list">
            ${s.items.map(item => `<li class="guide-item">${item}</li>`).join('')}
          </ul>
        </div>
      `).join('')}
      <div class="guide-footer">
        <p>Built with care. Happy memorizing.</p>
      </div>
    </div>
  `;

  setScreen(html);
}

// ============================================================
// DAILY PRACTICE SCREEN
// ============================================================

async function renderDaily() {
  setScreen(loading());

  try {
    const data = await api('GET', 'getDueLines');
    const lines = data.lines || [];

    if (lines.length === 0) {
      setScreen(`
        <div class="daily-screen">
          <div class="daily-header">
            <button class="back-btn" onclick="navigate('#home')">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
            </button>
            <div class="daily-title">Daily Practice</div>
          </div>
          <div class="daily-empty">
            <div class="daily-empty-title">You're all caught up.</div>
            <div class="daily-empty-sub">All lines are reviewed for today. Come back tomorrow to keep your streak going.</div>
          </div>
        </div>
      `);
      return;
    }

    // Group by text
    const byText = {};
    lines.forEach(line => {
      if (!byText[line.textId]) byText[line.textId] = { title: line.textTitle, lines: [] };
      byText[line.textId].lines.push(line);
    });

    let groupsHtml = '';
    Object.entries(byText).forEach(([textId, group]) => {
      groupsHtml += `
        <div class="daily-group">
          <div class="daily-group-label">${escHtml(group.title)}</div>
          ${group.lines.map(line => `
            <div class="daily-line-card" onclick="navigate('#practice/${textId}/5')">
              <div class="mastery-dot ${line.masteryLevel}"></div>
              <div class="daily-line-text">${escHtml(line.text)}</div>
              <div class="daily-line-source">${escHtml(line.masteryLevel)}</div>
            </div>
          `).join('')}
        </div>
      `;
    });

    const html = `
      <div class="daily-screen">
        <div class="daily-header">
          <button class="back-btn" onclick="navigate('#home')">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          <div class="daily-title">Daily Practice</div>
        </div>
        <div class="section-label">${lines.length} lines due today</div>
        ${groupsHtml}
        <div style="padding: 16px 16px 8px;">
          <button class="begin-practice-btn" onclick="startDailySession(${JSON.stringify(Object.keys(byText)[0])})">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none"/>
            </svg>
            Start Session
          </button>
        </div>
      </div>
    `;

    setScreen(html);

    window.startDailySession = (firstTextId) => {
      navigate(`#practice/${firstTextId}/5`);
    };

  } catch (e) {
    setScreen(`<div class="no-results">Could not load daily practice. ${e.message}</div>`);
  }
}

// ============================================================
// COMPLETE SCREEN
// ============================================================

function renderComplete(textId) {
  const html = `
    <div class="complete-screen">
      <div class="complete-icon">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="8 12 11 15 16 9"/>
        </svg>
      </div>
      <div class="complete-title">Well done.</div>
      <div class="complete-sub">Practice session complete.<br>Your progress has been recorded.</div>
      <button class="complete-home-btn" onclick="navigate('#text/${textId}')">Continue</button>
      <button style="background:none;border:none;color:var(--cream-muted);font-family:var(--font-ui);font-size:13px;cursor:pointer;margin-top:4px;padding:8px;" onclick="navigate('#home')">Back to Library</button>
    </div>
  `;
  setScreen(html);
}

// ============================================================
// HELPERS
// ============================================================

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ============================================================
// INIT
// ============================================================

window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', async () => {
  await maybePreloadSevenLinePrayer();
  router();
});

// Handle back button correctly when hash is home
window.addEventListener('popstate', () => {
  const hash = getHash();
  if (hash === '#home' || hash === '' || hash === '#') {
    currentHash = '';
    renderHome();
  }
});
