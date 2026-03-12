const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const ROOT = __dirname;

const MIME = {
    '.html': 'text/html',
    '.css':  'text/css',
    '.js':   'application/javascript',
    '.json': 'application/json',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
};

// Simple proxy for lyrics API (replaces Netlify functions locally)
async function handleAPI(req, res) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            return res.end();
        }

        try {
            const data = JSON.parse(body || '{}');

            if (req.url === '/api/get-video-info') {
                const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(data.url)}&format=json`;
                const r = await fetch(oembed);
                if (r.ok) {
                    const d = await r.json();
                    res.writeHead(200);
                    return res.end(JSON.stringify({ title: d.title, author: d.author_name, thumbnail: d.thumbnail_url }));
                }
                res.writeHead(404);
                return res.end(JSON.stringify({ error: 'Not found' }));
            }

            if (req.url === '/api/get-lyrics') {
                const { artist, title } = data;
                // Try lrclib search
                const q = `${artist} ${title}`;
                const lr = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, {
                    headers: { 'User-Agent': 'MapMusic/1.0' }
                });
                if (lr.ok) {
                    const results = await lr.json();
                    if (Array.isArray(results)) {
                        for (const r of results) {
                            if (r.plainLyrics) {
                                res.writeHead(200);
                                return res.end(JSON.stringify({ lyrics: r.plainLyrics, source: 'lrclib' }));
                            }
                        }
                    }
                }
                // Try lyrics.ovh
                const ovh = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
                if (ovh.ok) {
                    const d = await ovh.json();
                    if (d.lyrics) {
                        res.writeHead(200);
                        return res.end(JSON.stringify({ lyrics: d.lyrics, source: 'lyrics.ovh' }));
                    }
                }
                res.writeHead(404);
                return res.end(JSON.stringify({ error: 'Lyrics not found' }));
            }

            if (req.url === '/api/get-chords') {
                const { artist, title } = data;

                // Try CifraClub with original title
                const chords = await tryCifraClub(artist, title);
                if (chords) {
                    res.writeHead(200);
                    return res.end(JSON.stringify({ chords, source: 'cifraclub' }));
                }
                // Try simplified titles: remove parentheses, "+ medley", etc
                const variations = [
                    title.replace(/\s*[\(\[].*?[\)\]]/g, '').trim(),
                    title.replace(/\s*\+\s*.+$/, '').trim(),
                    title.replace(/\s*[\(\[].*?[\)\]]/g, '').replace(/\s*\+\s*.+$/, '').trim(),
                ].filter((v, i, a) => v && v !== title && v.length > 2 && a.indexOf(v) === i);
                for (const v of variations) {
                    const c = await tryCifraClub(artist, v);
                    if (c) {
                        res.writeHead(200);
                        return res.end(JSON.stringify({ chords: c, source: 'cifraclub' }));
                    }
                }
                res.writeHead(404);
                return res.end(JSON.stringify({ error: 'Chords not found' }));
            }

            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Unknown endpoint' }));
        } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
        }
    });
}

// ── CifraClub scraper ──
function slugify(text) {
    return text
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// Generate multiple slug variations for an artist name
function artistSlugs(artist) {
    const base = slugify(artist);
    const slugs = [base];
    // Common CifraClub suffixes for duplicate/disambiguation
    const suffixes = ['-ina', '-oficial', '-banda', '-grupo', '-cantor', '-worship', '-music'];
    for (const s of suffixes) {
        slugs.push(base + s);
    }
    return slugs;
}

// Fetch a CifraClub page and check if it's actually a song page (not a redirect to artist)
async function fetchCifraPage(url) {
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html',
            'Accept-Language': 'pt-BR,pt;q=0.9',
        },
        redirect: 'follow',
    });
    if (!res.ok) return null;
    const finalUrl = res.url;
    const html = await res.text();
    return { html, finalUrl };
}

// Parse chord data from CifraClub HTML
function parseCifraHtml(html) {
    const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (!preMatch) return null;

    let cifraRaw = preMatch[1];
    // Remove tablature sections (guitar tab notation)
    cifraRaw = cifraRaw.replace(/<span class="tablatura">[\s\S]*?<\/span>/g, '');
    // Mark chords: <b>CHORD</b> → ⟨CHORD⟩
    cifraRaw = cifraRaw.replace(/<b>([^<]*)<\/b>/g, '\u27E8$1\u27E9');
    // Remove remaining HTML tags
    cifraRaw = cifraRaw.replace(/<[^>]+>/g, '');
    // Decode HTML entities
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

// Search for a song on an artist's CifraClub page
async function searchArtistPage(artistSlug, titleSlug) {
    const page = await fetchCifraPage(`https://www.cifraclub.com.br/${artistSlug}/`);
    if (!page) return null;
    
    // Look for links to songs that fuzzy-match the title slug
    const linkPattern = new RegExp(`href="/${artistSlug}/([^"]+)/"`, 'gi');
    const songSlugs = [];
    let m;
    while ((m = linkPattern.exec(page.html)) !== null) {
        songSlugs.push(m[1]);
    }
    
    // Find best match for our title
    const candidates = songSlugs.filter(s => {
        // Exact match
        if (s === titleSlug) return true;
        // Contains all words
        const words = titleSlug.split('-').filter(w => w.length > 2);
        return words.length > 0 && words.every(w => s.includes(w));
    });
    
    if (candidates.length > 0) {
        // Return the best candidate (prefer exact, then shortest)
        const exact = candidates.find(c => c === titleSlug);
        return exact || candidates.sort((a, b) => a.length - b.length)[0];
    }
    return null;
}

async function tryCifraClub(artist, title) {
    try {
        const titleSlug = slugify(title);
        const slugVariations = artistSlugs(artist);

        // Phase 1: Try direct URL with each artist slug variation  
        for (const artistSlug of slugVariations) {
            const url = `https://www.cifraclub.com.br/${artistSlug}/${titleSlug}/`;
            const page = await fetchCifraPage(url);
            if (!page) continue;

            // Check if we stayed on the song page (didn't redirect to artist page)
            const expectedPathStart = `/${artistSlug}/${titleSlug}`;
            const finalPath = new URL(page.finalUrl).pathname;
            if (finalPath.startsWith(expectedPathStart)) {
                const result = parseCifraHtml(page.html);
                if (result) return result;
            }
        }

        // Phase 2: Search artist pages for the song link
        for (const artistSlug of slugVariations) {
            const foundSlug = await searchArtistPage(artistSlug, titleSlug);
            if (foundSlug && foundSlug !== titleSlug) {
                const url = `https://www.cifraclub.com.br/${artistSlug}/${foundSlug}/`;
                const page = await fetchCifraPage(url);
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

const server = http.createServer((req, res) => {
    // API routes
    if (req.url.startsWith('/api/')) {
        return handleAPI(req, res);
    }

    // Static files
    let filePath = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
    const fullPath = path.join(ROOT, filePath);

    // Security: prevent directory traversal
    if (!fullPath.startsWith(ROOT)) {
        res.writeHead(403);
        return res.end('Forbidden');
    }

    fs.readFile(fullPath, (err, data) => {
        if (err) {
            res.writeHead(404);
            return res.end('Not Found');
        }
        const ext = path.extname(fullPath).toLowerCase();
        res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
        res.writeHead(200);
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log(`\n  🎵 Map Music rodando em: http://localhost:${PORT}\n`);
});
