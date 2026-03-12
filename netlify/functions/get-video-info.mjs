export async function handler(event) {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: corsHeaders(), body: '' };
    }

    try {
        const { url } = JSON.parse(event.body || '{}');
        if (!url) {
            return respond(400, { error: 'Missing url parameter' });
        }

        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
        const res = await fetch(oembedUrl);

        if (!res.ok) {
            return respond(404, { error: 'Video not found' });
        }

        const data = await res.json();
        return respond(200, {
            title: data.title,
            author: data.author_name,
            thumbnail: data.thumbnail_url,
        });
    } catch (err) {
        return respond(500, { error: err.message });
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
