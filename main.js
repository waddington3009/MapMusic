/* ================================================================
   Map Music – Electron Main Process
   ================================================================ */
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1340,
        height: 850,
        minWidth: 800,
        minHeight: 600,
        icon: path.join(__dirname, 'Logo.png'),
        title: 'Map Music',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            webviewTag: true,
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    mainWindow.loadFile('index.html');

    // Remove menu bar
    mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
    // Allow webview to load YouTube
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const headers = { ...details.responseHeaders };
        // Remove restrictive headers that block webview functionality
        delete headers['x-frame-options'];
        delete headers['X-Frame-Options'];
        callback({ responseHeaders: headers });
    });

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// ────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────
function slugify(text) {
    return text
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function artistSlugs(artist) {
    const base = slugify(artist);
    const slugs = [base];
    const prefixes = ['ministerio-', 'projeto-', 'comunidade-', 'banda-', 'igreja-', 'pastor-'];
    for (const p of prefixes) {
        if (!base.startsWith(p)) slugs.push(p + base);
    }
    const suffixes = ['-ina', '-oficial', '-banda', '-grupo', '-cantor', '-worship', '-music'];
    for (const s of suffixes) {
        slugs.push(base + s);
    }
    return slugs;
}

async function fetchPage(url) {
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html',
            'Accept-Language': 'pt-BR,pt;q=0.9',
        },
        redirect: 'follow',
    });
    if (!res.ok) return null;
    return { html: await res.text(), finalUrl: res.url };
}

function parseCifraHtml(html) {
    const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (!preMatch) return null;

    let cifraRaw = preMatch[1];
    cifraRaw = cifraRaw.replace(/<span class="tablatura">[\s\S]*?<\/span>/g, '');
    cifraRaw = cifraRaw.replace(/<b>([^<]*)<\/b>/g, '\u27E8$1\u27E9');
    cifraRaw = cifraRaw.replace(/<[^>]+>/g, '');
    cifraRaw = cifraRaw
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');

    const lines = cifraRaw.split('\n');
    const result = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('\u27E8')) {
            const chordLine = line.replace(/\u27E8([^\u27E9]*)\u27E9/g, '$1').trimEnd();
            const nextLine = (i + 1 < lines.length && !lines[i + 1].includes('\u27E8'))
                ? lines[++i] : '';
            result.push({ chords: chordLine, lyrics: nextLine });
        } else if (line.trim() === '') {
            result.push({ chords: '', lyrics: '' });
        } else {
            result.push({ chords: '', lyrics: line });
        }
    }

    const allChords = result.map(r => r.chords).join(' ');
    const key = detectKey(allChords);
    const raw = cifraRaw.replace(/\u27E8([^\u27E9]*)\u27E9/g, '$1');

    return { lines: result, key, raw };
}

function detectKey(text) {
    const counts = {};
    const re = /\b([A-G][#b]?)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        counts[m[1]] = (counts[m[1]] || 0) + 1;
    }
    let best = 'C', max = 0;
    for (const [note, c] of Object.entries(counts)) {
        if (c > max) { max = c; best = note; }
    }
    return best;
}

function slugSimilarity(a, b) {
    const wa = a.split('-').filter(Boolean);
    const wb = b.split('-').filter(Boolean);
    if (wa.length === 0 || wb.length === 0) return 0;
    let matched = 0;
    for (const w of wa) {
        if (w.length <= 1) continue;
        if (wb.some(v => v.includes(w) || w.includes(v))) matched++;
    }
    return matched / Math.max(wa.filter(w => w.length > 1).length, 1);
}

async function searchArtistPage(artistSlug, titleSlug) {
    const page = await fetchPage(`https://www.cifraclub.com.br/${artistSlug}/`);
    if (!page) return null;

    const finalPath = new URL(page.finalUrl).pathname;
    if (finalPath === '/' || !finalPath.includes(artistSlug)) return null;

    const linkPattern = new RegExp(`href="/${artistSlug}/([^"]+)/"`, 'gi');
    const songSlugs = [];
    let m;
    while ((m = linkPattern.exec(page.html)) !== null) {
        const s = m[1];
        if (!s.includes('/')) songSlugs.push(s);
    }

    let bestSlug = null, bestScore = 0;
    for (const s of [...new Set(songSlugs)]) {
        if (s === titleSlug) return s;
        const score = slugSimilarity(titleSlug, s);
        if (score > bestScore) { bestScore = score; bestSlug = s; }
    }
    return bestScore >= 0.6 ? bestSlug : null;
}

async function tryCifraClub(artist, title) {
    try {
        const titleSlug = slugify(title);
        const slugVariations = artistSlugs(artist);

        // Phase 1: Direct URL
        for (const artistSlug of slugVariations) {
            const url = `https://www.cifraclub.com.br/${artistSlug}/${titleSlug}/`;
            const page = await fetchPage(url);
            if (!page) continue;
            const expectedPathStart = `/${artistSlug}/${titleSlug}`;
            const finalPath = new URL(page.finalUrl).pathname;
            if (finalPath.startsWith(expectedPathStart)) {
                const result = parseCifraHtml(page.html);
                if (result) return result;
            }
        }

        // Phase 2: Artist page search
        for (const artistSlug of slugVariations) {
            const foundSlug = await searchArtistPage(artistSlug, titleSlug);
            if (foundSlug) {
                const url = `https://www.cifraclub.com.br/${artistSlug}/${foundSlug}/`;
                const page = await fetchPage(url);
                if (page) {
                    const result = parseCifraHtml(page.html);
                    if (result) return result;
                }
            }
        }
        return null;
    } catch {
        return null;
    }
}

// ────────────────────────────────────────────────────────────────
// IPC HANDLERS
// ────────────────────────────────────────────────────────────────

// Video info via oEmbed
ipcMain.handle('get-video-info', async (_event, youtubeUrl) => {
    try {
        const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(youtubeUrl)}&format=json`;
        const r = await fetch(oembed);
        if (r.ok) {
            const d = await r.json();
            return { title: d.title, author: d.author_name, thumbnail: d.thumbnail_url };
        }
    } catch {}

    try {
        const r = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(youtubeUrl)}`);
        if (r.ok) {
            const d = await r.json();
            if (d.title) return { title: d.title, author: d.author_name || '', thumbnail: d.thumbnail_url || '' };
        }
    } catch {}

    return null;
});

// Lyrics
ipcMain.handle('get-lyrics', async (_event, artist, title) => {
    // lrclib.net
    try {
        const q = `${artist} ${title}`;
        const lr = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, {
            headers: { 'User-Agent': 'MapMusic/2.0' }
        });
        if (lr.ok) {
            const results = await lr.json();
            if (Array.isArray(results)) {
                for (const r of results) {
                    if (r.plainLyrics) return { lyrics: r.plainLyrics, source: 'lrclib' };
                }
            }
        }
    } catch {}

    // lyrics.ovh
    try {
        const r = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
        if (r.ok) {
            const d = await r.json();
            if (d.lyrics) return { lyrics: d.lyrics, source: 'lyrics.ovh' };
        }
    } catch {}

    return null;
});

// Chords
ipcMain.handle('get-chords', async (_event, artist, title) => {
    if (!artist || !title || title.length < 2) return null;

    const chords = await tryCifraClub(artist, title);
    if (chords) return chords;

    // Try simplified titles
    const variations = [
        title.replace(/\s*[\(\[].*?[\)\]]/g, '').trim(),
        title.replace(/\s*\+\s*.+$/, '').trim(),
        title.replace(/\s*[\(\[].*?[\)\]]/g, '').replace(/\s*\+\s*.+$/, '').trim(),
    ].filter((v, i, a) => v && v !== title && v.length > 2 && a.indexOf(v) === i);

    for (const v of variations) {
        const c = await tryCifraClub(artist, v);
        if (c) return c;
    }

    return null;
});
