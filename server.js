const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
    let cleanUrl = req.url.split('?')[0];
    if (cleanUrl === '/' || cleanUrl === '') cleanUrl = '/index.html';
    
    // Decode URI path (handles spaces, special chars)
    let safePath;
    try {
        safePath = path.normalize(decodeURIComponent(cleanUrl)).replace(/^(\.\.[\/\\])+/, '');
    } catch (e) {
        res.writeHead(400);
        return res.end('Bad Request');
    }

    const filePath = path.join(__dirname, safePath);

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('404 Not Found: ' + safePath);
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*'
        });

        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
    });
});

server.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`  PRIME HD Game Server Running!`);
    console.log(`  URL: http://localhost:${PORT}`);
    console.log(`========================================\n`);
});

