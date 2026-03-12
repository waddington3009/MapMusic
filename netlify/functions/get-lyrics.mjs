export async function handler(event) {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: corsHeaders(), body: '' };
    }

    try {
        const { artist, title } = JSON.parse(event.body || '{}');
        if (!artist || !title) {
            return respond(400, { error: 'Missing artist or title' });
        }

        const cleanArtist = artist.trim();
        const cleanTitle = title.trim();
        let lyrics;

        // 1) lrclib.net – free, reliable, has Brazilian music
        lyrics = await tryLrclib(cleanArtist, cleanTitle);
        if (lyrics) return respond(200, { lyrics, source: 'lrclib' });

        // 2) lrclib search (broader query)
        lyrics = await tryLrclibSearch(`${cleanArtist} ${cleanTitle}`);
        if (lyrics) return respond(200, { lyrics, source: 'lrclib-search' });

        // 3) lyrics.ovh
        lyrics = await tryLyricsOvh(cleanArtist, cleanTitle);
        if (lyrics) return respond(200, { lyrics, source: 'lyrics.ovh' });

        // 4) Simplified title
        const simpleTitle = cleanTitle
            .replace(/\s*[\(\[].*?[\)\]]/g, '')
            .replace(/\s*[-–].*$/, '')
            .trim();
        if (simpleTitle && simpleTitle !== cleanTitle) {
            lyrics = await tryLrclibSearch(`${cleanArtist} ${simpleTitle}`);
            if (lyrics) return respond(200, { lyrics, source: 'lrclib-search' });

            lyrics = await tryLyricsOvh(cleanArtist, simpleTitle);
            if (lyrics) return respond(200, { lyrics, source: 'lyrics.ovh' });
        }

        // 5) Try swapping artist/title
        lyrics = await tryLrclibSearch(`${cleanTitle} ${cleanArtist}`);
        if (lyrics) return respond(200, { lyrics, source: 'lrclib-search-swapped' });

        return respond(404, { error: 'Lyrics not found', tried: [cleanArtist, cleanTitle] });
    } catch (err) {
        return respond(500, { error: err.message });
    }
}

// lrclib.net – exact match by artist + track name
async function tryLrclib(artist, title) {
    try {
        const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
        const res = await fetch(url, {
            headers: { 'User-Agent': 'MapMusic/1.0' },
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.plainLyrics || null;
    } catch {
        return null;
    }
}

// lrclib.net – search query (more flexible matching)
async function tryLrclibSearch(query) {
    try {
        const url = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;
        const res = await fetch(url, {
            headers: { 'User-Agent': 'MapMusic/1.0' },
        });
        if (!res.ok) return null;
        const results = await res.json();
        if (Array.isArray(results) && results.length > 0) {
            // Return the first result with plainLyrics
            for (const r of results) {
                if (r.plainLyrics) return r.plainLyrics;
            }
        }
        return null;
    } catch {
        return null;
    }
}

async function tryLyricsOvh(artist, title) {
    try {
        const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        return data.lyrics || null;
    } catch {
        return null;
    }
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
