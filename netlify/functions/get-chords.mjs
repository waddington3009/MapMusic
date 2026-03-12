export async function handler(event) {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: corsHeaders(), body: '' };
    }

    try {
        const { artist, title } = JSON.parse(event.body || '{}');
        if (!artist || !title) {
            return respond(400, { error: 'Missing artist or title' });
        }

        // Try CifraClub scraping with the exact title
        let chords = await tryCifraClub(artist, title);
        if (chords) {
            return respond(200, { chords, source: 'cifraclub' });
        }

        // Try simplified titles: remove parentheses, "+ medley", etc
        const variations = [
            title.replace(/\s*[\(\[].*?[\)\]]/g, '').trim(),
            title.replace(/\s*\+\s*.+$/, '').trim(),
            title.replace(/\s*[\(\[].*?[\)\]]/g, '').replace(/\s*\+\s*.+$/, '').trim(),
        ].filter((v, i, a) => v && v !== title && v.length > 2 && a.indexOf(v) === i);
        for (const v of variations) {
            chords = await tryCifraClub(artist, v);
            if (chords) {
                return respond(200, { chords, source: 'cifraclub' });
            }
        }

        return respond(404, { error: 'Chords not found' });
    } catch (err) {
        return respond(500, { error: err.message });
    }
}

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
    const suffixes = ['-ina', '-oficial', '-banda', '-grupo', '-cantor', '-worship', '-music'];
    for (const s of suffixes) {
        slugs.push(base + s);
    }
    return slugs;
}

async function fetchCifraPage(url) {
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
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
    const key = detectKeyFromText(allChords);
    const raw = cifraRaw.replace(/\u27E8([^\u27E9]*)\u27E9/g, '$1');

    return { lines: result, key, raw };
}

async function searchArtistPage(artistSlug, titleSlug) {
    const page = await fetchCifraPage(`https://www.cifraclub.com.br/${artistSlug}/`);
    if (!page) return null;

    const linkPattern = new RegExp(`href="/${artistSlug}/([^"]+)/"`, 'gi');
    const songSlugs = [];
    let m;
    while ((m = linkPattern.exec(page.html)) !== null) {
        songSlugs.push(m[1]);
    }

    const candidates = songSlugs.filter(s => {
        if (s === titleSlug) return true;
        const words = titleSlug.split('-').filter(w => w.length > 2);
        return words.length > 0 && words.every(w => s.includes(w));
    });

    if (candidates.length > 0) {
        return candidates.find(c => c === titleSlug) || candidates.sort((a, b) => a.length - b.length)[0];
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

function detectKeyFromText(text) {
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

function respond(status, body) {
    return {
        statusCode: status,
        headers: corsHeaders(),
        body: JSON.stringify(body),
    };
}

function corsHeaders() {
    return {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
}
