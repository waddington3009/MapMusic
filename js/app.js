/* ================================================================
   Map Music – Main Application  (v2 – all fixes)
   ================================================================ */

// ────────────────────────────────────────────────────────────────
// CONSTANTS
// ────────────────────────────────────────────────────────────────
const NOTES_SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const NOTES_FLAT  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
const ALL_KEYS_MAJOR = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const ALL_KEYS_MINOR = ['Cm','C#m','Dm','D#m','Em','Fm','F#m','Gm','G#m','Am','A#m','Bm'];

// ────────────────────────────────────────────────────────────────
// STATE
// ────────────────────────────────────────────────────────────────
const state = {
    videoId: null,
    videoTitle: '',
    artist: '',
    songName: '',
    rawLyrics: '',
    mappedLyrics: [],
    cifraData: null,    // { lines: [{chords, lyrics}], key, raw }
    currentKey: 0,
    originalKey: 0,
    transpose: 0,
};

// ────────────────────────────────────────────────────────────────
// YOUTUBE HELPERS
// ────────────────────────────────────────────────────────────────
function extractVideoId(url) {
    if (!url) return null;
    const patterns = [
        /(?:youtube\.com\/watch\?.*v=)([A-Za-z0-9_-]{11})/,
        /(?:youtu\.be\/)([A-Za-z0-9_-]{11})/,
        /(?:youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/,
        /(?:youtube\.com\/v\/)([A-Za-z0-9_-]{11})/,
        /(?:youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/,
    ];
    for (const p of patterns) {
        const m = url.match(p);
        if (m) return m[1];
    }
    const raw = url.trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
    return null;
}

function embedPlayer(videoId) {
    const container = document.getElementById('youtubePlayer');
    // Direct iframe embed – avoids Error 153 from the JS API
    container.innerHTML = `<iframe
        src="https://www.youtube.com/embed/${encodeURIComponent(videoId)}?rel=0&modestbranding=1&autoplay=0"
        width="100%" height="100%"
        frameborder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen
        referrerpolicy="no-referrer-when-downgrade"
        style="position:absolute;inset:0;width:100%;height:100%;border:none;">
    </iframe>`;
}

// ────────────────────────────────────────────────────────────────
// TITLE PARSER  (handles Brazilian music title formats)
// ────────────────────────────────────────────────────────────────
function parseSongTitle(title, channel) {
    // Clean common suffixes/tags
    let clean = title
        .replace(/\s*[\(\[](official|music|lyric|lyrics|video|audio|clipe|oficial|hd|4k|visualizer|live|ao vivo|feat\.?[^\)\]]*|ft\.?[^\)\]]*|prod\.?[^\)\]]*|legendado|[a-z]* version)[^\)\]]*[\)\]]/gi, '')
        .replace(/\s*\|.*$/, '')
        .replace(/\s*#\w+/g, '')
        .replace(/\s*\+\s*medley\b.*/i, '')  // Strip "+ MEDLEY" and similar
        .trim();

    // Try separators: " - ", " – ", " — "
    const sepMatch = clean.match(/^(.+?)\s*[-–—]\s*(.+)$/);
    if (sepMatch) {
        return { artist: sepMatch[1].trim(), song: sepMatch[2].trim() };
    }

    // Try " • " or " · " (common in YouTube Music)
    const bulletMatch = clean.match(/^(.+?)\s*[•·]\s*(.+)$/);
    if (bulletMatch) {
        const part1 = bulletMatch[1].trim();
        const part2 = bulletMatch[2].trim();
        // YouTube Music format is usually "Song • Artist"
        if (channel && part2.toLowerCase() === channel.toLowerCase()) {
            return { artist: part2, song: part1 };
        }
        if (channel && part1.toLowerCase() === channel.toLowerCase()) {
            return { artist: part1, song: part2 };
        }
        return { artist: part2, song: part1 };
    }

    // Fallback: channel as artist
    const fallbackArtist = (channel || '')
        .replace(/\s*[-–]?\s*(oficial|official|music|topic|vevo)$/i, '')
        .trim();
    return { artist: fallbackArtist, song: clean };
}

// ────────────────────────────────────────────────────────────────
// API SERVICE
// ────────────────────────────────────────────────────────────────
async function apiPost(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function getVideoInfo(youtubeUrl) {
    // 1) Netlify function
    try {
        const data = await apiPost('/api/get-video-info', { url: youtubeUrl });
        if (data.title) return data;
    } catch (_) {}

    // 2) Direct oEmbed
    try {
        const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(youtubeUrl)}&format=json`);
        if (r.ok) {
            const d = await r.json();
            return { title: d.title, author: d.author_name, thumbnail: d.thumbnail_url };
        }
    } catch (_) {}

    // 3) noembed.com
    try {
        const r = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(youtubeUrl)}`);
        if (r.ok) {
            const d = await r.json();
            if (d.title) return { title: d.title, author: d.author_name || '', thumbnail: d.thumbnail_url || '' };
        }
    } catch (_) {}

    return null;
}

async function getLyrics(artist, title) {
    console.log(`[MapMusic] Buscando letra: "${artist}" - "${title}"`);

    // 1) Netlify function (tries Vagalume + lyrics.ovh server-side)
    try {
        const data = await apiPost('/api/get-lyrics', { artist, title });
        if (data.lyrics) {
            console.log(`[MapMusic] Letra encontrada via: ${data.source}`);
            return data.lyrics;
        }
    } catch (_) {}

    // 2) Direct lrclib.net (CORS-friendly, works from browser)
    try {
        const lrcUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(artist + ' ' + title)}`;
        const lr = await fetch(lrcUrl, { headers: { 'User-Agent': 'MapMusic/1.0' } });
        if (lr.ok) {
            const results = await lr.json();
            if (Array.isArray(results)) {
                for (const r of results) {
                    if (r.plainLyrics) return r.plainLyrics;
                }
            }
        }
    } catch (_) {}

    // 3) Direct lyrics.ovh as last resort
    try {
        const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
        const r = await fetch(url);
        if (r.ok) {
            const d = await r.json();
            if (d.lyrics) return d.lyrics;
        }
    } catch (_) {}

    return null;
}

async function getChords(artist, title) {
    if (!artist || !title || title.length < 2) return null;
    console.log(`[MapMusic] Buscando cifra: "${artist}" - "${title}"`);
    // Try Netlify/local function
    try {
        const data = await apiPost('/api/get-chords', { artist, title });
        if (data.chords) {
            console.log(`[MapMusic] Cifra encontrada via: ${data.source}`);
            return data.chords;
        }
    } catch (_) {}
    return null;
}

// Build multiple title variations to try for chord search
function buildTitleVariations(songName) {
    const variations = new Set();
    if (songName) variations.add(songName);
    // Remove parenthetical content: (Ao Vivo), [Live], etc.
    const noParen = songName.replace(/\s*[\(\[].*?[\)\]]/g, '').trim();
    if (noParen && noParen !== songName) variations.add(noParen);
    // Remove "+ anything" (e.g. "+ Medley", "+ Worship")
    const noPlus = songName.replace(/\s*\+\s*.+$/, '').trim();
    if (noPlus && noPlus !== songName) variations.add(noPlus);
    // Combine: remove both
    const both = noParen.replace(/\s*\+\s*.+$/, '').trim();
    if (both && both.length > 2 && !variations.has(both)) variations.add(both);
    // If title has "+", try each part separately
    if (songName.includes('+')) {
        const firstPart = songName.split('+')[0].trim();
        if (firstPart.length > 2) variations.add(firstPart);
    }
    return [...variations];
}

// ────────────────────────────────────────────────────────────────
// LYRICS ANALYSIS  (repetition mapping)
// ────────────────────────────────────────────────────────────────
function analyzeLyrics(raw) {
    if (!raw) return [];
    const text = raw.replace(/\r\n/g, '\n').trim();
    const sections = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);

    const normMap = new Map();
    sections.forEach(sec => {
        const norm = sec.toLowerCase().replace(/\s+/g, ' ');
        if (!normMap.has(norm)) normMap.set(norm, { text: sec, count: 0 });
        normMap.get(norm).count++;
    });

    const result = [];
    const seen = new Set();
    let verseNum = 1;
    sections.forEach(sec => {
        const norm = sec.toLowerCase().replace(/\s+/g, ' ');
        if (seen.has(norm)) return;
        seen.add(norm);
        const info = normMap.get(norm);
        let label;
        if (info.count >= 2) {
            label = 'Refrão';
        } else {
            label = `Verso ${verseNum}`;
            verseNum++;
        }
        result.push({ text: info.text, count: info.count, label });
    });
    return result;
}

// ────────────────────────────────────────────────────────────────
// CHORD TRANSPOSITION ENGINE
// ────────────────────────────────────────────────────────────────
function noteIndex(note) {
    let i = NOTES_SHARP.indexOf(note);
    if (i >= 0) return i;
    return NOTES_FLAT.indexOf(note);
}

function transposeChord(chord, semitones) {
    if (semitones === 0) return chord;
    return chord.replace(/([A-G][#b]?)/g, match => {
        let idx = noteIndex(match);
        if (idx < 0) return match;
        idx = ((idx + semitones) % 12 + 12) % 12;
        return match.includes('b') ? NOTES_FLAT[idx] : NOTES_SHARP[idx];
    });
}

function transposeText(text, semitones) {
    if (semitones === 0) return text;
    return text.replace(/\b([A-G][#b]?)(m(?:aj|in)?7?|maj7?|dim|aug|sus[24]?|add[29]?|7|9|11|13|6|°|4|M|\([^)]*\))*(\/[A-G][#b]?)?(?![#\w])/g,
        match => transposeChord(match, semitones)
    );
}

function keyName(idx, minor) {
    const n = ((idx % 12) + 12) % 12;
    return NOTES_SHARP[n] + (minor ? 'm' : '');
}

// ────────────────────────────────────────────────────────────────
// RENDER: LETRA TAB
// ────────────────────────────────────────────────────────────────
function renderLetra() {
    const el = document.getElementById('letraContent');
    if (!state.mappedLyrics.length) {
        el.innerHTML = `<div class="empty-state">
            <p>Letra não encontrada automaticamente.</p>
            <button class="btn-primary" onclick="openManualLyrics()">Inserir Letra Manualmente</button>
        </div>`;
        return;
    }
    let html = '';
    state.mappedLyrics.forEach(sec => {
        html += `<span class="section-label">${esc(sec.label)}</span>`;
        if (sec.count > 1) html += `<span class="repeat-badge">${sec.count}x</span>`;
        html += '\n' + esc(sec.text) + '\n\n';
    });
    el.innerHTML = html;
}

// ────────────────────────────────────────────────────────────────
// RENDER: CIFRA TAB
// ────────────────────────────────────────────────────────────────
function renderCifra() {
    const container = document.getElementById('cifraContent');

    // Case 1: We have cifra data from CifraClub
    if (state.cifraData && state.cifraData.lines && state.cifraData.lines.length > 0) {
        let html = '';
        const sectionPattern = /^\[([^\]]+)\]\s*$/;
        state.cifraData.lines.forEach((pair, i) => {
            if (!pair.chords && !pair.lyrics) {
                html += `<div class="line-pair" style="height:12px"></div>`;
                return;
            }
            // Section headers like "[Intro]", "[Primeira Parte]", "[Refrão]"
            const sectionMatch = !pair.chords && pair.lyrics && pair.lyrics.trim().match(sectionPattern);
            if (sectionMatch) {
                html += `<span class="section-divider">${esc(sectionMatch[1])}</span>`;
                return;
            }
            // Chord-only lines (e.g. "[Intro] C  G6  C  G6" — chords with section label)
            const chordSectionMatch = pair.chords && !pair.lyrics && pair.chords.trim().match(/^\[([^\]]+)\]\s+(.+)/);
            if (chordSectionMatch) {
                html += `<span class="section-divider">${esc(chordSectionMatch[1])}</span>`;
                html += `<div class="line-pair">`;
                html += `<div class="chord-line" contenteditable="true" data-line="${i}" spellcheck="false">${esc(chordSectionMatch[2])}</div>`;
                html += `<div class="lyric-line"></div>`;
                html += `</div>`;
                return;
            }
            html += `<div class="line-pair">`;
            if (pair.chords) {
                html += `<div class="chord-line" contenteditable="true" data-line="${i}" spellcheck="false">${esc(pair.chords)}</div>`;
            }
            html += `<div class="lyric-line">${esc(pair.lyrics || '')}</div>`;
            html += `</div>`;
        });
        container.innerHTML = html;

        // Detect key
        if (state.cifraData.key) {
            const NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
            const idx = NOTES.indexOf(state.cifraData.key);
            if (idx >= 0) {
                state.originalKey = idx;
                state.currentKey = idx;
                state.transpose = 0;
            }
        }
        updateCifraKeyDisplay();
        return;
    }

    // Case 2: No cifra data but we have lyrics — show with empty chord lines
    if (!state.rawLyrics) {
        container.innerHTML = `<div class="empty-state">
            <p>Insira a letra primeiro para adicionar acordes.</p>
            <button class="btn-primary" onclick="openManualLyrics()">Inserir Letra</button>
        </div>`;
        return;
    }

    const lines = state.rawLyrics.split('\n');
    let html = '';
    let inSection = false;
    let sectionIdx = 0;

    lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) {
            if (inSection) { inSection = false; sectionIdx++; }
            html += `<div class="line-pair" style="height:12px"></div>`;
            return;
        }
        if (!inSection) {
            const mapped = state.mappedLyrics[sectionIdx];
            if (mapped) {
                html += `<span class="section-divider">${esc(mapped.label)}${mapped.count > 1 ? ' (' + mapped.count + 'x)' : ''}</span>`;
            }
            inSection = true;
        }
        html += `<div class="line-pair">`;
        html += `<div class="chord-line" contenteditable="true" data-line="${i}" spellcheck="false"></div>`;
        html += `<div class="lyric-line">${esc(line)}</div>`;
        html += `</div>`;
    });

    container.innerHTML = html;
    updateCifraKeyDisplay();
}

function updateCifraKeyDisplay() {
    const k = keyName(state.currentKey, false);
    document.getElementById('cifraKeyDisplay').textContent = k;
    document.getElementById('currentKeyDisplay').textContent = k;
    document.getElementById('modalCurrentKey').textContent = k;
}

// ────────────────────────────────────────────────────────────────
// RENDER: CRIAR MAPA TAB
// ────────────────────────────────────────────────────────────────
function renderMapa() {
    const el = document.getElementById('mapaContent');
    if (!state.rawLyrics) {
        el.innerHTML = '<p style="color:var(--text-light)">Insira a letra primeiro para criar seu mapa.</p>';
        return;
    }
    let text = '';
    state.mappedLyrics.forEach(sec => {
        text += `[${sec.label}]${sec.count > 1 ? ' (' + sec.count + 'x)' : ''}\n`;
        text += sec.text + '\n\n';
    });
    el.innerText = text;
}

// ────────────────────────────────────────────────────────────────
// TAB MANAGEMENT
// ────────────────────────────────────────────────────────────────
function switchTab(name) {
    document.querySelectorAll('.tab-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(name + 'Panel').classList.add('active');
}

// ────────────────────────────────────────────────────────────────
// KEY / TRANSPOSE
// ────────────────────────────────────────────────────────────────
function shiftKey(delta) {
    state.transpose += delta;
    state.currentKey = ((state.originalKey + state.transpose) % 12 + 12) % 12;
    updateCifraKeyDisplay();
    let changed = 0;
    document.querySelectorAll('#cifraContent .chord-line').forEach(cl => {
        if (cl.textContent.trim()) {
            cl.textContent = transposeText(cl.textContent, delta);
            changed++;
        }
    });
    const k = keyName(state.currentKey, false);
    if (changed > 0) {
        showToast(`Tom alterado para ${k}`);
    } else {
        showToast(`Tom: ${k} (adicione acordes na aba Cifra para transpor)`);
    }
}

function openKeySelector() {
    document.getElementById('keySelectorModal').classList.add('active');
    buildKeyGrids();
}
function closeKeySelector() {
    document.getElementById('keySelectorModal').classList.remove('active');
}

function buildKeyGrids() {
    const majGrid = document.getElementById('majorKeysGrid');
    const minGrid = document.getElementById('minorKeysGrid');
    majGrid.innerHTML = '';
    minGrid.innerHTML = '';

    ALL_KEYS_MAJOR.forEach((k, i) => {
        const btn = document.createElement('button');
        btn.textContent = k;
        if (i === state.currentKey) btn.classList.add('active');
        btn.onclick = () => applyKeyChange(i);
        majGrid.appendChild(btn);
    });
    ALL_KEYS_MINOR.forEach((k, i) => {
        const btn = document.createElement('button');
        btn.textContent = k;
        btn.onclick = () => applyKeyChange(i);
        minGrid.appendChild(btn);
    });
}

function applyKeyChange(targetIndex) {
    const delta = targetIndex - state.currentKey;
    if (delta === 0) { closeKeySelector(); return; }
    state.transpose += delta;
    state.currentKey = targetIndex;
    updateCifraKeyDisplay();
    document.querySelectorAll('#cifraContent .chord-line').forEach(cl => {
        if (cl.textContent.trim()) {
            cl.textContent = transposeText(cl.textContent, delta);
        }
    });
    closeKeySelector();
    showToast(`Tom alterado para ${keyName(state.currentKey, false)}`);
}

// ────────────────────────────────────────────────────────────────
// MANUAL LYRICS
// ────────────────────────────────────────────────────────────────
function openManualLyrics() {
    document.getElementById('manualLyricsInput').value = state.rawLyrics || '';
    document.getElementById('manualLyricsModal').classList.add('active');
}
function closeManualLyrics() {
    document.getElementById('manualLyricsModal').classList.remove('active');
}
function applyManualLyrics() {
    const text = document.getElementById('manualLyricsInput').value.trim();
    if (!text) return;
    state.rawLyrics = text;
    state.mappedLyrics = analyzeLyrics(text);
    renderLetra();
    renderCifra();
    renderMapa();
    closeManualLyrics();
    showToast('Letra aplicada com sucesso!');
}

// ────────────────────────────────────────────────────────────────
// SECTION INSERT (Mapa)
// ────────────────────────────────────────────────────────────────
function insertSection(label) {
    const editor = document.getElementById('mapaContent');
    const sel = window.getSelection();
    if (sel.rangeCount) {
        const range = sel.getRangeAt(0);
        if (editor.contains(range.commonAncestorContainer)) {
            const tag = document.createElement('span');
            tag.className = 'section-tag';
            tag.setAttribute('contenteditable', 'false');
            tag.textContent = label;
            range.insertNode(tag);
            range.setStartAfter(tag);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            return;
        }
    }
    const tag = document.createElement('span');
    tag.className = 'section-tag';
    tag.setAttribute('contenteditable', 'false');
    tag.textContent = label;
    editor.appendChild(document.createElement('br'));
    editor.appendChild(tag);
    editor.appendChild(document.createElement('br'));
}

// ────────────────────────────────────────────────────────────────
// PDF EXPORT
// ────────────────────────────────────────────────────────────────
async function exportPDF(tabName) {
    let sourceEl;
    let title = `${state.artist} - ${state.songName}`;

    if (tabName === 'letra') {
        sourceEl = document.getElementById('letraContent');
        title += ' (Letra)';
    } else if (tabName === 'cifra') {
        sourceEl = document.getElementById('cifraContent');
        title += ' (Cifra)';
    } else {
        sourceEl = document.getElementById('mapaContent');
        title += ' (Mapa)';
    }

    showToast('Gerando PDF...');
    try {
        const clone = sourceEl.cloneNode(true);
        clone.className = 'pdf-clone';
        clone.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
        document.body.appendChild(clone);

        const canvas = await html2canvas(clone, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
        document.body.removeChild(clone);

        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF('p', 'mm', 'a4');
        const pageW = 210, pageH = 297, margin = 15;
        const imgW = pageW - 2 * margin;
        const imgH = (canvas.height * imgW) / canvas.width;

        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(14);
        pdf.text(title, margin, margin + 6);

        const startY = margin + 14;
        const usableH = pageH - startY - margin;

        if (imgH <= usableH) {
            pdf.addImage(canvas.toDataURL('image/png'), 'PNG', margin, startY, imgW, imgH);
        } else {
            const sourceUnitH = (usableH / imgW) * canvas.width;
            let srcY = 0, page = 0;
            while (srcY < canvas.height) {
                if (page > 0) pdf.addPage();
                const sliceH = Math.min(sourceUnitH, canvas.height - srcY);
                const sub = document.createElement('canvas');
                sub.width = canvas.width;
                sub.height = sliceH;
                sub.getContext('2d').drawImage(canvas, 0, srcY, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
                const subImgH = (sliceH * imgW) / canvas.width;
                pdf.addImage(sub.toDataURL('image/png'), 'PNG', margin, page === 0 ? startY : margin, imgW, subImgH);
                srcY += sliceH;
                page++;
            }
        }

        pdf.save(sanitizeFilename(title) + '.pdf');
        showToast('PDF exportado!');
    } catch (err) {
        console.error('PDF export error:', err);
        showToast('Erro ao gerar PDF', true);
    }
}

function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]/g, '').trim();
}

// ────────────────────────────────────────────────────────────────
// UI HELPERS
// ────────────────────────────────────────────────────────────────
function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}
function showLoading(show) {
    document.getElementById('loadingOverlay').classList.toggle('active', show);
}
function showResults(show) {
    document.getElementById('heroSection').style.display = show ? 'none' : '';
    document.getElementById('resultsSection').classList.toggle('active', show);
}
let toastTimer;
function showToast(msg, isError) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast active' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('active'), 3000);
}

// ────────────────────────────────────────────────────────────────
// MAIN SEARCH HANDLER
// ────────────────────────────────────────────────────────────────
async function handleSearch() {
    const url = document.getElementById('youtubeUrl').value.trim();
    await doSearch(url);
}
async function handleSearchMini() {
    const url = document.getElementById('youtubeUrlMini').value.trim();
    await doSearch(url);
}

async function doSearch(url) {
    const videoId = extractVideoId(url);
    if (!videoId) {
        showToast('Cole um link válido do YouTube', true);
        return;
    }

    showLoading(true);
    state.videoId = videoId;

    try {
        // 1) Embed player immediately (iframe, no API needed)
        embedPlayer(videoId);

        // 2) Get video info
        const fullUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const info = await getVideoInfo(fullUrl);

        let artist = '', songName = '';
        if (info && info.title) {
            const parsed = parseSongTitle(info.title, info.author || '');
            artist = parsed.artist;
            songName = parsed.song;
            state.videoTitle = info.title;
        } else {
            artist = '';
            songName = videoId;
        }
        state.artist = artist;
        state.songName = songName;

        document.getElementById('songArtist').textContent = artist || 'Artista';
        document.getElementById('songTitle').textContent = songName || 'Música';

        // 3) Fetch lyrics – try multiple query combinations
        let lyrics = null;
        if (artist && songName) {
            lyrics = await getLyrics(artist, songName);
        }
        if (!lyrics && artist && songName) {
            const simpleSong = songName.replace(/\s*[\(\[].*?[\)\]]/g, '').trim();
            if (simpleSong !== songName) {
                lyrics = await getLyrics(artist, simpleSong);
            }
        }
        if (!lyrics && info && info.author) {
            // Try with channel name as artist + first part of title
            const firstPart = (info.title || '').split(/[-–—•·|]/)[0].trim();
            if (firstPart) {
                lyrics = await getLyrics(info.author, firstPart);
            }
        }

        state.rawLyrics = lyrics || '';
        state.mappedLyrics = analyzeLyrics(state.rawLyrics);

        // 4) Fetch chords/cifra – try multiple strategies
        state.cifraData = null;
        const titleVariations = buildTitleVariations(songName);
        const artistVariations = [artist];
        // Also try channel name as alternative artist
        if (info && info.author) {
            const ch = info.author.replace(/\s*[-–]?\s*(oficial|official|music|topic|vevo|tour)$/i, '').trim();
            if (ch && ch.toLowerCase() !== artist.toLowerCase()) artistVariations.push(ch);
        }
        for (const art of artistVariations) {
            if (state.cifraData) break;
            for (const t of titleVariations) {
                if (state.cifraData) break;
                const chords = await getChords(art, t);
                if (chords) state.cifraData = chords;
            }
        }

        state.originalKey = 0;
        state.currentKey = 0;
        state.transpose = 0;

        renderLetra();
        renderCifra();
        renderMapa();
        updateCifraKeyDisplay();

        showLoading(false);
        showResults(true);
        switchTab('letra');

        if (!lyrics) {
            showToast('Letra não encontrada — insira manualmente', true);
        }
    } catch (err) {
        console.error('Search error:', err);
        showLoading(false);
        showToast('Erro ao buscar música. Tente novamente.', true);
    }
}

// ────────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('youtubeUrl').addEventListener('keydown', e => {
        if (e.key === 'Enter') handleSearch();
    });
    document.getElementById('youtubeUrlMini').addEventListener('keydown', e => {
        if (e.key === 'Enter') handleSearchMini();
    });
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', e => {
            if (e.target === overlay) overlay.classList.remove('active');
        });
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
        }
    });
});
